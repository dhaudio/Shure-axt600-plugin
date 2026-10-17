#!/usr/bin/env node
// Try the plugin's driver against a real AXT600, outside SoundBase.
//
//   npm run probe -- 192.168.1.3
//   npm run probe -- 192.168.1.3 --start 470 --stop 616 --step 200 --passes 2
//
// Quit Wireless Workbench first. The probe finds the unit from its advert,
// opens a session, reads its model and firmware, runs a scan for a couple of
// passes, stops it and leaves. It prints what happened and writes everything
// worth sending back to probe-axt600-<time>.json beside this repository.
//
// What it writes to the unit: the scan settings (start, stop, step), scan
// start and scan stop — the same things Wireless Workbench writes when you
// press Scan. Nothing else.

import { writeFileSync } from 'node:fs';
import { Axt600NetworkLink } from '../driver/axt600-link.js';
import { SlpListener } from '../driver/slp.js';
import { planScan } from '../driver/scan-plan.js';
import { SweepAssembler } from '../driver/sweep-assembler.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const host = args.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
if (!host) {
  console.error('usage: npm run probe -- <AXT600 IP address> [--start MHz] [--stop MHz] [--step kHz] [--passes N]');
  process.exit(2);
}
const startMHz = flag('start', 470);
const stopMHz = flag('stop', 616);
const stepKHz = flag('step', 200);
const passes = flag('passes', 2);

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s`;
const say = (line) => console.log(`${since()}  ${line}`);
const report = {
  host,
  request: { startMHz, stopMHz, stepKHz, passes },
  log: [],
  identity: null,
  plan: null,
  tiles: 0,
  firstTiles: [],
  indexes: { min: Infinity, max: -Infinity },
  progress: [],
  passes: [],
  error: null,
};
const log = (line) => {
  report.log.push(`${since()}  ${line}`);
  say(line);
};

const testPort = Number(process.env.SB_AXT600_SLP_PORT);
const slp = new SlpListener(testPort ? { port: testPort, multicast: false, log } : { log });
const link = new Axt600NetworkLink({ host, slp, log });
let fatal = null;
link.onFatal = (err) => {
  fatal = err;
  log(`LOST: ${err.message}`);
};

// see the raw events too, for the report
const passTimes = [];
let finish;
const done = new Promise((resolve) => (finish = resolve));

async function main() {
  log(`listening for the AXT600 at ${host} (it advertises every ~4 s)…`);
  report.identity = await link.connect();
  log(`connected: ${JSON.stringify(report.identity)}`);

  const plan = planScan({ startHz: startMHz * 1e6, stopHz: stopMHz * 1e6, rbwHz: stepKHz * 1e3 });
  report.plan = plan;
  await link.configureScan(plan);
  log(`expecting ${plan.deviceCount} points per pass, up to ${plan.sweepTimeMs / 1000} s a pass`);

  const original = link.handleDmp.bind(link);
  link.handleDmp = (items) => {
    for (const item of items) {
      if (item.vector !== 4) continue;
      if (item.single) {
        if (item.address === 0x01070110) {
          report.progress.push([Number(since().trim().split(' ')[0]), item.value[0]]);
          if (item.value[0] % 25 === 0) log(`progress ${item.value[0]} %`);
        } else {
          log(`event 0x${item.address.toString(16)} = ${item.value.toString('hex')}`);
        }
      } else if (item.address >= 0x10000000) {
        const index = item.address - 0x10000000;
        report.tiles += 1;
        report.indexes.min = Math.min(report.indexes.min, index);
        report.indexes.max = Math.max(report.indexes.max, index + item.count - 1);
        if (report.firstTiles.length < 20) {
          report.firstTiles.push({
            at: since().trim(),
            index,
            count: item.count,
            first: item.value.readInt16BE(0) / 10,
          });
        }
      }
    }
    original(items);
  };

  const assembler = new SweepAssembler(plan, (amplitudes, { missing }) => {
    const peaks = amplitudes
      .map((v, i) => [plan.startHz + i * plan.stepHz * plan.decimation, v])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([hz, v]) => `${(hz / 1e6).toFixed(3)} MHz ${v} dBm`);
    const floor = [...amplitudes].sort((a, b) => a - b)[Math.floor(amplitudes.length / 2)];
    passTimes.push(Date.now());
    const pass = {
      at: since().trim(),
      points: amplitudes.length,
      medianDbm: floor,
      strongest: peaks,
      missing: missing.map(([a, b]) => `${(a / 1e6).toFixed(3)}–${(b / 1e6).toFixed(3)} MHz`),
      amplitudesDbm: amplitudes,
    };
    report.passes.push(pass);
    log(`PASS ${report.passes.length} complete: ${amplitudes.length} points, median ${floor} dBm`);
    log(`   strongest: ${peaks.slice(0, 4).join(', ')}`);
    if (missing.length) log(`   not reported: ${pass.missing.join(', ')}`);
    if (report.passes.length >= passes) finish();
  });

  await link.startScan(
    (tile) => assembler.add(tile),
    () => assembler.passEnd()
  );
  const limit = Math.max(30_000, plan.sweepTimeMs * (passes + 1) * 1.5);
  const timer = setTimeout(() => {
    log(`no ${passes} complete passes within ${Math.round(limit / 1000)} s; stopping`);
    finish();
  }, limit);
  await Promise.race([done, new Promise((r) => (link.onFatal = (e) => { fatal = e; log(`LOST: ${e.message}`); r(); }))]);
  clearTimeout(timer);
  report.misaligned = assembler.misaligned;
  report.indexMode = link.indexMode;
}

try {
  await main();
} catch (err) {
  report.error = err.message;
  log(`FAILED: ${err.message}`);
} finally {
  if (!fatal) {
    await link.stopScan();
    link.close();
  }
  slp.close();
  await new Promise((r) => setTimeout(r, 300));
  if (!Number.isFinite(report.indexes.min)) report.indexes = null;
  const file = `probe-axt600-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(new URL(`../${file}`, import.meta.url), JSON.stringify(report, null, 1));
  console.log(`\nreport written to ${file} — send it back along with what you saw.`);
  process.exit(report.error || fatal ? 1 : 0);
}
