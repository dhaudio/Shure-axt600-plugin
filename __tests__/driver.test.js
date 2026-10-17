// The driver on its own: scan arithmetic, sweep assembly, SLP, the SDT session
// against the fake unit, the simulator, and the adapter's behaviour around
// them that the HTTP tests cannot reach.

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
  cidFromDeviceId,
  createLink,
  deviceIdFor,
  isSimulated,
} from '../driver/link.js';
import { SdtSession, interfacesFacing } from '../driver/sdt-session.js';
import { SlpListener, buildAdvert, parseAdvert } from '../driver/slp.js';
import { startFakeAxt600 } from '../driver/fake-axt600.js';
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
const tile = (from, values) => ({ startHz: 500e6 + from * 200e3, stepHz: 200e3, amplitudesDbm: values });

test('a sweep is emitted at the end of a pass, with the latest value of each point', () => {
  const sweeps = [];
  const asm = new SweepAssembler(smallPlan(), (a, info) => sweeps.push({ a, info }));
  asm.add(tile(3, [-90, -91, -92]));
  asm.add(tile(0, [-80, -81, -82]));
  assert.equal(sweeps.length, 0, 'nothing before the pass ends');
  asm.add(tile(0, [-80, -60, -82])); // the second report: the stronger antenna
  asm.passEnd();
  assert.equal(sweeps.length, 1);
  assert.deepEqual(sweeps[0].a, [-80, -60, -82, -90, -91, -92]);
  assert.deepEqual(sweeps[0].info.missing, []);
});

test('points a pass never reported are filled with its floor and listed', () => {
  const sweeps = [];
  const asm = new SweepAssembler(smallPlan(), (a, info) => sweeps.push({ a, info }));
  asm.add(tile(0, [-80, -95, -82]));
  asm.add(tile(5, [-70]));
  asm.passEnd();
  assert.deepEqual(sweeps[0].a, [-80, -95, -82, -95, -95, -70]);
  assert.deepEqual(sweeps[0].info.missing, [[500.6e6, 500.8e6]]);
});

test('each pass starts afresh, and an empty pass emits nothing', () => {
  const sweeps = [];
  const asm = new SweepAssembler(smallPlan(), (a, info) => sweeps.push(info));
  asm.add(tile(0, Array(6).fill(-90)));
  asm.passEnd();
  asm.passEnd();
  assert.equal(sweeps.length, 1);
  asm.add(tile(0, [-90]));
  asm.passEnd();
  assert.equal(sweeps[1].missing.length, 1);
});

test('a tile off the plan axis, or a garbage reading, is never drawn', () => {
  const sweeps = [];
  const asm = new SweepAssembler(smallPlan(), (a) => sweeps.push(a));
  asm.add({ startHz: 500e6 + 100e3, stepHz: 200e3, amplitudesDbm: [-1] });
  asm.add({ startHz: 500e6, stepHz: 25e3, amplitudesDbm: [-1] });
  asm.add(tile(0, [3276.7, -90]));
  asm.passEnd();
  assert.equal(asm.misaligned, 2);
  assert.equal(sweeps[0][0], -90);
});

test('progressive mode draws each piece as it arrives, over the previous pass', async () => {
  const sweeps = [];
  const asm = new SweepAssembler(smallPlan(), (a, info) => sweeps.push({ a, info }), {
    progressive: true,
    intervalMs: 20,
  });
  asm.add(tile(0, Array(6).fill(-90)));
  asm.passEnd(); // a complete first pass
  assert.equal(sweeps.length, 1);
  assert.equal(sweeps[0].info.complete, true);

  asm.add(tile(0, [-40])); // a carrier appears at the start of the next pass
  await delay(40);
  assert.equal(sweeps.length, 2, 'drawn before the pass ends');
  assert.equal(sweeps[1].info.complete, false);
  assert.deepEqual(sweeps[1].a, [-40, -90, -90, -90, -90, -90]);

  asm.add(tile(1, [-91]));
  asm.add(tile(2, [-92])); // two pieces inside one interval: one emit
  await delay(40);
  assert.equal(sweeps.length, 3);
  asm.dispose();
});

test('a pass end replaces a pending progressive emit', async () => {
  const sweeps = [];
  const asm = new SweepAssembler(smallPlan(), (a, info) => sweeps.push(info), {
    progressive: true,
    intervalMs: 50,
  });
  asm.add(tile(0, Array(6).fill(-90)));
  asm.passEnd();
  await delay(80);
  assert.deepEqual(sweeps.map((i) => i.complete), [true]);
});

test('with progressive on, the adapter traces before the first pass completes', async () => {
  process.env.SB_AXT600_SIM_TIMESCALE = '0.05'; // a 9.4 s pass in ~470 ms
  const adapter = createSpectrumAnalyzerAdapter({ id: 'sim:axt600' });
  await adapter.open();
  const applied = await adapter.applyConfig({ startHz: 470e6, stopHz: 616e6, rbwHz: 200e3 });
  assert.equal(applied.controls.progressive, true);
  const at = [];
  const started = Date.now();
  await adapter.startSweep(() => at.push(Date.now() - started));
  while (at.length < 3) await delay(10);
  await adapter.stopSweep();
  await adapter.close();
  process.env.SB_AXT600_SIM_TIMESCALE = '0.002';
  assert.ok(at[0] < 400, `first trace after ${at[0]} ms, before the ~470 ms pass`);
});

test('turning progressive off traces only complete passes', async () => {
  process.env.SB_AXT600_SIM_TIMESCALE = '0.05';
  const adapter = createSpectrumAnalyzerAdapter({ id: 'sim:axt600' });
  await adapter.open();
  const applied = await adapter.applyConfig({
    startHz: 470e6,
    stopHz: 616e6,
    rbwHz: 200e3,
    controls: { progressive: false },
  });
  assert.equal(applied.controls.progressive, false);
  const at = [];
  const started = Date.now();
  await adapter.startSweep(() => at.push(Date.now() - started));
  while (at.length < 1) await delay(10);
  await adapter.stopSweep();
  await adapter.close();
  process.env.SB_AXT600_SIM_TIMESCALE = '0.002';
  assert.ok(at[0] >= 400, `first trace after ${at[0]} ms: a whole pass`);
});

// ---------------------------------------------------------------------------
// SLP
// ---------------------------------------------------------------------------

// the advert a unit on firmware 2.1.41 sends, from a capture
const REAL_ADVERT = Buffer.from(
  '\x02\x07\x00\x015\x00\x00\x00\x00\x00"=\x00\x02en\x00\x00\x01 (cid=A1B2C3D4-0000-11DD-A000-000EDDCCCCCC),' +
    '(acn-fctn=AXT600),(acn-uacn=AXT600),(acn-services=esta.dmp),' +
    '(csl-esta.dmp=esta.sdt/192.168.1.3:57383;esta.dmp/cd:CCC57006-E139-11DF-9451-0015C5F3F612),' +
    '(device-description=$:tftp://192.168.1.3/$.ddl),(csl-esta.dmp.values=version:1_interfaceId:48)\x00',
  'latin1'
);

test('a real AXT600 advert parses to its address, port and component id', () => {
  const advert = parseAdvert(REAL_ADVERT);
  assert.equal(advert.host, '192.168.1.3');
  assert.equal(advert.port, 57383);
  assert.equal(advert.fctn, 'AXT600');
  assert.equal(advert.cid.toString('hex'), 'a1b2c3d4000011dda000000eddcccccc');
  assert.equal(parseAdvert(Buffer.from('(acn-fctn=WWB6)')), null);
});

test('a unit is found by its component id at whatever address it announces', async () => {
  const dgram = await import('node:dgram');
  const port = await freePort();
  const slp = new SlpListener({ port, multicast: false });
  await slp.start();
  const tell = (host) =>
    new Promise((r) => {
      const s = dgram.createSocket('udp4');
      const ad = Buffer.from(REAL_ADVERT.toString('latin1').replaceAll('192.168.1.3', host), 'latin1');
      s.send(ad, port, '127.0.0.1', () => s.close(r));
    });
  const cid = parseAdvert(REAL_ADVERT).cid;
  await tell('192.168.1.3');
  await delay(20);
  assert.equal((await slp.advertForCid(cid, 100)).host, '192.168.1.3');
  await tell('192.168.3.3'); // the same unit, moved to another network
  await delay(20);
  assert.equal((await slp.advertForCid(cid, 100)).host, '192.168.3.3');
  assert.equal(slp.devices().length, 1, 'still one unit');
  assert.equal(await slp.advertForCid(Buffer.alloc(16), 50), null);
  slp.close();
});

test('device ids carry the component id and survive a round trip', () => {
  const cid = Buffer.from('a1b2c3d4000011dda000000eddcccccc', 'hex');
  assert.equal(deviceIdFor(cid), 'acn:a1b2c3d4000011dda000000eddcccccc');
  assert.ok(cidFromDeviceId(deviceIdFor(cid)).equals(cid));
  assert.equal(cidFromDeviceId('net:192.168.3.3'), null);
});

// ---------------------------------------------------------------------------
// the SDT session and the network link, against the fake unit
// ---------------------------------------------------------------------------

const freePort = async () => {
  const dgram = await import('node:dgram');
  const s = dgram.createSocket('udp4');
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
};

test('a session joins, reads, writes and leaves', async (t) => {
  const unit = await startFakeAxt600();
  t.after(() => unit.close());
  const session = new SdtSession({ host: unit.host, port: unit.port, deviceCid: unit.cid });
  await session.open();
  const values = await session.get([0x01000012, 0x01070220, 0x0badf00d]);
  assert.equal(values.get(0x01000012).subarray(2).toString(), 'AXT600');
  assert.equal(values.get(0x01070220).subarray(2).toString(), ';25;200;1000');
  assert.equal(values.get(0x0badf00d), null);
  await session.set([[0x01070102, Buffer.from([0, 0, 0, 200])]]);
  assert.equal(unit.scan.stepKhz, 200);
  await session.close();
  await delay(50);
  assert.equal(unit.state.left, true);
});

test('our advert has the layout of Wireless Workbench\'s, under our own identity', () => {
  const ad = buildAdvert({ cidText: '0A0B0C0D-0000-11DD-A000-000EDDCCCCCC', host: '192.168.1.69', port: 55540 });
  assert.equal(ad[0], 2); // SLPv2
  assert.equal(ad[1], 7); // attribute reply, as Shure equipment multicasts it
  assert.equal(ad.readUIntBE(2, 3), ad.length);
  assert.equal(ad.readUInt16BE(18), ad.length - 21); // attribute list length
  assert.equal(ad.at(-1), 0); // no auth blocks
  const text = ad.toString('latin1');
  assert.match(text, /\(acn-fctn=SoundBase\)/);
  assert.doesNotMatch(text, /WWB/);
  const parsed = parseAdvert(ad);
  assert.equal(parsed.host, '192.168.1.69');
  assert.equal(parsed.port, 55540);
});

test('the session announces itself before joining, and re-joins an unanswered JOIN', async (t) => {
  const unit = await startFakeAxt600({ ignoreJoins: 1 });
  t.after(() => unit.close());
  const announced = [];
  const session = new SdtSession({
    host: unit.host,
    port: unit.port,
    deviceCid: unit.cid,
    announce: async (a) => announced.push({ ...a, joinsSoFar: unit.state.joins }),
  });
  await session.open();
  assert.equal(unit.state.joins, 2);
  assert.equal(announced[0].joinsSoFar, 0, 'announced before the first JOIN');
  assert.ok(announced.length >= 2, 're-announced after the unanswered JOIN');
  assert.ok(announced[0].cid.equals(session.cid));
  assert.equal(announced[0].host, '127.0.0.1');
  await session.close();
});

test('interfaces in the unit\'s subnet are tried, wired before Wi-Fi', () => {
  // a Mac with Wi-Fi and a USB Ethernet adapter both in 192.168.1.x, as one was
  const interfaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    en0: [{ family: 'IPv4', address: '192.168.1.50', netmask: '255.255.255.0', internal: false }],
    en9: [{ family: 'IPv4', address: '192.168.1.69', netmask: '255.255.255.0', internal: false }],
    bridge100: [{ family: 'IPv4', address: '10.211.55.2', netmask: '255.255.255.0', internal: false }],
  };
  assert.deepEqual(interfacesFacing('192.168.1.3', interfaces), ['192.168.1.69', '192.168.1.50']);
  assert.deepEqual(interfacesFacing('172.16.0.9', interfaces), []);
});

// A second loopback address stands in for a second network interface. Linux
// answers on all of 127/8; macOS only on 127.0.0.1, so there these are skipped.
const canBind = async (address) => {
  const dgram = await import('node:dgram');
  const s = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      s.once('error', reject);
      s.bind(0, address, resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      s.close();
    } catch {
      // never bound
    }
  }
};
const secondLoopback = await canBind('127.0.0.2');

test('the session finds the interface the unit hears', { skip: !secondLoopback && 'no 127.0.0.2 on this system' }, async (t) => {
  const unit = await startFakeAxt600({ onlyFrom: '127.0.0.1' });
  t.after(() => unit.close());
  const lines = [];
  const session = new SdtSession({
    host: unit.host,
    port: unit.port,
    deviceCid: unit.cid,
    localAddresses: ['127.0.0.2', '127.0.0.1'],
    log: (l) => lines.push(l),
  });
  await session.open();
  assert.ok(lines.some((l) => /answered on the interface at 127\.0\.0\.1/.test(l)), lines.join('\n'));
  // (on Linux a bound source address picks the route; macOS needs the subnets apart)
  const values = await session.get([0x01000012]);
  assert.ok(values.get(0x01000012));
  await session.close();
});

test('no answer on any of two interfaces explains the shared subnet', { skip: !secondLoopback && 'no 127.0.0.2 on this system' }, async (t) => {
  const unit = await startFakeAxt600({ onlyFrom: '127.0.0.9' });
  t.after(() => unit.close());
  const session = new SdtSession({
    host: unit.host,
    port: unit.port,
    deviceCid: unit.cid,
    localAddresses: ['127.0.0.2', '127.0.0.1'],
  });
  await assert.rejects(session.open(), (err) => err.code === 'ambiguous_route' && /Wi-Fi/.test(err.message));
});

test('a refused join says why', async (t) => {
  const unit = await startFakeAxt600({ refuseJoin: true });
  t.after(() => unit.close());
  const session = new SdtSession({ host: unit.host, port: unit.port, deviceCid: unit.cid });
  await assert.rejects(session.open(), /refused the session.*Wireless Workbench/);
});

test('a unit that goes quiet is reported as lost', async (t) => {
  const unit = await startFakeAxt600();
  t.after(() => unit.close());
  const session = new SdtSession({ host: unit.host, port: unit.port, deviceCid: unit.cid });
  await session.open();
  const lost = new Promise((resolve) => (session.onFatal = resolve));
  unit.silence();
  const err = await lost;
  assert.match(err.message, /stopped answering/);
});

test('the link finds the unit by its advert and scans it', async (t) => {
  const slpPort = await freePort();
  const unit = await startFakeAxt600({ slpPort });
  const slp = new SlpListener({ port: slpPort, multicast: false });
  t.after(async () => {
    slp.close();
    await unit.close();
  });
  const link = new Axt600NetworkLink({ host: unit.host, slp });
  const identity = await link.connect();
  assert.deepEqual(identity, { model: 'AXT600', firmware: '2.1.41', name: 'AXT600' });

  const plan = planScan({ startHz: 470e6, stopHz: 616e6, rbwHz: 200e3 });
  await link.configureScan(plan);
  const sweeps = [];
  const asm = new SweepAssembler(plan, (a) => sweeps.push(a));
  await link.startScan((tl) => asm.add(tl), () => asm.passEnd());
  while (sweeps.length < 2) await delay(10);
  await link.stopScan();
  link.close();
  assert.equal(asm.misaligned, 0);
  assert.equal(sweeps[0].length, 731);
});

test('a unit left scanning is stopped before the scan settings are written', async (t) => {
  // a real AXT600 refused every scan setting with DMP reason 5 in this state
  const unit = await startFakeAxt600({ scanningAtStart: true });
  t.after(() => unit.close());
  const link = new Axt600NetworkLink({ host: unit.host, cid: unit.cid, port: unit.port, log: () => {} });
  await link.connect();
  assert.equal(unit.scanning, true);
  await link.configureScan(planScan({ startHz: 470e6, stopHz: 616e6, rbwHz: 1e6 }));
  assert.equal(unit.state.refused ?? 0, 0);
  assert.deepEqual(unit.scan, { startKhz: 470_000, stopKhz: 616_000, stepKhz: 1000 });
  link.close();
});

test('a refusal names the DMP reason', async (t) => {
  const unit = await startFakeAxt600({ scanningAtStart: true });
  t.after(() => unit.close());
  const session = new SdtSession({ host: unit.host, port: unit.port, deviceCid: unit.cid });
  await session.open();
  await assert.rejects(
    session.set([[0x01070100, Buffer.from([0, 7, 0x2b, 0xf0])]]),
    (err) => err.code === 'set_refused' && /DMP reason 5: data error/.test(err.message)
  );
  await session.close();
});

const scanEvent = (index, values) => {
  const value = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => value.writeInt16BE(Math.round(v * 10), 2 * i));
  return { vector: 4, single: false, address: 0x10000000 + index, increment: 1, count: values.length, value };
};

test('a scan tile starts on the 25 kHz band grid; its points are a scan step apart', () => {
  // as a unit scanning 470–616 MHz at 200 kHz reported it: index 1920 = 518 MHz
  const link = new Axt600NetworkLink({ host: 'x', log: () => {} });
  link.scan = { startHz: 470e6, stepHz: 200e3, deviceCount: 731 };
  const tiles = [];
  link.onTile = (tl) => tiles.push(tl);
  link.handleDmp([scanEvent(1920, [-90, -91, -92])]);
  link.handleDmp([scanEvent(0, [-80])]);
  assert.deepEqual(tiles, [
    { startHz: 518e6, stepHz: 200e3, amplitudesDbm: [-90, -91, -92] },
    { startHz: 470e6, stepHz: 200e3, amplitudesDbm: [-80] },
  ]);
  assert.equal(link.indexOrigin, 'band');
});

test('a tile that would land outside the scan is read from the scan start', () => {
  const link = new Axt600NetworkLink({ host: 'x', log: () => {} });
  link.scan = { startHz: 700e6, stepHz: 200e3, deviceCount: 501 }; // 700–800 MHz
  const tiles = [];
  link.onTile = (tl) => tiles.push(tl);
  link.handleDmp([scanEvent(8, [-90, -91])]); // 470.2 MHz on the band grid: not this scan
  assert.equal(link.indexOrigin, 'start');
  assert.deepEqual(tiles, [{ startHz: 700.2e6, stepHz: 200e3, amplitudesDbm: [-90, -91] }]);
});

test('a pass ends when progress reaches 100 %', () => {
  const link = new Axt600NetworkLink({ host: 'x' });
  let ends = 0;
  link.onPassEnd = () => (ends += 1);
  const progress = (pct) => ({ vector: 4, single: true, address: 0x01070110, value: Buffer.from([pct]) });
  link.handleDmp([progress(0)]);
  link.handleDmp([progress(95)]);
  link.handleDmp([progress(100)]);
  link.handleDmp([progress(100)]);
  link.handleDmp([progress(5)]);
  link.handleDmp([progress(100)]);
  assert.equal(ends, 2);
});

// ---------------------------------------------------------------------------
// simulator
// ---------------------------------------------------------------------------

test('the simulator delivers complete passes', async () => {
  const sim = new SimulatedAxt600({ timeScale: 0.002 });
  await sim.connect();
  const plan = planScan({ startHz: 470e6, stopHz: 616e6, rbwHz: 200e3 });
  await sim.configureScan(plan);
  const sweeps = [];
  const asm = new SweepAssembler(plan, (a, info) => sweeps.push(info));
  await sim.startScan((tl) => asm.add(tl), () => asm.passEnd());
  while (sweeps.length < 2) await delay(10);
  sim.close();
  assert.equal(asm.misaligned, 0);
  assert.deepEqual(sweeps[0].missing, []);
});

test('nothing arrives after the scan is stopped', async () => {
  const sim = new SimulatedAxt600({ timeScale: 0.002 });
  await sim.connect();
  await sim.configureScan(planScan({ rbwHz: 1e6 }));
  let tiles = 0;
  await sim.startScan(() => (tiles += 1), () => {});
  await sim.stopScan();
  const after = tiles;
  await delay(80);
  assert.equal(tiles, after);
  sim.close();
});

test('which link a device gets', () => {
  assert.ok(isSimulated({ id: 'sim:axt600' }));
  assert.ok(isSimulated({ id: 'net:x', config: { host: 'simulated' } }));
  assert.ok(!isSimulated({ id: 'net:10.0.0.5', config: { host: '10.0.0.5' } }));
  assert.ok(createLink({ id: 'sim:axt600' }) instanceof SimulatedAxt600);
  assert.ok(createLink({ id: 'net:10.0.0.5' }, { host: '10.0.0.5' }) instanceof Axt600NetworkLink);
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
  // progressive traces keep the notice; the first complete pass clears it
  while (warnings.at(-1).length) await delay(10);
  assert.ok(traces >= 1);
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

test('a device known only by its component id needs no address', () => {
  assert.doesNotThrow(() =>
    createSpectrumAnalyzerAdapter({ id: 'acn:a1b2c3d4000011dda000000eddcccccc' })
  );
});

test('the link finds a unit by component id alone', async (t) => {
  const slpPort = await freePort();
  const unit = await startFakeAxt600({ slpPort });
  const slp = new SlpListener({ port: slpPort, multicast: false });
  t.after(async () => {
    slp.close();
    await unit.close();
  });
  const link = new Axt600NetworkLink({ host: null, cid: unit.cid, slp });
  const identity = await link.connect();
  assert.equal(identity.model, 'AXT600');
  assert.equal(link.host, unit.host);
  link.close();
});

test('a device with no address says so', () => {
  assert.throws(() => createSpectrumAnalyzerAdapter({ id: 'something' }), /no address/);
});
