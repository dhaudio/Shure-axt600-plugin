// Shure AXT600 Axient Spectrum Manager, as a SoundBase spectrum analyzer.
//
// The AXT600's scan becomes the live trace: at each frequency, the stronger of
// what its two antennas measured — which is what the unit itself reports.
//
// Everything about the wire lives behind a link (driver/link.js): the real
// one speaks ACN to the unit (driver/axt600-link.js); a simulator stands in
// for it when there is no unit.

import { createLink, SIMULATED_HOST, slpListener } from './driver/link.js';
import {
  MAX_FREQUENCY_HZ,
  MIN_FREQUENCY_HZ,
  STEPS_HZ,
  planScan,
} from './driver/scan-plan.js';
import { SweepAssembler } from './driver/sweep-assembler.js';

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
    id: `net:${advert.host}`,
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

export function createSpectrumAnalyzerAdapter(device) {
  return new Axt600Adapter(device);
}

class Axt600Adapter {
  constructor(device) {
    this.device = device;
    this.host = addressOf(device);
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
      timeScale: simTimeScale(),
      log: (m) => logLine('info', `[${this.device.id}] ${m}`),
    });
    this.link.onFatal = (err) => {
      this.sweeping = false;
      this.onFatal?.(err);
    };
    const identity = await this.link.connect();

    return {
      capabilities: {
        minFrequencyHz: MIN_FREQUENCY_HZ,
        maxFrequencyHz: MAX_FREQUENCY_HZ,
        // the AXT600's three scan steps are its resolution
        rbwHz: [...STEPS_HZ],
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
    let plan = planScan(cfg, this.plan);
    const settled = await this.link.configureScan({
      startHz: plan.startHz,
      stepHz: plan.stepHz,
      deviceCount: plan.deviceCount,
    });
    // if the unit settled on something else, the trace follows the unit
    if (settled.stepHz !== plan.stepHz || settled.startHz !== plan.startHz) {
      plan = planScan(
        {
          startHz: settled.startHz,
          stopHz: plan.requestedStopHz,
          rbwHz: settled.stepHz,
        },
        plan
      );
    }

    const changed =
      !this.plan ||
      plan.startHz !== this.plan.startHz ||
      plan.stepHz !== this.plan.stepHz ||
      plan.deviceCount !== this.plan.deviceCount;
    this.plan = plan;
    if (changed && this.sweeping) await this.#restartScan();

    const effective = {
      startHz: plan.startHz,
      stopHz: plan.stopHz,
      pointCount: plan.pointCount,
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
    this.assembler = null;
    this.#setWarnings([]);
  }

  async close() {
    this.sweeping = false;
    this.assembler = null;
    this.link?.close();
    this.link = null;
  }

  async #beginScan() {
    const assembler = new SweepAssembler(this.plan, (amplitudes, { missing }) => {
      if (!this.sweeping || this.assembler !== assembler) return;
      this.#setWarnings(missing.length ? [gapWarning(missing)] : []);
      this.onTrace?.(amplitudes);
    });
    this.assembler = assembler;

    if (this.plan.sweepTimeMs >= FILLING_NOTICE_MS) {
      const seconds = Math.round(this.plan.sweepTimeMs / 1000);
      this.#setWarnings([
        {
          id: 'scan-filling',
          severity: 'info',
          message:
            `The AXT600 is scanning; at this range and resolution a full pass ` +
            `takes up to ${seconds} s, and the trace appears when the pass is ` +
            `complete. A coarser RBW or a narrower range is faster.`,
        },
      ]);
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

  #setWarnings(warnings) {
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
 * Where the unit is. Addressing comes from the device the host asked for —
 * `device.config.host`, filled in from the SoundBase project — or from an id
 * that already carries it (`net:<ip>`). Never from this machine.
 */
function addressOf(device) {
  const host = device.config?.host;
  if (typeof host === 'string' && host.trim()) return host.trim();
  const match = /^net:(.+)$/.exec(device.id ?? '');
  if (match) return match[1];
  if (/^sim:/.test(device.id ?? '')) return SIMULATED_HOST;
  throw new Error(
    `device ${device.id} has no address: set its IP address in the device settings`
  );
}
