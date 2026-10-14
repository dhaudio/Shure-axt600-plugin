// Contract tests for the adapter, driven through the real shell over real HTTP.
//
// Nothing here needs an AXT600: the simulated unit (driver/simulated-axt600.js)
// stands in for it, sped up so a pass that takes seconds on the hardware takes
// milliseconds here. Everything between the HTTP request and the link is the
// real thing: shell, adapter, scan plan, sweep assembly.
//
// Nothing here hardcodes the plugin's id: everything that could change when you
// run `npm run rename` is read from soundbase-plugin.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';

// before the plugin loads: list the simulated unit, and run it fast
process.env.SB_AXT600_MOCK = '1';
process.env.SB_AXT600_SIM_TIMESCALE = '0.002';

const { PRODUCT, SIMULATED_DEVICE_ID } = await import('../adapter.js');
const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

const DEVICE_PATH = `/devices/${encodeURIComponent(SIMULATED_DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;

// boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;
test.after(() => handle.close());

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const configure = (body) =>
  request('POST', `${DEVICE_PATH}/configuration`, body);
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
const listed = async (id = SIMULATED_DEVICE_ID) => {
  const { body } = await request('GET', '/devices');
  return body.devices.find((d) => d.id === id);
};
const sweeping = async (t) => {
  const started = await request('POST', `${DEVICE_PATH}/sweep/start`);
  assert.equal(started.status, 200);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));
};
const traceAfter = async (sweepId = 0) => {
  let trace = await request('GET', `${DEVICE_PATH}/trace`);
  while (trace.body.sweepId <= sweepId) {
    trace = await request('GET', `${DEVICE_PATH}/trace`);
  }
  return trace;
};

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

test('the product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(
    declared.includes(PRODUCT),
    `adapter.js announces ${PRODUCT}, but the manifest declares ${declared}`
  );
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
});

test('the simulated AXT600 is discovered', async () => {
  const device = await listed();
  assert.ok(device, 'the simulated unit is listed');
  assert.equal(device.product, PRODUCT);
  assert.equal(device.discovered, true);
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

test('a chosen RBW is a scan step: one point per step, and a sweep time', async () => {
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
  // three 60 MHz blocks at 7 s, capped at the full-range time
  assert.equal(body.resolved.sweepTimeMs, 9_400);
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
  // 25 kHz needs 5841 points and 200 kHz 731; 1 MHz fits in 147
  assert.equal(body.pointCount, 147);
  assert.equal(body.resolved.rbwHz, 1_000_000);
});

test('a 25 kHz scan of the whole range is coarsened, not truncated', async () => {
  const { body } = await configure({
    startHz: 470_000_000,
    stopHz: 952_000_000,
    rbwHz: 25_000,
  });
  assert.equal(body.rbwHz, 25_000);
  assert.ok(body.pointCount <= 2_000, `${body.pointCount} points`);
  assert.equal(body.pointCount, 1_929); // 19 281 device points, peak of each 10
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

test('a sweep is the peak of both antennas, with A and B as their own curves', async (t) => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: 200_000 });
  await sweeping(t);

  const { status, body } = await traceAfter();
  assert.equal(status, 200);
  assert.equal(body.startHz, START_HZ);
  assert.equal(body.stopHz, STOP_HZ);
  assert.equal(body.pointCount, 731);
  assert.equal(body.amplitudesDbm.length, 731);
  assert.equal(body.unit, 'dBm');

  assert.deepEqual(
    body.series.map((s) => s.name),
    ['A', 'B']
  );
  for (const s of body.series) assert.equal(s.amplitudesDbm.length, 731);
  for (let i = 0; i < 731; i += 1) {
    const [a, b] = body.series.map((s) => s.amplitudesDbm[i]);
    assert.equal(body.amplitudesDbm[i], Math.max(a, b));
  }

  // the simulated venue: a carrier at 518.100 MHz over a -101 dBm floor
  const at = (hz) => Math.round((hz - START_HZ) / 200_000);
  const carrier = Math.max(...body.amplitudesDbm.slice(at(518e6) - 2, at(518.2e6) + 2));
  const floor = Math.max(...body.amplitudesDbm.slice(at(480e6), at(500e6)));
  assert.ok(carrier > -50, `carrier only reached ${carrier}`);
  assert.ok(floor < -90, `floor rose to ${floor}`);
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
  const before = await traceAfter();
  assert.equal(before.body.startHz, START_HZ);

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
});

test('a real AXT600 added by IP fails with a reason, not silently', async (t) => {
  const added = await request('POST', '/devices', {
    id: 'net:192.0.2.60',
    product: PRODUCT,
    config: { host: '192.0.2.60' },
  });
  assert.equal(added.status, 201);
  t.after(() => request('DELETE', `/devices/${encodeURIComponent('net:192.0.2.60')}`));

  // opening happens on first use
  await request(
    'POST',
    `/devices/${encodeURIComponent('net:192.0.2.60')}/configuration`,
    { startHz: START_HZ, stopHz: STOP_HZ }
  );
  const device = await until(
    async () => {
      const d = await listed('net:192.0.2.60');
      return d?.status.status === 'failed' ? d : null;
    },
    { what: 'the real unit being marked failed' }
  );
  assert.match(device.status.message, /protocol still has to be captured/);
  assert.match(device.status.message, /192\.0\.2\.60/);
});
