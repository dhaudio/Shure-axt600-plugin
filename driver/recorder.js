// Recording complete passes to disk.
//
// While recording, each scan configuration gets two files in the chosen
// folder, named after the device and the moment the scan started:
//
//   <name>_<when>_history.csv   one row per complete pass: the time, then a
//                               level per frequency — opens in a spreadsheet
//   <name>_<when>_maxhold.csv   the highest level each frequency reached in the
//                               session, as "Frequency (MHz),Level (dBm)" —
//                               the two-column shape SoundBase imports as a scan
//
// A new range or step starts a new pair. The levels are the ones the trace
// shows, offset included. Writing never blocks the trace; a failure is reported
// once and recording stops.

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function defaultFolder() {
  return path.join(os.homedir(), 'Documents', 'SoundBase AXT600 recordings');
}

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
const localIso = (d) => {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${stamp(d).replace('_', 'T').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')}${sign}${p(off / 60)}:${p(off % 60)}`;
};
const safe = (s) => String(s).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'AXT600';

export class PassRecorder {
  /**
   * @param folder  where the files go (created if missing)
   * @param name    device name, for the file names
   * @param axis    { startHz, stepHz, pointCount } of the trace
   * @param note    a line for the history header (offset, step)
   * @param log     (line) => void
   */
  constructor({ folder, name, axis, note = '', log = () => {}, now = () => new Date() }) {
    this.axis = axis;
    this.log = log;
    this.now = now;
    this.failed = false;
    this.max = null;
    const base = `${safe(name)}_${stamp(now())}`;
    this.folder = folder || defaultFolder();
    this.historyPath = path.join(this.folder, `${base}_history.csv`);
    this.maxPath = path.join(this.folder, `${base}_maxhold.csv`);
    this.note = note;
    this.chain = this.#start();
  }

  get freqsMHz() {
    const { startHz, stepHz, pointCount } = this.axis;
    return Array.from({ length: pointCount }, (_, i) => ((startHz + i * stepHz) / 1e6).toFixed(4));
  }

  async #start() {
    await mkdir(this.folder, { recursive: true });
    const header = [
      `# AXT600 scan history${this.note ? ` — ${this.note}` : ''}`,
      ['time', ...this.freqsMHz].join(','),
    ].join('\n');
    await writeFile(this.historyPath, `${header}\n`);
    this.log(`recording to ${this.historyPath}`);
  }

  /** One complete pass. Queued so files are written in order. */
  record(amplitudes) {
    if (this.failed) return this.chain;
    const values = amplitudes.map((v) => Math.round(v * 10) / 10);
    this.max = this.max ? this.max.map((m, i) => Math.max(m, values[i])) : [...values];
    const max = [...this.max];
    const row = `${localIso(this.now())},${values.join(',')}\n`;
    this.chain = this.chain
      .then(async () => {
        await appendFile(this.historyPath, row);
        const freqs = this.freqsMHz;
        const lines = max.map((v, i) => `${freqs[i]},${v}`);
        await writeFile(this.maxPath, `Frequency (MHz),Level (dBm)\n${lines.join('\n')}\n`);
      })
      .catch((err) => {
        if (!this.failed) this.log(`recording stopped: ${err.message}`);
        this.failed = err;
      });
    return this.chain;
  }

  /** Resolves when everything queued is on disk. */
  flush() {
    return this.chain;
  }
}
