// Contract tests for the adapter, driven through the real shell over real HTTP.
//
// Nothing here needs an AXT600. A fake one (driver/fake-axt600.js) advertises
// on a loopback port and speaks the device side of the same ACN a real unit
// does, so everything between the HTTP request and the UDP socket is the real
// thing: shell, adapter, SLP discovery, SDT session, DMP, sweep assembly. The
// fake scans fast, so a pass that takes seconds on the hardware takes
// milliseconds here.
//
// Nothing here hardcodes the plugin's id: everything that could change when you
// run `npm run rename` is read from soundbase-plugin.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';
import { startFakeAxt600 } from '../driver/fake-axt600.js';

// before the plugin loads: where it listens for adverts, and a fast simulator
const freePort = async () => {
  const s = dgram.createSocket('udp4');
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
};
const slpPort = await freePort();
process.env.SB_AXT600_SLP_PORT = String(slpPort);
process.env.SB_AXT600_MOCK = '1';
process.env.SB_AXT600_SIM_TIMESCALE = '0.002';

const unit = await startFakeAxt600({ slpPort, name: 'FOH AXT600', skip: [600e6, 605e6] });

const { PRODUCT, SIMULATED_DEVICE_ID } = await import('../adapter.js');
const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

const DEVICE_ID = `net:${unit.host}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const SIM_PATH = `/devices/${encodeURIComponent(SIMULATED_DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;

// boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;
test.after(async () => {
  await handle.close();
  await unit.close();
});

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe, { timeoutMs = 5_000, what = 'the condition' } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
};
const listed = async (id = DEVICE_ID) => {
  const { body } = await request('GET', '/devices');
  return body.devices.find((d) => d.id === id);
};
const configure = (body, path = DEVICE_PATH) =>
  request('POST', `${path}/configuration`, body);
const sweeping = async (t, path = DEVICE_PATH) => {
  const started = await request('POST', `${path}/sweep/start`);
  assert.equal(started.status, 200);
  t.after(() => request('POST', `${path}/sweep/stop`));
};
const traceAfter = async (sweepId = 0, path = DEVICE_PATH) => {
  let trace = await request('GET', `${path}/trace`);
  while (trace.body.sweepId <= sweepId) trace = await request('GET', `${path}/trace`);
  return trace;
};

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

test('the product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(declared.includes(PRODUCT), `${PRODUCT} not in ${declared}`);
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
});

test('an AXT600 on the network is discovered from its advert', async () => {
  const device = await until(() => listed(), { what: 'the advertised unit' });
  assert.equal(device.product, PRODUCT);
  assert.equal(device.discovered, true);
  assert.equal(device.name, `FOH AXT600 (${unit.host})`);
});

test('open() reports the AXT600 range and its three steps as RBW', async () => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ });
  const caps = (await listed()).capabilities;
  assert.equal(caps.minFrequencyHz, 470_000_000);
  assert.equal(caps.maxFrequencyHz, 952_000_000);
  assert.deepEqual(caps.rbwHz, [25_000, 200_000, 1_000_000]);
  assert.deepEqual([...caps.traceModes].sort(), [
    'average',
    'clear-write',
    'max-hold',
    'min-hold',
  ]);
});

test('a chosen RBW is a scan step, written to the unit in kHz', async () => {
  const { status, body } = await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: 200_000,
  });
  assert.equal(status, 200);
  assert.equal(body.startHz, START_HZ);
  assert.equal(body.stopHz, STOP_HZ);
  assert.equal(body.pointCount, 731); // 146 MHz / 200 kHz + 1
  assert.equal(body.rbwHz, 200_000);
  assert.equal(body.resolved.sweepTimeMs, 9_400);
  assert.deepEqual(unit.scan, { startKhz: 470_000, stopKhz: 616_000, stepKhz: 200 });
});

test('an RBW between steps snaps to the nearest one', async () => {
  const { body } = await configure({ rbwHz: 300_000 });
  assert.equal(body.rbwHz, 200_000);
});

test('without an RBW, the point count picks the finest step that fits', async () => {
  const { body } = await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: null, // back to auto: the shell keeps a chosen RBW until cleared
    pointCount: 451,
  });
  assert.equal(body.pointCount, 147);
  assert.equal(body.resolved.rbwHz, 1_000_000);
  assert.equal(unit.scan.stepKhz, 1000);
});

test('a 25 kHz scan of the whole range is coarsened, not truncated', async () => {
  const { body } = await configure({
    startHz: 470_000_000,
    stopHz: 952_000_000,
    rbwHz: 25_000,
  });
  assert.equal(body.rbwHz, 25_000);
  assert.equal(body.pointCount, 1_929); // 19 281 points, peak of each 10
  assert.equal(body.resolved.sweepTimeMs, 64_000);
});

test('out-of-range configuration is clamped, not rejected', async () => {
  const { status, body } = await configure({
    startHz: 0,
    stopHz: 10_000_000_000,
    rbwHz: 1_000_000,
  });
  assert.equal(status, 200);
  assert.equal(body.startHz, 470_000_000);
  assert.ok(body.stopHz <= 952_000_000);
});

test('a sweep arrives on the configured axis, with the venue in it', async (t) => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: 200_000 });
  await sweeping(t);

  const { status, body } = await traceAfter();
  assert.equal(status, 200);
  assert.equal(body.startHz, START_HZ);
  assert.equal(body.stopHz, STOP_HZ);
  assert.equal(body.pointCount, 731);
  assert.equal(body.amplitudesDbm.length, 731);
  assert.equal(body.unit, 'dBm');
  assert.equal(body.series, undefined);

  // the fake venue: a carrier at 518.100 MHz over a -101 dBm floor
  const at = (hz) => Math.round((hz - START_HZ) / 200_000);
  const carrier = Math.max(...body.amplitudesDbm.slice(at(518e6) - 2, at(518.2e6) + 2));
  const floor = Math.max(...body.amplitudesDbm.slice(at(480e6), at(500e6)));
  assert.ok(carrier > -50, `carrier only reached ${carrier}`);
  assert.ok(floor < -90, `floor rose to ${floor}`);
});

test('a band the unit never reports is filled and named in a warning', async (t) => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: 200_000 });
  await sweeping(t);
  await traceAfter();
  const device = await until(
    async () => {
      const d = await listed();
      return d.status.warnings?.some((w) => w.id === 'scan-gaps') ? d : null;
    },
    { what: 'the gap warning' }
  );
  const warning = device.status.warnings.find((w) => w.id === 'scan-gaps');
  assert.equal(warning.severity, 'info');
  assert.match(warning.message, /600\.\d{3}–60[45]\.\d{3} MHz/);
});

test('successive polls see successive sweeps', async (t) => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: 1_000_000 });
  await sweeping(t);
  const first = await traceAfter();
  const second = await traceAfter(first.body.sweepId);
  assert.ok(second.body.sweepId > first.body.sweepId);
});

test('retuning while sweeping moves the trace to the new range', async (t) => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: 1_000_000 });
  await sweeping(t);
  await traceAfter();

  await configure({ startHz: 600_000_000, stopHz: 700_000_000 });
  const after = await until(
    async () => {
      const trace = await request('GET', `${DEVICE_PATH}/trace`);
      return trace.body.startHz === 600_000_000 ? trace : null;
    },
    { what: 'a trace on the new range' }
  );
  assert.equal(after.body.stopHz, 700_000_000);
  assert.equal(after.body.pointCount, 101);
  assert.equal(unit.scan.startKhz, 600_000);
});

test('stopping the sweep stops the unit scanning', async () => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: 1_000_000 });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  await until(() => unit.scanning, { what: 'the unit to scan' });
  await request('POST', `${DEVICE_PATH}/sweep/stop`);
  await until(() => !unit.scanning, { what: 'the unit to stop' });
});

test('the simulated AXT600 sweeps too', async (t) => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: 200_000 }, SIM_PATH);
  await sweeping(t, SIM_PATH);
  const { body } = await traceAfter(0, SIM_PATH);
  assert.equal(body.pointCount, 731);
});

test('an address with no AXT600 behind it fails with a reason', async (t) => {
  const id = 'net:127.0.0.9';
  const added = await request('POST', '/devices', {
    id,
    product: PRODUCT,
    config: { host: '127.0.0.9' },
  });
  assert.equal(added.status, 201);
  t.after(() => request('DELETE', `/devices/${encodeURIComponent(id)}`));

  await request('POST', `/devices/${encodeURIComponent(id)}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
  });
  const device = await until(
    async () => {
      const d = await listed(id);
      return d?.status.status === 'failed' ? d : null;
    },
    { timeoutMs: 15_000, what: 'the unreachable unit being marked failed' }
  );
  assert.match(device.status.message, /No AXT600 is advertising at 127\.0\.0\.9/);
});
