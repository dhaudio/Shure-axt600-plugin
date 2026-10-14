// A pretend AXT600 that speaks the link interface (see driver/link.js).
//
// It exists for two reasons: the tests run everywhere with nothing plugged in,
// and the plugin can be loaded into SoundBase and looked at before the real
// protocol is known. It behaves the way the datasheet says the hardware does:
// two antennas, eight scanning modules finishing their blocks in no particular
// order, and a pass that takes as long as the real one would (scaled by
// `timeScale`, so tests need not wait a minute a sweep).

import { estimateScanMs, ANTENNAS } from './scan-plan.js';

const MODULES = 8;

// What the pretend venue is transmitting. Levels are dBm at antenna A; antenna
// B sees each a few dB differently, as two real antennas would.
const CARRIERS = [
  { hz: 518_100_000, dbm: -42, bDelta: -4 },
  { hz: 530_475_000, dbm: -48, bDelta: 3 },
  { hz: 554_025_000, dbm: -55, bDelta: -2 },
  { hz: 606_350_000, dbm: -38, bDelta: 1 },
  { hz: 662_775_000, dbm: -61, bDelta: 5 },
  { hz: 734_200_000, dbm: -58, bDelta: -6 },
];
// wideband occupants: a DVB-T multiplex and an LTE downlink
const BLOCKS = [
  { from: 586_000_000, to: 594_000_000, dbm: -72, bDelta: -3 },
  { from: 791_000_000, to: 821_000_000, dbm: -78, bDelta: 2 },
];

export function simulatedLevel(hz, antenna, stepHz) {
  const noise = -101 + (Math.random() * 2 - 1) * 1.5;
  let power = 10 ** (noise / 10);
  const width = Math.max(stepHz, 60_000);
  for (const c of CARRIERS) {
    const level = c.dbm + (antenna === 1 ? c.bDelta : 0);
    const shape = Math.exp(-(((hz - c.hz) / width) ** 2));
    power += 10 ** (level / 10) * shape;
  }
  for (const b of BLOCKS) {
    if (hz >= b.from && hz <= b.to) {
      const level = b.dbm + (antenna === 1 ? b.bDelta : 0) + Math.random() * 2;
      power += 10 ** (level / 10);
    }
  }
  return Math.round(10 * Math.log10(power) * 10) / 10;
}

export class SimulatedAxt600 {
  #timers = new Set();
  #scan = null;
  #running = false;
  #connected = false;

  constructor({ name = 'Simulated AXT600', timeScale = 1 } = {}) {
    this.name = name;
    this.timeScale = timeScale;
    /** assigned by the user of the link; called when the link dies unprompted */
    this.onFatal = null;
  }

  async connect() {
    this.#connected = true;
    return { model: 'AXT600', firmware: 'simulated', name: this.name };
  }

  /** Settles on what it was asked for: the plan already fits the hardware. */
  async configureScan({ startHz, stepHz, deviceCount }) {
    this.#assertConnected();
    this.#scan = { startHz, stepHz, deviceCount };
    return { ...this.#scan };
  }

  async startScan(onTile) {
    this.#assertConnected();
    if (!this.#scan) throw new Error('startScan before configureScan');
    this.#running = true;
    this.#pass(onTile);
  }

  #pass(onTile) {
    if (!this.#running) return;
    const { startHz, stepHz, deviceCount } = this.#scan;
    const passMs = Math.max(
      20,
      estimateScanMs((deviceCount - 1) * stepHz, stepHz) * this.timeScale
    );
    const perModule = Math.ceil(deviceCount / MODULES);

    for (let m = 0; m < MODULES; m += 1) {
      const from = m * perModule;
      const count = Math.min(perModule, deviceCount - from);
      if (count <= 0) continue;
      // each module finishes somewhere in the second half of the pass
      const at = passMs * (0.5 + Math.random() * 0.5);
      this.#after(at, () => {
        if (!this.#running) return;
        const tileStart = startHz + from * stepHz;
        ANTENNAS.forEach((_, antenna) => {
          const amplitudesDbm = new Array(count);
          for (let i = 0; i < count; i += 1) {
            amplitudesDbm[i] = simulatedLevel(
              tileStart + i * stepHz,
              antenna,
              stepHz
            );
          }
          onTile({ antenna, startHz: tileStart, stepHz, amplitudesDbm });
        });
      });
    }
    this.#after(passMs + 1, () => this.#pass(onTile));
  }

  async stopScan() {
    this.#running = false;
    this.#clearTimers();
  }

  close() {
    this.onFatal = null; // a close we asked for is not a failure
    this.#running = false;
    this.#connected = false;
    this.#clearTimers();
  }

  /** Test hook: the cable is pulled. */
  dropLink() {
    const fatal = this.onFatal;
    this.close();
    fatal?.(new Error(`lost the connection to ${this.name}`));
  }

  #assertConnected() {
    if (!this.#connected) throw new Error(`${this.name} is not connected`);
  }

  #after(ms, fn) {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      fn();
    }, ms);
    this.#timers.add(timer);
  }

  #clearTimers() {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
}
