// One SDT session with an AXT600, as a controller: join, DMP connect,
// keepalive, acknowledgement, property access, and a clean leave.
//
// The sequence is the one Wireless Workbench uses, read from captures of it
// talking to a real unit:
//
//   us -> JOIN (our channel)          device -> JOIN_ACCEPT
//   device -> JOIN (its channel)      us -> JOIN_ACCEPT
//   both -> ACK of the other's starting sequence
//   us -> CONNECT DMP                 device -> CONNECT_ACCEPT
//   device -> CONNECT DMP             us -> CONNECT_ACCEPT
//   then DMP both ways, and every ~1.4 s an empty wrapper asking for an ACK
//
// Everything goes to the device's SDT port from one local UDP port; the device
// answers to wherever the packets came from.

import dgram from 'node:dgram';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  DMP,
  PROTO_DMP,
  PROTO_SDT,
  SDT,
  clientBlock,
  dmpPdus,
  join,
  joinAccept,
  parseDmp,
  parseJoin,
  parseJoinAccept,
  parseJoinRefuse,
  parsePacket,
  parseSdtInner,
  parseWrapper,
  randomCid,
  rootPacket,
  sdtInner,
  syncProbe,
  u32,
  wrapper,
} from './acn.js';

export const DEFAULT_SDT_PORT = 57383;

const DEVICE_MID = 1; // the member id we give the device in our channel
const KEEPALIVE_MS = 1_400;
const ACK_DELAY_MS = 60;
const SILENCE_LIMIT_MS = 6_000;
const STEP_TIMEOUT_MS = 4_000;

export class SessionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

export class SdtSession {
  #socket = null;
  #timers = new Set();
  #keepalive = null;
  #ackTimer = null;
  #waiters = [];
  #lastHeard = 0;
  #closed = false;

  /**
   * @param host       the device's address
   * @param port       its SDT port (57383 unless its advert says otherwise)
   * @param deviceCid  its component id, 16 bytes (from its SLP advert)
   * @param log        (line) => void, for milestones a person may need
   */
  constructor({ host, port = DEFAULT_SDT_PORT, deviceCid, log = () => {}, randomBytes = nodeRandomBytes }) {
    this.host = host;
    this.port = port;
    this.deviceCid = deviceCid;
    this.log = log;
    this.cid = randomCid(randomBytes);
    this.channel = 1 + (randomBytes(2).readUInt16BE(0) % 0xfffe);
    this.total = this.channel;
    this.reliable = this.channel;
    this.oldest = this.channel;
    this.deviceChannel = null;
    this.deviceMidForUs = null;
    this.deviceReliable = null;
    this.ackedDeviceReliable = null;
    this.dmpConnected = false;
    /** (items) => void for every DMP message the device sends */
    this.onDmp = null;
    /** (err) => void when the session dies by itself */
    this.onFatal = null;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async open() {
    try {
      await this.#open();
    } catch (err) {
      // a session that never opened leaves nothing behind: no socket, no timers
      this.#shutdown(err);
      throw err;
    }
  }

  async #open() {
    this.#socket = dgram.createSocket('udp4');
    this.#socket.on('message', (msg, rinfo) => {
      if (rinfo.address !== this.host) return;
      this.#receive(msg);
    });
    this.#socket.on('error', (err) => this.#die(err));
    await new Promise((resolve, reject) => {
      this.#socket.once('error', reject);
      this.#socket.bind(0, () => {
        this.#socket.off('error', reject);
        resolve();
      });
    });

    // 1. our channel: JOIN, and the device's JOIN_ACCEPT
    const accepted = this.#wait(
      (e) => e.type === 'join-accept' || e.type === 'join-refuse',
      'the AXT600 to accept the session'
    );
    const theirJoin = this.#wait((e) => e.type === 'join', 'the AXT600 to open its channel');
    // awaited later; if an earlier step fails, its rejection is not a second error
    theirJoin.catch(() => {});
    this.#sendRoot(
      join({
        memberCid: this.deviceCid,
        mid: DEVICE_MID,
        channel: this.channel,
        total: this.total,
        reliable: this.reliable,
      })
    );
    const answer = await accepted;
    if (answer.type === 'join-refuse') {
      throw new SessionError(
        `The AXT600 refused the session (reason ${answer.reason ?? 'unknown'}). ` +
          `Another controller may be connected: quit Wireless Workbench and try again.`,
        'join_refused'
      );
    }
    this.deviceChannel = answer.reciprocal;
    this.log('JOINED');

    // 2. the device's channel to us
    const j = await theirJoin;
    this.deviceChannel = j.channel;
    this.deviceMidForUs = j.mid;
    this.deviceReliable = j.reliable;
    this.#sendRoot(
      joinAccept({
        leaderCid: this.deviceCid,
        channel: j.channel,
        mid: j.mid,
        reliable: j.reliable,
        reciprocal: this.channel,
      })
    );
    this.#sendAck();

    // 3. DMP, in both directions
    const connectAccepted = this.#wait(
      (e) => e.type === 'sdt' && e.vector === SDT.CONNECT_ACCEPT,
      'the AXT600 to accept DMP'
    );
    this.#sendWrapper(true, [
      clientBlock({ mid: DEVICE_MID, protocol: PROTO_SDT, payload: sdtInner(SDT.CONNECT, u32(PROTO_DMP)) }),
    ]);
    await connectAccepted;
    this.dmpConnected = true;
    this.log('CONNECTED');

    this.#lastHeard = Date.now();
    this.#keepalive = setInterval(() => this.#tick(), KEEPALIVE_MS);
  }

  /** Leave cleanly: disconnect DMP, ask the device to leave our channel. */
  async close() {
    if (this.#closed) return;
    const socket = this.#socket;
    if (socket && this.deviceChannel !== null) {
      try {
        this.#sendWrapper(true, [
          clientBlock({ mid: DEVICE_MID, protocol: PROTO_SDT, payload: sdtInner(SDT.DISCONNECT, u32(PROTO_DMP)) }),
          clientBlock({ mid: DEVICE_MID, protocol: PROTO_SDT, payload: sdtInner(SDT.LEAVE) }),
        ]);
        await new Promise((r) => setTimeout(r, 150));
      } catch {
        // the socket may already be gone; leaving is best effort
      }
    }
    this.#shutdown();
    this.log('LEFT');
  }

  // -------------------------------------------------------------------------
  // DMP
  // -------------------------------------------------------------------------

  /** Read properties. Resolves to Map(address -> Buffer | null on failure). */
  async get(addresses) {
    const pending = new Set(addresses);
    const values = new Map();
    const done = this.#wait((e) => {
      if (e.type !== 'dmp') return false;
      for (const item of e.items) {
        if ((item.vector === DMP.GET_REPLY || item.vector === DMP.GET_FAIL) && pending.has(item.address)) {
          values.set(item.address, item.vector === DMP.GET_REPLY ? item.value : null);
          pending.delete(item.address);
        }
      }
      return pending.size === 0;
    }, `the AXT600 to answer a read of ${addresses.map(hex).join(', ')}`);
    this.#sendDmp(dmpPdus(DMP.GET, addresses));
    await done;
    return values;
  }

  /**
   * Write properties: [[address, valueBuffer], …]. The device does not reply to
   * a SET, so a sync probe follows and its GET_FAIL says they were processed.
   * A SET_FAIL for any of them rejects.
   */
  async set(items) {
    const addresses = new Set(items.map(([a]) => a));
    const failures = [];
    const done = this.#wait((e) => {
      if (e.type !== 'dmp') return false;
      for (const item of e.items) {
        if (item.vector === DMP.SET_FAIL && addresses.has(item.address)) failures.push(item);
        if (item.vector === DMP.GET_FAIL && item.address === 0) return true;
      }
      return false;
    }, 'the AXT600 to take new settings');
    this.#sendDmp(Buffer.concat([dmpPdus(DMP.SET, items), syncProbe()]));
    await done;
    if (failures.length) {
      throw new SessionError(
        `The AXT600 refused ${failures.map((f) => `${hex(f.address)} (reason ${f.reason})`).join(', ')}`,
        'set_refused'
      );
    }
  }

  /** Subscribe, resolving once every address is accepted or rejected. */
  async subscribe(addresses) {
    const pending = new Set(addresses);
    const rejected = [];
    const done = this.#wait((e) => {
      if (e.type !== 'dmp') return false;
      for (const item of e.items) {
        if (item.vector === DMP.SUBSCRIBE_ACCEPT || item.vector === DMP.SUBSCRIBE_REJECT) {
          if (pending.delete(item.address) && item.vector === DMP.SUBSCRIBE_REJECT) rejected.push(item.address);
        }
      }
      return pending.size === 0;
    }, 'the AXT600 to accept subscriptions');
    this.#sendDmp(dmpPdus(DMP.SUBSCRIBE, addresses));
    await done;
    return rejected;
  }

  /** Unsubscribe; fire and forget, followed by a sync probe like WWB's. */
  unsubscribe(addresses) {
    this.#sendDmp(Buffer.concat([dmpPdus(DMP.UNSUBSCRIBE, addresses), syncProbe()]));
  }

  // -------------------------------------------------------------------------
  // wire
  // -------------------------------------------------------------------------

  #sendDmp(payload) {
    if (!this.dmpConnected) throw new SessionError('DMP is not connected', 'not_connected');
    this.#sendWrapper(true, [clientBlock({ mid: DEVICE_MID, protocol: PROTO_DMP, payload })]);
  }

  #sendWrapper(reliable, blocks, { mak = false } = {}) {
    this.total += 1;
    if (reliable) this.reliable += 1;
    this.#sendRoot(
      wrapper({
        reliable,
        channel: this.channel,
        total: this.total,
        reliableSeq: this.reliable,
        oldest: this.oldest,
        firstMak: mak ? DEVICE_MID : 0xffff,
        lastMak: mak ? DEVICE_MID : 0xffff,
        blocks,
      })
    );
    // we keep no history to resend, so nothing older is available
    this.oldest = this.reliable;
  }

  #sendAck() {
    if (this.deviceReliable === null || this.deviceChannel === null) return;
    this.ackedDeviceReliable = this.deviceReliable;
    this.#sendWrapper(false, [
      clientBlock({
        mid: DEVICE_MID,
        protocol: PROTO_SDT,
        association: this.deviceChannel,
        payload: sdtInner(SDT.ACK, u32(this.deviceReliable)),
      }),
    ]);
  }

  #scheduleAck() {
    if (this.#ackTimer) return;
    this.#ackTimer = setTimeout(() => {
      this.#ackTimer = null;
      if (!this.#closed) this.#sendAck();
    }, ACK_DELAY_MS);
  }

  #sendRoot(sdtPdu) {
    if (!this.#socket || this.#closed) return;
    this.#socket.send(rootPacket(this.cid, [sdtPdu]), this.port, this.host);
  }

  #tick() {
    if (Date.now() - this.#lastHeard > SILENCE_LIMIT_MS) {
      this.#die(new SessionError(`The AXT600 at ${this.host} stopped answering.`, 'silent'));
      return;
    }
    this.#sendWrapper(false, [], { mak: true });
  }

  #receive(msg) {
    const roots = parsePacket(msg);
    if (!roots) return;
    this.#lastHeard = Date.now();
    for (const root of roots) {
      if (!root.cid.equals(this.deviceCid)) continue;
      for (const { vector, data } of root.sdt) {
        try {
          this.#handleSdt(vector, data);
        } catch (err) {
          this.log(`ignored a malformed packet: ${err.message}`);
        }
      }
    }
  }

  #handleSdt(vector, data) {
    switch (vector) {
      case SDT.JOIN_ACCEPT:
        this.#emit({ type: 'join-accept', ...parseJoinAccept(data) });
        return;
      case SDT.JOIN_REFUSE:
        this.#emit({ type: 'join-refuse', ...parseJoinRefuse(data) });
        return;
      case SDT.JOIN: {
        const j = parseJoin(data);
        if (!j.memberCid.equals(this.cid)) return;
        this.#emit({ type: 'join', ...j });
        return;
      }
      case SDT.REL_WRAP:
      case SDT.UNREL_WRAP:
        this.#handleWrapper(vector === SDT.REL_WRAP, parseWrapper(data));
        return;
      default:
    }
  }

  #handleWrapper(reliable, w) {
    if (this.deviceChannel !== null && w.channel !== this.deviceChannel) return;
    if (reliable) {
      this.deviceReliable = w.reliableSeq;
      this.#scheduleAck();
    }
    const mid = this.deviceMidForUs ?? 1;
    if (w.firstMak !== 0xffff && w.firstMak <= mid && mid <= w.lastMak) this.#scheduleAck();

    for (const block of w.blocks) {
      if (block.mid !== mid && block.mid !== 0xffff) continue;
      if (block.protocol === PROTO_SDT) {
        for (const inner of parseSdtInner(block.payload)) this.#handleInner(inner);
      } else if (block.protocol === PROTO_DMP) {
        const items = parseDmp(block.payload);
        this.#emit({ type: 'dmp', items });
        this.onDmp?.(items);
      }
    }
  }

  #handleInner({ vector, data }) {
    if (vector === SDT.CONNECT && data.readUInt32BE(0) === PROTO_DMP) {
      this.#sendWrapper(true, [
        clientBlock({
          mid: DEVICE_MID,
          protocol: PROTO_SDT,
          association: this.deviceChannel,
          payload: sdtInner(SDT.CONNECT_ACCEPT, u32(PROTO_DMP)),
        }),
      ]);
    } else if (vector === SDT.LEAVING || vector === SDT.DISCONNECTING || vector === SDT.LEAVE) {
      if (!this.#closed && this.dmpConnected) {
        this.#die(new SessionError(`The AXT600 at ${this.host} ended the session.`, 'ended'));
      }
      return;
    }
    this.#emit({ type: 'sdt', vector, data });
  }

  // -------------------------------------------------------------------------
  // waiting
  // -------------------------------------------------------------------------

  #wait(match, what, timeoutMs = STEP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new SessionError(`Timed out waiting for ${what}.`, 'timeout'));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  #emit(event) {
    for (const waiter of [...this.#waiters]) {
      let matched = false;
      try {
        matched = waiter.match(event);
      } catch {
        matched = false;
      }
      if (matched) {
        clearTimeout(waiter.timer);
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        waiter.resolve(event);
      }
    }
  }

  #die(err) {
    if (this.#closed) return;
    const fatal = this.onFatal;
    this.#shutdown(err);
    fatal?.(err);
  }

  #shutdown(err = new SessionError('session closed', 'closed')) {
    this.#closed = true;
    clearInterval(this.#keepalive);
    clearTimeout(this.#ackTimer);
    for (const w of this.#waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    try {
      this.#socket?.close();
    } catch {
      // already closed
    }
    this.#socket = null;
    this.onFatal = null;
  }
}

const hex = (a) => `0x${a.toString(16).padStart(8, '0')}`;
