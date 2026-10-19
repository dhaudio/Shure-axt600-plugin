// The knobs this plugin adds beside RBW and point count in SoundBase.
//
// SoundBase renders them from these descriptors and hands the values back in
// `cfg.controls`, merged by id, so the whole set arrives on every request.
// Every value is clamped to something usable rather than rejected, and the
// settled value is what gets echoed.

import { formatRanges, parseRanges } from './alerts.js';

export const CONTROLS = [
  {
    id: 'progressive',
    type: 'checkbox',
    label: 'Update during each pass',
    default: true,
    help:
      'Draw each part of the range as soon as the AXT600 reports it, instead of once a ' +
      'pass is complete — a pass takes about 7 s at 200 kHz and up to a minute at 25 kHz. ' +
      'Turn it off for an exact average trace: with it on, the average counts unchanged ' +
      'parts of the range more than once.',
  },
  {
    id: 'offsetDb',
    type: 'number',
    label: 'Level offset',
    unit: 'dB',
    default: 0,
    min: -40,
    max: 40,
    step: 0.5,
    help:
      'Added to every level the AXT600 reports. Positive to make up for cable, splitter ' +
      'or distribution loss before the unit; negative to take out antenna or amplifier gain.',
  },
  {
    id: 'alertEnabled',
    type: 'checkbox',
    label: 'Threshold alert',
    default: false,
    help: 'Warn when a signal rises above the alert level in the watched ranges.',
  },
  {
    id: 'alertThresholdDbm',
    type: 'number',
    label: 'Alert level',
    unit: 'dBm',
    default: -70,
    min: -120,
    max: 20,
    step: 1,
    help: 'A point above this level, after the offset, counts as a signal.',
  },
  {
    id: 'alertRanges',
    type: 'textinput',
    label: 'Watched ranges (MHz)',
    default: '',
    help:
      'Where to look, as MHz ranges separated by commas, e.g. "518-530, 606.5-614". ' +
      'Empty watches the whole scan.',
  },
  {
    id: 'alertPasses',
    type: 'number',
    label: 'Alert after passes',
    default: 2,
    min: 1,
    max: 20,
    step: 1,
    help:
      'Complete passes in a row a signal must be there before the alert is raised, so a ' +
      'single burst does not trigger it.',
  },
  {
    id: 'record',
    type: 'checkbox',
    label: 'Record passes to disk',
    default: false,
    help:
      'Save every complete pass: a history CSV with one row per pass, and a max-hold CSV ' +
      'that SoundBase can import as a scan. The folder is set in the plugin settings ' +
      '(default: Documents/SoundBase AXT600 recordings).',
  },
];

const DEFAULTS = Object.fromEntries(CONTROLS.map((c) => [c.id, c.default]));
const byId = Object.fromEntries(CONTROLS.map((c) => [c.id, c]));

const clampNumber = (v, c) => {
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const snapped = c.step ? Math.round(n / c.step) * c.step : n;
  return Math.min(c.max, Math.max(c.min, +snapped.toFixed(3)));
};
const asBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/**
 * Settle a request's controls against what was in force. Unknown ids are
 * ignored; null (SoundBase's "auto") and garbage keep the previous value.
 */
export function settleControls(raw = {}, previous = DEFAULTS) {
  const out = { ...DEFAULTS, ...previous };
  for (const [id, value] of Object.entries(raw ?? {})) {
    const c = byId[id];
    if (!c || value === undefined || value === null) continue;
    if (c.type === 'checkbox') out[id] = asBool(value);
    else if (c.type === 'number') {
      const n = clampNumber(value, c);
      if (n !== null) out[id] = n;
    } else if (id === 'alertRanges') {
      // echo the ranges as understood, so a typo shows up as missing
      out[id] = formatRanges(parseRanges(String(value)));
    } else out[id] = String(value);
  }
  return out;
}

export { DEFAULTS as CONTROL_DEFAULTS };
