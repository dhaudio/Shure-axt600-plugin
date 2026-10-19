// Level offset, threshold alerts and recording: the pieces on their own, then
// through the adapter with the simulated unit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ThresholdAlert, formatRanges, parseRanges } from '../driver/alerts.js';
import { CONTROLS, settleControls } from '../driver/controls.js';
import { PassRecorder } from '../driver/recorder.js';
import { createSpectrumAnalyzerAdapter } from '../adapter.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.SB_AXT600_SIM_TIMESCALE = '0.002';

// ---------------------------------------------------------------------------
// ranges and alerts
// ---------------------------------------------------------------------------

test('watched ranges are read the way people type them', () => {
  // a point for decimals; commas or semicolons between ranges
  assert.deepEqual(parseRanges('518-530, 606.5 - 614; 700 to 690'), [
    [518e6, 530e6],
    [606.5e6, 614e6],
    [690e6, 700e6],
  ]);
  assert.deepEqual(parseRanges('nonsense, 500'), []);
  assert.equal(formatRanges(parseRanges('518-530,606.5-614')), '518-530, 606.5-614');
});

const axis = { startHz: 500e6, stepHz: 1e6 }; // 500, 501, 502 … MHz

test('an alert needs its passes in a row, names the strongest, and clears', () => {
  const alert = new ThresholdAlert({ thresholdDbm: -70, ranges: [[501e6, 503e6]], passes: 2 });
  const quiet = [-100, -100, -100, -100, -100];
  const busy = [-40, -65, -100, -55, -100]; // 500 MHz is outside the range
  assert.equal(alert.check(busy, axis), null, 'one pass is not enough');
  const w = alert.check(busy, axis);
  assert.equal(w.id, 'threshold-alert');
  assert.equal(w.severity, 'warning');
  assert.match(w.message, /above -70 dBm in 501-503 MHz for 2 passes/);
  assert.match(w.message, /503\.000 MHz \(-55\.0 dBm\), 501\.000 MHz \(-65\.0 dBm\)/);
  assert.doesNotMatch(w.message, /500\.000/);
  assert.equal(alert.check(quiet, axis), null, 'clears on the first quiet pass');
  assert.equal(alert.check(busy, axis), null, 'and needs two again');
});

test('no ranges watches the whole scan', () => {
  const alert = new ThresholdAlert({ thresholdDbm: -70, passes: 1 });
  assert.match(alert.check([-40, -100], axis).message, /in the scan: 500\.000 MHz/);
});

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

test('controls are declared with ids, and clamped rather than rejected', () => {
  const ids = CONTROLS.map((c) => c.id);
  for (const id of ['progressive', 'offsetDb', 'alertEnabled', 'alertThresholdDbm', 'alertRanges', 'alertPasses', 'record']) {
    assert.ok(ids.includes(id), id);
  }
  const s = settleControls({ offsetDb: 100, alertPasses: 0, alertThresholdDbm: '-63.4', alertRanges: '518 - 530 , junk' });
  assert.equal(s.offsetDb, 40);
  assert.equal(s.alertPasses, 1);
  assert.equal(s.alertThresholdDbm, -63);
  assert.equal(s.alertRanges, '518-530');
  assert.equal(s.progressive, true, 'defaults fill the rest');
  const kept = settleControls({ offsetDb: null, record: 'true' }, s);
  assert.equal(kept.offsetDb, 40, 'null keeps what was in force');
  assert.equal(kept.record, true);
});

// ---------------------------------------------------------------------------
// recorder
// ---------------------------------------------------------------------------

test('recording writes a history row per pass and a max-hold SoundBase can import', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'axt600-rec-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const rec = new PassRecorder({
    folder,
    name: 'FOH AXT600/192.168.3.3',
    axis: { startHz: 500e6, stepHz: 200e3, pointCount: 3 },
    note: 'step 200 kHz',
    now: () => new Date(2026, 9, 19, 13, 5, 9),
  });
  rec.record([-100, -50, -90.04]);
  rec.record([-99, -60, -80]);
  await rec.flush();

  const files = (await readdir(folder)).sort();
  assert.deepEqual(files, [
    'FOH-AXT600-192.168.3.3_2026-10-19_13-05-09_history.csv',
    'FOH-AXT600-192.168.3.3_2026-10-19_13-05-09_maxhold.csv',
  ]);
  const history = (await readFile(rec.historyPath, 'utf8')).trim().split('\n');
  assert.match(history[0], /^# AXT600 scan history — step 200 kHz/);
  assert.equal(history[1], 'time,500.0000,500.2000,500.4000');
  assert.match(history[2], /^2026-10-19T13:05:09[+-]\d\d:\d\d,-100,-50,-90$/);
  assert.equal(history.length, 4);
  const max = (await readFile(rec.maxPath, 'utf8')).trim().split('\n');
  assert.deepEqual(max, ['Frequency (MHz),Level (dBm)', '500.0000,-99', '500.2000,-50', '500.4000,-80']);
});

test('a recording that cannot write says so once and stops', async (t) => {
  // a folder "inside" an ordinary file cannot be created anywhere
  const dir = await mkdtemp(path.join(os.tmpdir(), 'axt600-rec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a-file');
  await writeFile(file, '');
  const lines = [];
  const rec = new PassRecorder({
    folder: path.join(file, 'recordings'),
    name: 'x',
    axis: { startHz: 500e6, stepHz: 1e6, pointCount: 1 },
    log: (l) => lines.push(l),
  });
  rec.record([-90]);
  rec.record([-90]);
  await rec.flush();
  assert.equal(lines.filter((l) => /recording stopped/.test(l)).length, 1);
});

// ---------------------------------------------------------------------------
// through the adapter, with the simulated unit
// ---------------------------------------------------------------------------

async function sweepWith(controls, until, pluginConfig = {}) {
  const adapter = createSpectrumAnalyzerAdapter({ id: 'sim:axt600' }, pluginConfig);
  const warnings = [];
  adapter.onWarnings = (w) => warnings.push(w);
  await adapter.open();
  const applied = await adapter.applyConfig({
    startHz: 470e6,
    stopHz: 616e6,
    rbwHz: 200e3,
    controls: { progressive: false, ...controls },
  });
  const traces = [];
  await adapter.startSweep((a) => traces.push(a));
  const deadline = Date.now() + 5_000;
  while (!until({ traces, warnings }) && Date.now() < deadline) await delay(10);
  return { adapter, applied, traces, warnings };
}

test('the level offset moves the whole trace', async () => {
  const plain = await sweepWith({}, ({ traces }) => traces.length >= 1);
  await plain.adapter.stopSweep();
  await plain.adapter.close();
  const shifted = await sweepWith({ offsetDb: 10 }, ({ traces }) => traces.length >= 1);
  await shifted.adapter.stopSweep();
  await shifted.adapter.close();
  assert.equal(shifted.applied.controls.offsetDb, 10);
  const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const lift = median(shifted.traces[0]) - median(plain.traces[0]);
  assert.ok(lift > 8 && lift < 12, `floor moved by ${lift} dB`);
});

test('the simulated carrier at 518.1 MHz raises the alert in its range only', async () => {
  const hit = await sweepWith(
    { alertEnabled: true, alertThresholdDbm: -60, alertRanges: '517-519', alertPasses: 1 },
    ({ warnings }) => warnings.at(-1)?.some((w) => w.id === 'threshold-alert')
  );
  const alert = hit.warnings.at(-1).find((w) => w.id === 'threshold-alert');
  assert.match(alert.message, /518\.\d{3} MHz/);

  // raising the level clears it without stopping the scan
  await hit.adapter.applyConfig({ controls: { alertThresholdDbm: 0 } });
  const before = hit.traces.length;
  while (hit.traces.length < before + 2) await delay(10);
  assert.ok(!hit.warnings.at(-1).some((w) => w.id === 'threshold-alert'));
  await hit.adapter.stopSweep();
  await hit.adapter.close();

  const elsewhere = await sweepWith(
    { alertEnabled: true, alertThresholdDbm: -60, alertRanges: '480-500', alertPasses: 1 },
    ({ traces }) => traces.length >= 3
  );
  assert.ok(!elsewhere.warnings.flat().some((w) => w.id === 'threshold-alert'));
  await elsewhere.adapter.stopSweep();
  await elsewhere.adapter.close();
});

test('turning recording on writes the passes to the plugin\'s folder', async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'axt600-rec-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const run = await sweepWith({ record: true }, ({ traces }) => traces.length >= 3, {
    recordFolder: folder,
  });
  await run.adapter.stopSweep();
  await run.adapter.close();
  await delay(50);
  const files = await readdir(folder);
  const history = files.find((f) => f.endsWith('_history.csv'));
  assert.ok(history, files.join(', '));
  const rows = (await readFile(path.join(folder, history), 'utf8')).trim().split('\n');
  assert.ok(rows.length >= 4, `${rows.length - 2} passes recorded`);
  assert.equal(rows[1].split(',').length, 1 + 731);
});
