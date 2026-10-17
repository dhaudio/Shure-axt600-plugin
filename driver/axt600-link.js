// The real AXT600, over the network: a link (see driver/link.js) built on an
// SDT session.
//
// The properties, from captures of Wireless Workbench scanning a unit on
// firmware 2.1.41 (docs/protocolo.md has the whole map):
//
//   0x01000012  model name             "AXT600"
//   0x01000004  firmware               four u16: 2, 1, 41, 0
//   0x01070100  scan start, kHz        u32
//   0x01070101  scan stop, kHz         u32
//   0x01070102  scan step, kHz         u32    25, 200 or 1000
//   0x01070108  resolution, kHz        u32    Wireless Workbench sets it = step
//   0x01070109  (scan flags)           u8     Wireless Workbench writes 0xff
//   0x01070103  start scanning         u8     write 0
//   0x0107010e  stop scanning          u8     write 0
//   0x01070110  scan progress, %       u8     event, 0…100 in steps of 5
//   0x01070131  scanning               u8     event, 1 while a scan runs
//   0x1fffffff  scan data subscription
//   0x10000000+i  scan data            event, range: int16 BE tenths of dBm
//
// A pass is reported twice over: the first half of it carries one antenna, the
// second half the same points again as the stronger of the two. The second
// report of a point is never lower than the first. So the latest value of each
// point is the combined level, and the pass is complete when progress reaches
// 100 % — which is when the link reports it.

import { SessionError, SdtSession } from './sdt-session.js';
import { decodeString, u32, u8 } from './acn.js';

export const P = {
  MODEL: 0x01000012,
  FIRMWARE: 0x01000004,
  SCAN_START_KHZ: 0x01070100,
  SCAN_STOP_KHZ: 0x01070101,
  SCAN_STEP_KHZ: 0x01070102,
  SCAN_RBW_KHZ: 0x01070108,
  SCAN_FLAGS: 0x01070109,
  SCAN_GO: 0x01070103,
  SCAN_STOP: 0x0107010e,
  SCAN_PROGRESS: 0x01070110,
  SCAN_STATE_A: 0x01070120,
  SCAN_RUNNING: 0x01070131,
  SCAN_DATA_SUB: 0x1fffffff,
  SCAN_DATA_BASE: 0x10000000,
};

const DATA_END = 0x1fffffff;
const ABSOLUTE_ORIGIN_HZ = 470_000_000;
const ABSOLUTE_STEP_HZ = 25_000;

export class Axt600NetworkLink {
  constructor({ host, cid = null, port = null, slp, log = () => {} }) {
    this.host = host;
    this.cid = cid;
    this.port = port;
    this.slp = slp;
    this.log = log;
    this.session = null;
    this.scan = null;
    this.indexMode = 'relative';
    this.lastProgress = null;
    /** assigned by the user; called when the link dies unprompted */
    this.onFatal = null;
  }

  async connect() {
    let cid = this.cid;
    let port = this.port;
    let name = null;
    if (!cid || !port) {
      const advert = await this.slp?.advertFor(this.host);
      if (!advert && !cid) {
        throw new SessionError(
          `No AXT600 is advertising at ${this.host}. Check that it is switched on, that ` +
            `its address is right, and that this computer is on the same network (subnet).`,
          'not_found'
        );
      }
      cid ??= advert.cid;
      port ??= advert?.port;
      name = advert?.uacn ?? null;
    }

    this.session = new SdtSession({
      host: this.host,
      port: port ?? undefined,
      deviceCid: cid,
      log: this.log,
    });
    this.session.onFatal = (err) => this.onFatal?.(err);
    this.session.onDmp = (items) => this.handleDmp(items);
    await this.session.open();

    const values = await this.session.get([P.MODEL, P.FIRMWARE]);
    const fw = values.get(P.FIRMWARE);
    const firmware =
      fw && fw.length >= 6
        ? `${fw.readUInt16BE(0)}.${fw.readUInt16BE(2)}.${fw.readUInt16BE(4)}`
        : undefined;
    return {
      model: decodeString(values.get(P.MODEL)) || 'AXT600',
      firmware,
      ...(name ? { name } : {}),
    };
  }

  /** Write the scan settings. The AXT600 does not echo them; the plan fits it. */
  async configureScan({ startHz, stepHz, deviceCount }) {
    const startKhz = Math.round(startHz / 1000);
    const stepKhz = Math.round(stepHz / 1000);
    const stopKhz = startKhz + (deviceCount - 1) * stepKhz;
    await this.session.set([
      [P.SCAN_START_KHZ, u32(startKhz)],
      [P.SCAN_STOP_KHZ, u32(stopKhz)],
      [P.SCAN_STEP_KHZ, u32(stepKhz)],
      [P.SCAN_RBW_KHZ, u32(stepKhz)],
      [P.SCAN_FLAGS, u8(0xff)],
    ]);
    this.scan = { startHz, stepHz, deviceCount };
    this.indexMode = 'relative';
    this.log(`scan set: ${startKhz}–${stopKhz} kHz, step ${stepKhz} kHz`);
    return { ...this.scan };
  }

  async startScan(onTile, onPassEnd) {
    this.onTile = onTile;
    this.onPassEnd = onPassEnd;
    this.lastProgress = null;
    await this.session.subscribe([
      P.SCAN_STATE_A,
      P.SCAN_PROGRESS,
      P.SCAN_RUNNING,
      P.SCAN_DATA_SUB,
    ]);
    await this.session.set([[P.SCAN_GO, u8(0)]]);
    this.log('scan started');
  }

  async stopScan() {
    this.onTile = null;
    this.onPassEnd = null;
    if (!this.session) return;
    try {
      await this.session.set([[P.SCAN_STOP, u8(0)]]);
      this.session.unsubscribe([P.SCAN_DATA_SUB, P.SCAN_STATE_A, P.SCAN_PROGRESS]);
      this.log('scan stopped');
    } catch (err) {
      this.log(`stopping the scan: ${err.message}`);
    }
  }

  close() {
    this.onFatal = null;
    const session = this.session;
    this.session = null;
    session?.close();
  }

  /** Every DMP message from the unit; public so the index rules can be tested. */
  handleDmp(items) {
    for (const item of items) {
      if (item.vector !== 4 /* EVENT */) continue;
      if (item.single && item.address === P.SCAN_PROGRESS && item.value?.length) {
        const progress = item.value[0];
        if (progress >= 100 && this.lastProgress !== null && this.lastProgress < 100) {
          this.onPassEnd?.();
        }
        this.lastProgress = progress;
      } else if (
        !item.single &&
        item.address >= P.SCAN_DATA_BASE &&
        item.address < DATA_END &&
        item.value
      ) {
        this.#scanData(item);
      }
    }
  }

  #scanData({ address, count, value }) {
    if (!this.scan || !this.onTile) return;
    const n = Math.min(count, Math.floor(value.length / 2));
    const amplitudesDbm = new Array(n);
    for (let k = 0; k < n; k += 1) amplitudesDbm[k] = value.readInt16BE(2 * k) / 10;
    const index = address - P.SCAN_DATA_BASE;
    const { startHz, stepHz, deviceCount } = this.scan;

    // The index counts scan steps from the start — or, if the unit numbers
    // its points on the whole band's 25 kHz grid instead, it will run past
    // the end of this scan, and from then on is read that way.
    if (this.indexMode === 'relative' && index + n > deviceCount && stepHz !== ABSOLUTE_STEP_HZ) {
      this.indexMode = 'absolute';
      this.log(
        `scan data index ${index} is past this scan's ${deviceCount} points: ` +
          `reading indexes on the 470 MHz + n × 25 kHz grid`
      );
    }
    if (this.indexMode === 'relative') {
      this.onTile({ startHz: startHz + index * stepHz, stepHz, amplitudesDbm });
      return;
    }
    for (let k = 0; k < n; k += 1) {
      const hz = ABSOLUTE_ORIGIN_HZ + (index + k) * ABSOLUTE_STEP_HZ;
      const offset = hz - startHz;
      if (offset < 0 || offset % stepHz !== 0) continue;
      this.onTile({ startHz: hz, stepHz, amplitudesDbm: [amplitudesDbm[k]] });
    }
  }
}
