// The driver on its own: scan arithmetic, sweep assembly, the simulator, and
// the adapter's behaviour around them that the HTTP tests cannot reach.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decimate,
  estimateScanMs,
  MAX_TRACE_POINTS,
  planScan,
  stepForPointCount,
} from '../driver/scan-plan.js';
import { SweepAssembler } from '../driver/sweep-assembler.js';
import { SimulatedAxt600 } from '../driver/simulated-axt600.js';
import {
  Axt600NetworkLink,
  createLink,
  isSimulated,
  ProtocolPendingError,
} from '../driver/link.js';
import { createSpectrumAnalyzerAdapter } from '../adapter.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// scan plan
// ---------------------------------------------------------------------------

test('a plan sits on the 25 kHz grid and inside 470–952 MHz', () => {
  const plan = planScan({ startHz: 500_012_345, stopHz: 600_007_000, rbwHz: 200_000 });
  assert.equal(plan.startHz % 25_000, 0);
  assert.equal(plan.startHz, 500_000_000);
  assert.ok(plan.stopHz <= 600_000_000);

  const wide = planScan({ startHz: 100e6, stopHz: 3e9, rbwHz: 1e6 });
  assert.equal(wide.startHz, 470_000_000);
  assert.equal(wide.stopHz, 952_000_000);
  assert.equal(wide.pointCount, 483);
});

test('the trace stop is where the last point really is', () => {
  // 100.1 MHz at 200 kHz: 501 points, the last 100 kHz short of the request
  const plan = planScan({ startHz: 500e6, stopHz: 600.1e6, rbwHz: 200e3 });
  assert.equal(plan.pointCount, 501);
  assert.equal(plan.stopHz, 600e6);
});

test('a start at the very top still leaves a span', () => {
  const plan = planScan({ startHz: 960e6, stopHz: 970e6, rbwHz: 25e3 });
  assert.ok(plan.stopHz > plan.startHz);
  assert.ok(plan.stopHz <= 952e6);
});

test('fields left out keep what was in force', () => {
  const first = planScan({ startHz: 520e6, stopHz: 560e6, rbwHz: 25e3 });
  const next = planScan({ stopHz: 580e6 }, first);
  assert.equal(next.startHz, 520e6);
  assert.equal(next.stepHz, 25e3);
  assert.equal(next.stepChosen, 'rbw');
});

test('a point count picks the finest step that fits it', () => {
  assert.equal(stepForPointCount(146e6, 10_000), 25_000);
  assert.equal(stepForPointCount(146e6, 1_000), 200_000);
  assert.equal(stepForPointCount(146e6, 200), 1_000_000);
  assert.equal(stepForPointCount(146e6, 5), 1_000_000); // nothing fits: coarsest
});

test('a trace never exceeds the point cap', () => {
  const plan = planScan({ startHz: 470e6, stopHz: 952e6, rbwHz: 25e3 });
  assert.equal(plan.deviceCount, 19_281);
  assert.ok(plan.pointCount <= MAX_TRACE_POINTS);
  assert.equal(plan.stopHz, plan.startHz + (plan.pointCount - 1) * 250e3);
});

test('coarsening keeps the peak of each group, so no carrier is lost', () => {
  const plan = { decimation: 4, pointCount: 3 };
  const values = [-100, -100, -40, -100, -100, -99, -100, -100, -100, -70];
  assert.deepEqual(decimate(values, plan), [-40, -99, -70]);
});

test('scan time follows the datasheet and errs long', () => {
  assert.equal(estimateScanMs(60e6, 25e3), 48_000);
  assert.equal(estimateScanMs(146e6, 200e3), 9_400);
  assert.equal(estimateScanMs(20e6, 1e6), 1_000);
  assert.equal(estimateScanMs(482e6, 25e3), 64_000);
});

// ---------------------------------------------------------------------------
// sweep assembly
// ---------------------------------------------------------------------------

const smallPlan = () => planScan({ startHz: 500e6, stopHz: 501e6, rbwHz: 200e3 }); // 6 points
const tile = (antenna, from, values) => ({
  antenna,
  startHz: 500e6 + from * 200e3,
  stepHz: 200e3,
  amplitudesDbm: values,
});

test('a sweep is emitted only when both antennas have every point, in any order', () => {
  const sweeps = [];
  const asm = new SweepAssembler(smallPlan(), (c, curves) => sweeps.push({ c, curves }));
  asm.add(tile(1, 3, [-90, -91, -92]));
  asm.add(tile(0, 0, [-80, -81, -82]));
  asm.add(tile(0, 3, [-70, -71, -72]));
  assert.equal(sweeps.length, 0);
  assert.equal(asm.progress, 0.75);
  asm.add(tile(1, 0, [-85, -60, -95]));
  assert.equal(sweeps.length, 1);
  assert.deepEqual(sweeps[0].curves[0].amplitudesDbm, [-80, -81, -82, -70, -71, -72]);
  assert.deepEqual(sweeps[0].c, [-80, -60, -82, -70, -71, -72]);
});

test('every pass refreshes all points before the next sweep', () => {
  const sweeps = [];
  const asm = new SweepAssembler(smallPlan(), (c) => sweeps.push(c));
  const full = (v) => {
    asm.add(tile(0, 0, Array(6).fill(v)));
    asm.add(tile(1, 0, Array(6).fill(v)));
  };
  full(-90);
  asm.add(tile(0, 0, Array(6).fill(-50))); // half a pass: nothing yet
  assert.equal(sweeps.length, 1);
  asm.add(tile(1, 0, Array(6).fill(-95)));
  assert.equal(sweeps.length, 2);
  assert.deepEqual(sweeps[1], Array(6).fill(-50));
});

test('a tile off the plan axis is counted and ignored, never misplaced', () => {
  const asm = new SweepAssembler(smallPlan(), () => assert.fail('no sweep'));
  asm.add({ antenna: 0, startHz: 500e6 + 100e3, stepHz: 200e3, amplitudesDbm: [-1] });
  asm.add({ antenna: 0, startHz: 500e6, stepHz: 25e3, amplitudesDbm: [-1] });
  assert.equal(asm.misaligned, 2);
  assert.equal(asm.progress, 0);
});

// ---------------------------------------------------------------------------
// simulator
// ---------------------------------------------------------------------------

test('the simulator delivers complete passes on both antennas', async () => {
  const sim = new SimulatedAxt600({ timeScale: 0.002 });
  await sim.connect();
  const plan = planScan({ startHz: 470e6, stopHz: 616e6, rbwHz: 200e3 });
  await sim.configureScan(plan);
  const sweeps = [];
  const asm = new SweepAssembler(plan, (c, curves) => sweeps.push(curves));
  await sim.startScan((t) => asm.add(t));
  while (sweeps.length < 2) await delay(10);
  sim.close();
  assert.equal(asm.misaligned, 0);
  assert.deepEqual(sweeps[0].map((c) => c.name), ['A', 'B']);
  assert.notDeepEqual(sweeps[0][0].amplitudesDbm, sweeps[0][1].amplitudesDbm);
});

test('nothing arrives after the scan is stopped', async () => {
  const sim = new SimulatedAxt600({ timeScale: 0.002 });
  await sim.connect();
  await sim.configureScan(planScan({ rbwHz: 1e6 }));
  let tiles = 0;
  await sim.startScan(() => (tiles += 1));
  await sim.stopScan();
  const after = tiles;
  await delay(80);
  assert.equal(tiles, after);
  sim.close();
});

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

test('which link a device gets', () => {
  assert.ok(isSimulated({ id: 'sim:axt600' }));
  assert.ok(isSimulated({ id: 'net:x', config: { host: 'simulated' } }));
  assert.ok(!isSimulated({ id: 'net:10.0.0.5', config: { host: '10.0.0.5' } }));
  assert.ok(createLink({ id: 'sim:axt600' }) instanceof SimulatedAxt600);
  assert.ok(
    createLink({ id: 'net:10.0.0.5' }, { host: '10.0.0.5' }) instanceof Axt600NetworkLink
  );
});

test('the network link refuses plainly until the protocol exists', async () => {
  const link = new Axt600NetworkLink({ host: '10.0.0.5' });
  await assert.rejects(link.connect(), ProtocolPendingError);
  await assert.rejects(link.connect(), /10\.0\.0\.5/);
});

// ---------------------------------------------------------------------------
// adapter, below the shell
// ---------------------------------------------------------------------------

test('a slow scan shows a filling notice until its first sweep', async () => {
  process.env.SB_AXT600_SIM_TIMESCALE = '0.002';
  const adapter = createSpectrumAnalyzerAdapter({ id: 'sim:axt600' });
  const warnings = [];
  adapter.onWarnings = (w) => warnings.push(w);
  await adapter.open();
  await adapter.applyConfig({ startHz: 470e6, stopHz: 952e6, rbwHz: 25e3 });
  let traces = 0;
  await adapter.startSweep(() => (traces += 1));
  assert.equal(warnings.at(-1)[0].id, 'scan-filling');
  assert.match(warnings.at(-1)[0].message, /64 s/);
  while (traces < 1) await delay(10);
  assert.deepEqual(warnings.at(-1), []);
  await adapter.stopSweep();
  await adapter.close();
});

test('a dropped link is reported as fatal', async () => {
  process.env.SB_AXT600_SIM_TIMESCALE = '0.002';
  const adapter = createSpectrumAnalyzerAdapter({ id: 'sim:axt600' });
  const fatal = [];
  adapter.onFatal = (err) => fatal.push(err);
  await adapter.open();
  await adapter.applyConfig({ rbwHz: 1e6 });
  await adapter.startSweep(() => {});
  adapter.link.dropLink();
  assert.equal(fatal.length, 1);
  assert.match(fatal[0].message, /lost the connection/);
  await adapter.close();
});

test('a device with no address says so', () => {
  assert.throws(
    () => createSpectrumAnalyzerAdapter({ id: 'something' }),
    /no address/
  );
});
