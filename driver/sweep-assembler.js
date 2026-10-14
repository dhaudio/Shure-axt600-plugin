// Scan pieces -> complete sweeps.
//
// The AXT600 scans with eight modules in parallel, so a pass over the range
// does not arrive in frequency order: each module reports its own block when it
// finishes it. The link hands over those pieces as "tiles":
//
//   { antenna: 0 | 1, startHz, stepHz, amplitudesDbm: number[] }
//
// and this turns them into what SoundBase wants: one array per antenna on the
// plan's frequency axis, emitted when every point of every antenna has been
// refreshed since the last emit. Values persist between passes, so a tile that
// arrives late never blanks part of the trace.

import { ANTENNAS, decimate } from './scan-plan.js';

export class SweepAssembler {
  /**
   * @param plan    from planScan()
   * @param onSweep (combinedDbm, [{ name, amplitudesDbm }]) on every complete pass
   */
  constructor(plan, onSweep) {
    this.plan = plan;
    this.onSweep = onSweep;
    this.values = ANTENNAS.map(() =>
      new Array(plan.deviceCount).fill(Number.NaN)
    );
    this.fresh = ANTENNAS.map(() => new Uint8Array(plan.deviceCount));
    this.missing = ANTENNAS.length * plan.deviceCount;
    this.passes = 0;
    /** tiles that did not land on this plan's axis, for diagnostics */
    this.misaligned = 0;
  }

  /** How much of the current pass has arrived, 0..1. */
  get progress() {
    const total = ANTENNAS.length * this.plan.deviceCount;
    return (total - this.missing) / total;
  }

  add(tile) {
    const { antenna, startHz, stepHz, amplitudesDbm } = tile;
    if (!this.values[antenna] || !Array.isArray(amplitudesDbm)) return;
    if (stepHz !== this.plan.stepHz) {
      this.misaligned += 1;
      return;
    }
    const offset = (startHz - this.plan.startHz) / stepHz;
    if (!Number.isInteger(offset)) {
      this.misaligned += 1;
      return;
    }

    const values = this.values[antenna];
    const fresh = this.fresh[antenna];
    for (let i = 0; i < amplitudesDbm.length; i += 1) {
      const index = offset + i;
      if (index < 0 || index >= values.length) continue;
      const v = amplitudesDbm[i];
      if (!Number.isFinite(v)) continue;
      values[index] = v;
      if (!fresh[index]) {
        fresh[index] = 1;
        this.missing -= 1;
      }
    }

    if (this.missing === 0) this.#emit();
  }

  #emit() {
    this.passes += 1;
    const curves = ANTENNAS.map((name, a) => ({
      name,
      amplitudesDbm: decimate(this.values[a], this.plan),
    }));
    const combined = curves[0].amplitudesDbm.map((_, i) =>
      Math.max(...curves.map((c) => c.amplitudesDbm[i]))
    );
    for (const f of this.fresh) f.fill(0);
    this.missing = ANTENNAS.length * this.plan.deviceCount;
    this.onSweep(combined, curves);
  }
}
