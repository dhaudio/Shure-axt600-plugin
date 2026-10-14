// Shure AXT600 Axient Spectrum Manager, as a SoundBase spectrum analyzer.
//
// The AXT600's scan becomes the live trace: the strongest level either antenna
// saw at each frequency, with antennas A and B also drawn as their own curves.
//
// Everything about the wire lives behind a link (driver/link.js). Today there
// are two: a simulator, and the real network link, which stays empty until the
// unit's protocol has been captured (docs/protocolo.md). This file does not
// change when that happens.

import { createLink, SIMULATED_HOST } from './driver/link.js';
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

const envFlag = (name) => /^(1|true|yes)$/i.test(process.env[name] ?? '');
const simTimeScale = () => {
  const v = Number(process.env.SB_AXT600_SIM_TIMESCALE);
  return Number.isFinite(v) && v > 0 ? v : 1;
};

/**
 * Devices reachable right now.
 *
 * A real AXT600 is added by hand, by its IP address: how it announces itself
 * on the network is one of the things the protocol capture has to establish,
 * and until then this plugin does not listen for it. The simulated unit is
 * listed when the plugin setting (or SB_AXT600_MOCK=1) asks for it.
 */
export async function discoverDevices(pluginConfig = {}) {
  if (pluginConfig.simulate !== true && !envFlag('SB_AXT600_MOCK')) return [];
  return [
    {
      id: SIMULATED_DEVICE_ID,
      name: 'Simulated AXT600',
      product: PRODUCT,
      transport: { kind: 'network', host: SIMULATED_HOST },
    },
  ];
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
    const assembler = new SweepAssembler(this.plan, (combined, curves) => {
      if (!this.sweeping || this.assembler !== assembler) return;
      if (this.warnings.length) this.#setWarnings([]);
      this.onTrace?.(combined, curves);
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
            `takes up to ${seconds} s, and the trace appears when both antennas ` +
            `have covered the whole range. A coarser RBW or a narrower range is faster.`,
        },
      ]);
    }

    await this.link.startScan((tile) => assembler.add(tile));
  }

  async #restartScan() {
    await this.link.stopScan();
    await this.#beginScan();
  }

  #setWarnings(warnings) {
    this.warnings = warnings;
    this.onWarnings?.(warnings);
  }
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
