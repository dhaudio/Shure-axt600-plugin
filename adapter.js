// Shure AXT600 Axient Spectrum Manager, as a SoundBase spectrum analyzer.
//
// The AXT600's scan becomes the live trace: at each frequency, the stronger of
// what its two antennas measured — which is what the unit itself reports.
//
// Everything about the wire lives behind a link (driver/link.js): the real
// one speaks ACN to the unit (driver/axt600-link.js); a simulator stands in
// for it when there is no unit.

import {
  cidFromDeviceId,
  createLink,
  deviceIdFor,
  SIMULATED_HOST,
  slpListener,
} from './driver/link.js';
import { cidFromString } from './driver/acn.js';
import {
  MAX_FREQUENCY_HZ,
  MIN_FREQUENCY_HZ,
  STEPS_HZ,
  planScan,
} from './driver/scan-plan.js';
import { SweepAssembler } from './driver/sweep-assembler.js';
import { CONTROLS, CONTROL_DEFAULTS, settleControls } from './driver/controls.js';
import { ThresholdAlert, parseRanges } from './driver/alerts.js';
import { PassRecorder } from './driver/recorder.js';

// MUST be a deviceTypeId declared in soundbase-plugin.json; a test checks it.
export const PRODUCT = 'plugin:shure-axt600/axt600';

export const SIMULATED_DEVICE_ID = 'sim:axt600';

/** A scan this slow gets an "it is filling in" notice until the first pass. */
const FILLING_NOTICE_MS = 5_000;

const MHZ = (hz) => (hz / 1e6).toFixed(3);
const logLine = (level, message) =>
  process.stdout.write(`[${new Date().toISOString()}] [${level}] ${message}\n`);

const envFlag = (name) => /^(1|true|yes)$/i.test(process.env[name] ?? '');
const simTimeScale = () => {
  const v = Number(process.env.SB_AXT600_SIM_TIMESCALE);
  return Number.isFinite(v) && v > 0 ? v : 1;
};

/**
 * Devices reachable right now: every AXT600 whose SLP advert has been heard on
 * this computer's networks, plus the simulated unit when the plugin setting
 * (or SB_AXT600_MOCK=1) asks for it. Listening sends nothing.
 */
export async function discoverDevices(pluginConfig = {}) {
  const slp = slpListener((m) => logLine('warn', m));
  await slp.start();
  const found = slp.devices().map((advert) => ({
    // the component id, not the address: a unit moved to another IP is still
    // the same device in the user's projects
    id: deviceIdFor(advert.cid),
    name: `${advert.uacn} (${advert.host})`,
    product: PRODUCT,
    transport: { kind: 'network', host: advert.host, port: advert.port },
  }));
  if (pluginConfig.simulate === true || envFlag('SB_AXT600_MOCK')) {
    found.push({
      id: SIMULATED_DEVICE_ID,
      name: 'Simulated AXT600',
      product: PRODUCT,
      transport: { kind: 'network', host: SIMULATED_HOST },
    });
  }
  return found;
}

export function createSpectrumAnalyzerAdapter(device, pluginConfig = {}) {
  return new Axt600Adapter(device, pluginConfig);
}

const round1 = (v) => Math.round(v * 10) / 10;

class Axt600Adapter {
  constructor(device, pluginConfig = {}) {
    this.device = device;
    this.pluginConfig = pluginConfig;
    this.controls = { ...CONTROL_DEFAULTS };
    this.alert = null;
    this.recorder = null;
    this.warningsById = new Map();
    this.unitName = 'AXT600';
    ({ host: this.host, cid: this.cid } = addressOf(device));
    this.link = null;
    this.plan = null;
    this.assembler = null;
    this.onTrace = null;
    this.sweeping = false;
    this.warnings = [];
    /** assigned by the shell */
    this.onFatal = null;
    this.onWarnings = null;
  }

  async open() {
    this.link = createLink(this.device, {
      host: this.host,
      cid: this.cid,
      timeScale: simTimeScale(),
      log: (m) => logLine('info', `[${this.device.id}] ${m}`),
    });
    this.link.onFatal = (err) => {
      this.sweeping = false;
      this.onFatal?.(err);
    };
    const identity = await this.link.connect();
    this.unitName = [identity.name ?? identity.model ?? 'AXT600', this.link.host]
      .filter((x) => x && x !== 'simulated')
      .join('-');

    return {
      capabilities: {
        minFrequencyHz: MIN_FREQUENCY_HZ,
        maxFrequencyHz: MAX_FREQUENCY_HZ,
        // the AXT600's three scan steps are its resolution
        rbwHz: [...STEPS_HZ],
        controls: CONTROLS.map((c) => ({ ...c })),
      },
      identity: {
        manufacturer: 'Shure',
        model: identity.model ?? 'AXT600',
        firmware: identity.firmware,
        ...(identity.name ? { name: identity.name } : {}),
      },
    };
  }

  /**
   * Clamp to what the AXT600 can do, retune if the scan changed, and echo what
   * is really in force. An RBW the user did not choose is reported under
   * `resolved`, beside the sweep time SoundBase should be patient for.
   */
  async applyConfig(cfg = {}) {
    // device controls: merged by the shell, so the whole set arrives each time
    const before = this.controls;
    this.controls = settleControls(cfg.controls, before);

    let plan = planScan(cfg, this.plan);
    const differs = (a, b) =>
      !a || !b || a.startHz !== b.startHz || a.stepHz !== b.stepHz || a.deviceCount !== b.deviceCount;

    // Only a different scan goes to the unit: writing it stops the unit's scan,
    // and a request that changes nothing it sweeps (a trace mode, a control)
    // must leave the scan running.
    if (differs(plan, this.plan)) {
      const settled = await this.link.configureScan({
        startHz: plan.startHz,
        stepHz: plan.stepHz,
        deviceCount: plan.deviceCount,
      });
      // if the unit settled on something else, the trace follows the unit
      if (settled.stepHz !== plan.stepHz || settled.startHz !== plan.startHz) {
        plan = planScan(
          { startHz: settled.startHz, stopHz: plan.requestedStopHz, rbwHz: settled.stepHz },
          plan
        );
      }
      this.plan = plan;
      if (this.sweeping) await this.#restartScan();
    } else {
      this.plan = plan;
      if (this.sweeping && this.assembler && before.progressive !== this.controls.progressive) {
        this.assembler.progressive = this.controls.progressive;
        if (!this.controls.progressive) this.assembler.dispose();
      }
      if (this.sweeping && before.record !== this.controls.record) this.#startRecorder();
    }
    this.#configureAlert(before);

    const effective = {
      startHz: plan.startHz,
      stopHz: plan.stopHz,
      pointCount: plan.pointCount,
      controls: { ...this.controls },
      resolved: { sweepTimeMs: plan.sweepTimeMs },
    };
    if (plan.stepChosen === 'rbw') effective.rbwHz = plan.stepHz;
    else effective.resolved.rbwHz = plan.stepHz;
    return effective;
  }

  async startSweep(onTrace) {
    if (this.sweeping) return;
    if (!this.plan) await this.applyConfig({});
    this.onTrace = onTrace;
    this.sweeping = true;
    await this.#beginScan();
  }

  async stopSweep() {
    this.sweeping = false;
    await this.link?.stopScan();
    this.assembler?.dispose();
    this.assembler = null;
    this.recorder = null;
    this.alert = this.alert && new ThresholdAlert(this.alert);
    this.warningsById.clear();
    this.#publishWarnings();
  }

  async close() {
    this.sweeping = false;
    this.assembler?.dispose();
    this.assembler = null;
    this.link?.close();
    this.link = null;
  }

  async #beginScan() {
    this.assembler?.dispose();
    const assembler = new SweepAssembler(
      this.plan,
      (raw, { missing, complete }) => {
        if (!this.sweeping || this.assembler !== assembler) return;
        const offset = this.controls.offsetDb;
        const amplitudes = offset ? raw.map((v) => round1(v + offset)) : raw;
        // until a first pass completes, the filling notice stays: parts of the
        // range not yet scanned show the lowest level seen so far
        if (complete) {
          this.#warn('scan-filling', null);
          this.#warn('scan-gaps', missing.length ? gapWarning(missing) : null);
          if (this.alert) this.#warn('threshold-alert', this.alert.check(amplitudes, this.#axis()));
          this.recorder?.record(amplitudes);
        }
        this.onTrace?.(amplitudes);
      },
      { progressive: this.controls.progressive }
    );
    this.assembler = assembler;
    this.#startRecorder();
    if (this.alert) this.alert = new ThresholdAlert(this.alert);

    if (this.plan.sweepTimeMs >= FILLING_NOTICE_MS) {
      const seconds = Math.round(this.plan.sweepTimeMs / 1000);
      this.#warn('scan-filling', {
        id: 'scan-filling',
        severity: 'info',
        message:
          `The AXT600 is scanning; at this range and resolution a full pass ` +
          `takes up to ${seconds} s. Until the first pass is complete, parts of the ` +
          `range not yet scanned show the noise floor. A coarser RBW or a narrower ` +
          `range is faster.`,
      });
    }

    await this.link.startScan(
      (tile) => assembler.add(tile),
      () => assembler.passEnd()
    );
  }

  async #restartScan() {
    await this.link.stopScan();
    await this.#beginScan();
  }

  /** The trace's frequency axis, after any coarsening of a long scan. */
  #axis() {
    const { startHz, stepHz, decimation, pointCount } = this.plan;
    return { startHz, stepHz: stepHz * decimation, pointCount };
  }

  #configureAlert(before) {
    const c = this.controls;
    if (!c.alertEnabled) {
      this.alert = null;
      if (before.alertEnabled) this.#warn('threshold-alert', null);
      return;
    }
    const changed =
      !this.alert ||
      before.alertThresholdDbm !== c.alertThresholdDbm ||
      before.alertRanges !== c.alertRanges ||
      before.alertPasses !== c.alertPasses;
    if (changed) {
      this.alert = new ThresholdAlert({
        thresholdDbm: c.alertThresholdDbm,
        ranges: parseRanges(c.alertRanges),
        passes: c.alertPasses,
      });
      this.#warn('threshold-alert', null);
    }
  }

  #startRecorder() {
    if (!this.controls.record || !this.plan) {
      this.recorder = null;
      return;
    }
    const step = this.plan.stepHz / 1000;
    this.recorder = new PassRecorder({
      folder: this.pluginConfig.recordFolder?.trim() || undefined,
      name: this.unitName,
      axis: this.#axis(),
      note: `step ${step} kHz, level offset ${this.controls.offsetDb} dB`,
      log: (m) => logLine('info', `[${this.device.id}] ${m}`),
    });
  }

  #warn(id, warning) {
    if (warning) this.warningsById.set(id, warning);
    else this.warningsById.delete(id);
    this.#publishWarnings();
  }

  #publishWarnings() {
    const warnings = [...this.warningsById.values()];
    const same =
      warnings.length === this.warnings.length &&
      warnings.every((w, i) => w.id === this.warnings[i].id && w.message === this.warnings[i].message);
    if (same) return;
    this.warnings = warnings;
    this.onWarnings?.(warnings);
  }
}

/** Points the unit did not report in its last pass, named for the user. */
function gapWarning(missing) {
  const ranges = missing.map(([a, b]) => (a === b ? `${MHZ(a)} MHz` : `${MHZ(a)}–${MHZ(b)} MHz`));
  const shown = ranges.slice(0, 3).join(', ') + (ranges.length > 3 ? ` and ${ranges.length - 3} more` : '');
  return {
    id: 'scan-gaps',
    severity: 'info',
    message:
      `The AXT600 did not report ${shown} in its last pass; the trace shows ` +
      `the noise floor there. Do not coordinate into those frequencies on this trace alone.`,
  };
}

/**
 * Who and where the unit is. A discovered unit is known by its component id
 * (`acn:<id>`) and found at whatever address it announces; one added by hand
 * comes with its address — `device.config.host`, filled in from the SoundBase
 * project — or an id that carries it (`net:<ip>`). Never from this machine.
 */
function addressOf(device) {
  const configured = device.config?.host;
  const host =
    typeof configured === 'string' && configured.trim()
      ? configured.trim()
      : (/^net:(.+)$/.exec(device.id ?? '')?.[1] ?? null);
  const cid = cidFromDeviceId(device.id) ?? cidFromString(device.config?.cid);
  if (/^sim:/.test(device.id ?? '')) return { host: SIMULATED_HOST, cid: null };
  if (!host && !cid) {
    throw new Error(
      `device ${device.id} has no address: set its IP address in the device settings`
    );
  }
  return { host, cid };
}
