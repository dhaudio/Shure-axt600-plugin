// Finding AXT600s from their SLP adverts.
//
// Every ~4 s an AXT600 multicasts an SLPv2 attribute reply to
// 239.255.254.253:8427 that carries everything a session needs:
//
//   (cid=A1B2C3D4-0000-11DD-A000-000EDDCCCCCC),(acn-fctn=AXT600),
//   (acn-uacn=AXT600),(csl-esta.dmp=esta.sdt/192.168.1.3:57383;…)
//
// The listener only listens. A controller also has to announce itself the
// same way before it joins: Wireless Workbench multicasts its own advert two
// seconds before its first JOIN, and a unit did not answer a controller that
// had not. `buildAdvert` makes ours — as SoundBase, under this plugin's own
// component id, never as Wireless Workbench.

import dgram from 'node:dgram';
import os from 'node:os';
import { cidFromString } from './acn.js';

/** This plugin's component definition id: ours, not Wireless Workbench's. */
export const PLUGIN_DCID = '6F1B6C1E-4C7A-4E62-9D5B-A7F2C2B60600';

export const SLP_GROUP = '239.255.254.253';
export const SLP_PORT = 8427;
const FORGET_AFTER_MS = 15_000;

/**
 * An SLPv2 attribute reply announcing a controller, in the layout Shure
 * equipment sends: header, error 0, the attribute list, no auth blocks.
 */
export function buildAdvert({ cidText, host, port, xid = 0x223d }) {
  const attrs = Buffer.from(
    `(cid=${cidText}),(acn-fctn=SoundBase),(acn-uacn=SoundBase AXT600 plugin),` +
      `(acn-services=esta.dmp),(csl-esta.dmp=esta.sdt/${host}:${port};esta.dmp/cd:${PLUGIN_DCID}),` +
      `(csl-esta.dmp.values=version:1_interfaceId:1_extVersion:1)`,
    'latin1'
  );
  const lang = Buffer.from('en');
  const body = Buffer.alloc(4);
  body.writeUInt16BE(0, 0); // error code
  body.writeUInt16BE(attrs.length, 2);
  const total = 14 + lang.length + body.length + attrs.length + 1;
  const head = Buffer.alloc(14);
  head[0] = 2; // SLPv2
  head[1] = 7; // AttrRply
  head.writeUIntBE(total, 2, 3);
  head.writeUInt16BE(0, 5); // flags
  head.writeUIntBE(0, 7, 3); // next extension
  head.writeUInt16BE(xid, 10);
  head.writeUInt16BE(lang.length, 12);
  return Buffer.concat([head, lang, body, attrs, Buffer.from([0])]);
}

/** Attribute list text -> { cid, fctn, uacn, host, port } or null. */
export function parseAdvert(buf) {
  const text = buf.toString('latin1');
  const attr = (name) => {
    const m = new RegExp(`\\(${name}=([^)]*)\\)`, 'i').exec(text);
    return m ? m[1] : null;
  };
  const cid = cidFromString(attr('cid'));
  const fctn = attr('acn-fctn');
  const sdt = /esta\.sdt\/([\d.]+):(\d+)/i.exec(attr('csl-esta.dmp') ?? '');
  if (!cid || !fctn || !sdt) return null;
  return {
    cid,
    fctn,
    uacn: attr('acn-uacn') ?? fctn,
    host: sdt[1],
    port: Number(sdt[2]),
  };
}

/**
 * A long-lived listener. `devices()` lists units heard recently; `cidFor(host)`
 * waits up to `timeoutMs` for one to be heard.
 */
export class SlpListener {
  #socket = null;
  #seen = new Map(); // host -> { advert, at }
  #waiters = new Set();
  #starting = null;

  constructor({ port = SLP_PORT, multicast = true, log = () => {} } = {}) {
    this.port = port;
    this.multicast = multicast;
    this.log = log;
  }

  start() {
    this.#starting ??= new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('message', (msg) => this.#heard(msg));
      socket.on('error', (err) => {
        // another program holding the port without SO_REUSEADDR: discovery is
        // then unavailable, but adding a unit by address still works
        this.log(`SLP listener unavailable: ${err.message}`);
        resolve(false);
      });
      socket.bind(this.port, () => {
        if (this.multicast) {
          for (const address of localIPv4s()) {
            try {
              socket.addMembership(SLP_GROUP, address);
            } catch {
              // an interface that cannot join is simply not listened on
            }
          }
        }
        socket.unref();
        this.#socket = socket;
        resolve(true);
      });
    });
    return this.#starting;
  }

  /** AXT600s heard in the last few adverts. */
  devices() {
    const now = Date.now();
    return [...this.#seen.values()]
      .filter((s) => now - s.at < FORGET_AFTER_MS && /^AXT600/i.test(s.advert.fctn))
      .map((s) => s.advert);
  }

  /** The advert for this host, waiting for one if none has been heard yet. */
  async advertFor(host, timeoutMs = 9_000) {
    await this.start();
    const known = this.#seen.get(host);
    if (known && Date.now() - known.at < FORGET_AFTER_MS) return known.advert;
    return new Promise((resolve) => {
      const waiter = { host, resolve };
      waiter.timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  /** Multicast an advert from the SLP port, out of the interface at `from`. */
  async advertise(packet, from) {
    await this.start();
    const target = this.multicast ? [SLP_GROUP, SLP_PORT] : ['127.0.0.1', this.port];
    const socket = this.#socket;
    if (!socket) return false;
    try {
      if (this.multicast && from) socket.setMulticastInterface(from);
      await new Promise((resolve, reject) =>
        socket.send(packet, target[1], target[0], (err) => (err ? reject(err) : resolve()))
      );
      return true;
    } catch (err) {
      this.log(`could not send the SLP advert: ${err.message}`);
      return false;
    }
  }

  close() {
    for (const w of this.#waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.#waiters.clear();
    try {
      this.#socket?.close();
    } catch {
      // already closed
    }
    this.#socket = null;
    this.#starting = null;
  }

  #heard(msg) {
    const advert = parseAdvert(msg);
    if (!advert) return;
    this.#seen.set(advert.host, { advert, at: Date.now() });
    for (const w of [...this.#waiters]) {
      if (w.host === advert.host) {
        clearTimeout(w.timer);
        this.#waiters.delete(w);
        w.resolve(advert);
      }
    }
  }
}

function localIPv4s() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}
