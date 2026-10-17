// Finding AXT600s from their SLP adverts.
//
// Every ~4 s an AXT600 multicasts an SLPv2 attribute reply to
// 239.255.254.253:8427 that carries everything a session needs:
//
//   (cid=A1B2C3D4-0000-11DD-A000-000EDDCCCCCC),(acn-fctn=AXT600),
//   (acn-uacn=AXT600),(csl-esta.dmp=esta.sdt/192.168.1.3:57383;…)
//
// This only listens. It sends nothing, so it never disturbs a show network.

import dgram from 'node:dgram';
import os from 'node:os';
import { cidFromString } from './acn.js';

export const SLP_GROUP = '239.255.254.253';
export const SLP_PORT = 8427;
const FORGET_AFTER_MS = 15_000;

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
