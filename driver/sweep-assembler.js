// Scan pieces -> complete sweeps.
//
// The AXT600 scans with eight modules in parallel, so a pass does not arrive
// in frequency order: each module reports its block as it goes, and each point
// arrives twice — once for the first antenna, then again as the stronger of
// the two. The link hands over pieces as tiles:
//
//   { startHz, stepHz, amplitudesDbm: number[] }
//
// and says when the pass is over. This keeps the latest value of every point
// and, at the end of each pass, emits one array on the plan's frequency axis.
//
// A point the unit never reported in a pass is filled with the lowest level
// seen in that pass, so the trace stays drawable without inventing a signal,
// and the gaps are reported so the user can be told.
//
// Progressive mode also emits during the pass, at most every `intervalMs`:
// the points refreshed so far in this pass, and the previous pass's values
// for the rest. A point not yet seen at all (only in the first pass) shows the
// lowest level seen so far. Those emits carry `complete: false`.

import { decimate } from './scan-plan.js';

export class SweepAssembler {
  /**
   * @param plan    from planScan()
   * @param onSweep (amplitudesDbm, { missing: [[fromHz, toHz], …] }) per pass
   */
  constructor(plan, onSweep, { progressive = false, intervalMs = 750 } = {}) {
    this.plan = plan;
    this.onSweep = onSweep;
    this.progressive = progressive;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.lastEmit = 0;
    this.values = new Array(plan.deviceCount).fill(Number.NaN);
    this.fresh = new Uint8Array(plan.deviceCount);
    this.passes = 0;
    /** tiles that did not land on this plan's axis, for diagnostics */
    this.misaligned = 0;
  }

  /** How much of the current pass has arrived, 0..1. */
  get progress() {
    let n = 0;
    for (const f of this.fresh) n += f;
    return n / this.plan.deviceCount;
  }

  add({ startHz, stepHz, amplitudesDbm }) {
    if (!Array.isArray(amplitudesDbm)) return;
    if (stepHz !== this.plan.stepHz) {
      this.misaligned += 1;
      return;
    }
    const offset = (startHz - this.plan.startHz) / stepHz;
    if (!Number.isInteger(offset)) {
      this.misaligned += 1;
      return;
    }
    for (let i = 0; i < amplitudesDbm.length; i += 1) {
      const index = offset + i;
      const v = amplitudesDbm[i];
      if (index < 0 || index >= this.values.length || !Number.isFinite(v)) continue;
      // implausible readings are dropped rather than drawn
      if (v < -200 || v > 50) continue;
      this.values[index] = v;
      this.fresh[index] = 1;
    }
    if (this.progressive) this.#schedule();
  }

  /** Stop any pending progressive emit (the scan stopped or was retuned). */
  dispose() {
    clearTimeout(this.timer);
    this.timer = null;
    this.progressive = false;
  }

  #schedule() {
    if (this.timer) return;
    const wait = Math.max(0, this.lastEmit + this.intervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#emitPartial();
    }, wait);
  }

  #emitPartial() {
    let floor = Infinity;
    for (const v of this.values) if (v < floor) floor = v;
    if (!Number.isFinite(floor)) return;
    const merged = this.values.map((v) => (Number.isNaN(v) ? floor : v));
    this.lastEmit = Date.now();
    this.onSweep(decimate(merged, this.plan), { missing: [], complete: false });
  }

  /** The pass is over: emit it, if anything at all arrived. */
  passEnd() {
    let floor = Infinity;
    for (let i = 0; i < this.values.length; i += 1) {
      if (this.fresh[i] && this.values[i] < floor) floor = this.values[i];
    }
    if (!Number.isFinite(floor)) return;

    const missing = [];
    const filled = this.values.map((v, i) => {
      if (this.fresh[i]) return v;
      const hz = this.plan.startHz + i * this.plan.stepHz;
      const last = missing[missing.length - 1];
      if (last && last[1] === hz - this.plan.stepHz) last[1] = hz;
      else missing.push([hz, hz]);
      return floor;
    });

    clearTimeout(this.timer);
    this.timer = null;
    this.passes += 1;
    this.fresh.fill(0);
    this.lastEmit = Date.now();
    this.onSweep(decimate(filled, this.plan), { missing, complete: true });
  }
}
