// What an AXT600 can be asked to scan, and what comes back.
//
// Everything here is pure arithmetic over the datasheet, so it can be tested
// on its own and moved when a real unit says otherwise. The figures:
//
//   - tuning range 470–952 MHz (the "global UHF" range of the AXT600)
//   - three step sizes: 25 kHz, 200 kHz and 1 MHz
//   - worst-case scan time per 60 MHz: 48 s, 7 s and 1 s respectively
//   - the whole range at 25 kHz in 64 s, with 8 scanning modules in parallel
//
// None of these have been measured by this plugin yet. docs/protocolo.md lists
// what to check on a real unit.

export const MIN_FREQUENCY_HZ = 470_000_000;
export const MAX_FREQUENCY_HZ = 952_000_000;

/** The scan steps the AXT600 offers. Reported to SoundBase as its RBW list. */
export const STEPS_HZ = [25_000, 200_000, 1_000_000];
export const DEFAULT_STEP_HZ = 200_000;

/** Frequencies sit on the 25 kHz channel plan Shure equipment tunes to. */
export const GRID_HZ = 25_000;

/** The two antenna inputs, as SoundBase will label their curves. */
export const ANTENNAS = ['A', 'B'];

/**
 * The most points a trace carries. A 25 kHz scan of the whole range is 19 281
 * points; past this the trace is coarsened by taking the peak of each group of
 * device points, so no carrier disappears between two trace points.
 */
export const MAX_TRACE_POINTS = 2_000;

const BLOCK_HZ = 60_000_000;
const SCAN_MS_PER_BLOCK = { 25_000: 48_000, 200_000: 7_000, 1_000_000: 1_000 };
const FULL_RANGE_MS = { 25_000: 64_000, 200_000: 9_400, 1_000_000: 1_400 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const onGrid = (hz) => Math.round(hz / GRID_HZ) * GRID_HZ;

/** The step closest to what was asked for. */
export function nearestStep(hz) {
  return STEPS_HZ.reduce((best, s) =>
    Math.abs(s - hz) < Math.abs(best - hz) ? s : best
  );
}

/**
 * The finest step whose scan of this span still fits in `pointCount` points —
 * how a request for a point count, with no RBW, picks a step.
 */
export function stepForPointCount(spanHz, pointCount) {
  const fitting = STEPS_HZ.filter((s) => Math.floor(spanHz / s) + 1 <= pointCount);
  return fitting.length ? fitting[0] : STEPS_HZ[STEPS_HZ.length - 1];
}

/**
 * Turn a request into a plan the device can carry out. Clamps, never throws.
 *
 *   request: { startHz?, stopHz?, rbwHz?, pointCount? }, any of them absent
 *   previous: the last plan, for fields the request leaves out
 *
 * Returns the device scan (start, step, deviceCount points) and the trace
 * SoundBase receives (start, stop, pointCount, decimation of device points).
 */
export function planScan(request = {}, previous = null) {
  const prevStart = previous?.startHz ?? 470_000_000;
  const prevStop = previous?.requestedStopHz ?? 616_000_000;

  let startHz = onGrid(
    clamp(
      isNum(request.startHz) ? request.startHz : prevStart,
      MIN_FREQUENCY_HZ,
      MAX_FREQUENCY_HZ - GRID_HZ
    )
  );
  let requestedStopHz = onGrid(
    clamp(
      isNum(request.stopHz) ? request.stopHz : prevStop,
      startHz + GRID_HZ,
      MAX_FREQUENCY_HZ
    )
  );
  const spanHz = requestedStopHz - startHz;

  // RBW chosen by the user wins; otherwise a point count picks the step;
  // otherwise whatever was in force; otherwise the device's middle step.
  let stepHz;
  let stepChosen = 'auto';
  if (isNum(request.rbwHz)) {
    stepHz = nearestStep(request.rbwHz);
    stepChosen = 'rbw';
  } else if (isNum(request.pointCount)) {
    stepHz = stepForPointCount(spanHz, request.pointCount);
  } else if (previous) {
    stepHz = previous.stepHz;
    stepChosen = previous.stepChosen;
  } else {
    stepHz = DEFAULT_STEP_HZ;
  }

  // the device sends one point per step from the start; the last one at or
  // below the requested stop
  const deviceCount = Math.max(2, Math.floor(spanHz / stepHz) + 1);
  const decimation = Math.max(1, Math.ceil(deviceCount / MAX_TRACE_POINTS));
  const pointCount = Math.max(2, Math.ceil(deviceCount / decimation));
  const traceStepHz = stepHz * decimation;
  const stopHz = startHz + (pointCount - 1) * traceStepHz;

  return {
    startHz,
    stopHz,
    requestedStopHz,
    stepHz,
    stepChosen,
    deviceCount,
    deviceStopHz: startHz + (deviceCount - 1) * stepHz,
    decimation,
    pointCount,
    sweepTimeMs: estimateScanMs(spanHz, stepHz),
  };
}

/**
 * How long one full pass should take, from the datasheet: 60 MHz blocks at the
 * step's worst-case time, but never more than the published full-range time,
 * which the eight scanning modules achieve by working in parallel. Errs long,
 * which is the safe direction: SoundBase waits a few of these before it calls
 * a quiet device stalled.
 */
export function estimateScanMs(spanHz, stepHz) {
  const perBlock = SCAN_MS_PER_BLOCK[stepHz] ?? SCAN_MS_PER_BLOCK[25_000];
  const full = FULL_RANGE_MS[stepHz] ?? FULL_RANGE_MS[25_000];
  const blocks = Math.max(1, Math.ceil(spanHz / BLOCK_HZ));
  return Math.min(blocks * perBlock, full);
}

/**
 * Device points -> trace points: the peak of each group of `decimation`
 * neighbours. With decimation 1 this is a copy of the first `pointCount`.
 */
export function decimate(values, plan) {
  const { decimation, pointCount } = plan;
  const out = new Array(pointCount);
  for (let i = 0; i < pointCount; i += 1) {
    let peak = -Infinity;
    const from = i * decimation;
    const to = Math.min(values.length, from + decimation);
    for (let j = from; j < to; j += 1) if (values[j] > peak) peak = values[j];
    out[i] = Number.isFinite(peak) ? peak : values[values.length - 1];
  }
  return out;
}
