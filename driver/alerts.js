// Threshold alerts over chosen ranges.
//
// The user names the ranges to watch ("518-530, 606.5-614") and a level. A
// point above the level in a watched range, on enough complete passes in a
// row, raises a warning naming the strongest offenders; it clears on the
// first pass where nothing in the ranges is above the level.
//
// Pure arithmetic over the trace SoundBase draws, so what the alert names is
// what the user sees.

/**
 * "518-530, 606.5 - 614" (MHz) -> [[518e6, 530e6], [606.5e6, 614e6]].
 * A point for decimals; commas or semicolons between ranges.
 */
export function parseRanges(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const part of text.split(/[,;]/)) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*$/i.exec(part);
    if (!m) continue;
    const a = Number(m[1]) * 1e6;
    const b = Number(m[2]) * 1e6;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    out.push([Math.min(a, b), Math.max(a, b)]);
  }
  return out;
}

/** The ranges as the user would write them, for the echo and the message. */
export function formatRanges(ranges) {
  return ranges.map(([a, b]) => `${+(a / 1e6).toFixed(3)}-${+(b / 1e6).toFixed(3)}`).join(', ');
}

export class ThresholdAlert {
  /**
   * @param thresholdDbm  level that counts as a signal
   * @param ranges        [[fromHz, toHz]]; empty watches the whole trace
   * @param passes        complete passes in a row before the alert is raised
   */
  constructor({ thresholdDbm, ranges = [], passes = 1 }) {
    this.thresholdDbm = thresholdDbm;
    this.ranges = ranges;
    this.passes = passes;
    this.streak = 0;
  }

  /**
   * One complete pass, on the trace's axis. Returns a SoundBase warning while
   * the alert stands, otherwise null.
   */
  check(amplitudes, { startHz, stepHz }) {
    const hits = [];
    for (let i = 0; i < amplitudes.length; i += 1) {
      const hz = startHz + i * stepHz;
      if (this.ranges.length && !this.ranges.some(([a, b]) => hz >= a && hz <= b)) continue;
      if (amplitudes[i] > this.thresholdDbm) hits.push([hz, amplitudes[i]]);
    }
    this.streak = hits.length ? this.streak + 1 : 0;
    if (this.streak < this.passes) return null;

    const strongest = hits
      .sort((x, y) => y[1] - x[1])
      .slice(0, 4)
      .map(([hz, v]) => `${(hz / 1e6).toFixed(3)} MHz (${v.toFixed(1)} dBm)`);
    const where = this.ranges.length ? `in ${formatRanges(this.ranges)} MHz` : 'in the scan';
    const how = this.passes > 1 ? ` for ${this.streak} passes in a row` : '';
    return {
      id: 'threshold-alert',
      severity: 'warning',
      message:
        `Signal above ${this.thresholdDbm} dBm ${where}${how}: ${strongest.join(', ')}` +
        (hits.length > 4 ? ` and ${hits.length - 4} more points` : '') +
        '.',
    };
  }
}
