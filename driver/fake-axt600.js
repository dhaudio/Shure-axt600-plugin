// A fake AXT600 on loopback, speaking the device side of the same ACN the real
// unit does, so the network link is tested end to end with nothing attached:
// SLP adverts, the SDT join both ways, DMP connect, keepalives, property
// reads and writes, and a scan reported the way the captures show it.
//
// It answers in the shapes recorded from a unit on firmware 2.1.41: GET
// replies per property, no reply to a SET, a GET_FAIL for the sync probe,
// scan data as ranges of int16 at 0x10000000 + index, progress in steps of 5.

import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import {
  DMP,
  PROTO_DMP,
  PROTO_SDT,
  SDT,
  clientBlock,
  join,
  joinAccept,
  parseDmp,
  parseJoin,
  parseJoinAccept,
  parsePacket,
  parseSdtInner,
  parseWrapper,
  pdu,
  rootPacket,
  sdtInner,
  u32,
} from './acn.js';
import { simulatedLevel } from './simulated-axt600.js';
import { estimateScanMs } from './scan-plan.js';

const MODULES = 8;
const TILE_POINTS = 51;

const str = (s) => {
  const b = Buffer.alloc(2 + s.length);
  b.writeUInt16BE(b.length, 0);
  b.write(s, 2, 'latin1');
  return b;
};

export async function startFakeAxt600({
  slpPort = null,
  name = 'AXT600',
  timeScale = 0.002,
  refuseJoin = false,
  skip = null, // [fromHz, toHz]: a band the unit never reports, as a real one did
  scanningAtStart = false, // as if another controller left it scanning
  ignoreJoins = 0, // drop this many JOINs, as a unit that has not heard of us
} = {}) {
  const cid = Buffer.concat([randomBytes(4), Buffer.from('000011dda000000eddcccccc', 'hex')]);
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const port = socket.address().port;

  const props = new Map([
    [0x01000012, str('AXT600')],
    [0x01000000, str('AXT600')],
    [0x01000004, Buffer.from('0002000100290000', 'hex')],
    [0x01070220, str(';25;200;1000')],
    [0x01070201, u32(470_000)],
    [0x01070202, u32(25)],
    [0x0107010f, Buffer.from([0])],
    [0x01070210, Buffer.from([1])],
    [0x01070200, Buffer.from([0])],
  ]);
  const scan = { startKhz: 470_000, stopKhz: 952_000, stepKhz: 25 };
  const state = {
    peer: null, // { address, port, cid }
    channel: 1 + (randomBytes(2).readUInt16BE(0) % 0xfffe),
    total: 0,
    reliable: 0,
    leaderChannel: null,
    midForLeader: null,
    ourMidInLeader: null,
    subscribed: new Set(),
    sets: [],
    joins: 0,
    left: false,
  };
  state.total = state.reliable = state.channel;
  const timers = new Set();
  const after = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  let scanning = false;
  let keepalive = null;

  const send = (sdtPdu) => {
    if (!state.peer) return;
    socket.send(rootPacket(cid, [sdtPdu]), state.peer.port, state.peer.address);
  };
  const wrap = (reliable, blocks, mak = false) => {
    state.total += 1;
    if (reliable) state.reliable += 1;
    send(
      pdu(reliable ? SDT.REL_WRAP : SDT.UNREL_WRAP, 1, null, Buffer.concat([
        (() => {
          const h = Buffer.alloc(20);
          h.writeUInt16BE(state.channel, 0);
          h.writeUInt32BE(state.total >>> 0, 2);
          h.writeUInt32BE(state.reliable >>> 0, 6);
          h.writeUInt32BE(state.reliable >>> 0, 10);
          h.writeUInt16BE(mak ? state.midForLeader : 0xffff, 14);
          h.writeUInt16BE(mak ? state.midForLeader : 0xffff, 16);
          return h;
        })(),
        ...blocks,
      ]))
    );
  };
  const dmpBlock = (payload, mid = 0xffff) =>
    clientBlock({ mid, protocol: PROTO_DMP, payload });
  const dmpOne = (vector, address, value = null) =>
    pdu(vector, 1, Buffer.from([0x02]), Buffer.concat([u32(address), value ?? Buffer.alloc(0)]));
  const event = (address, value) => {
    if (state.subscribed.has(address)) wrap(true, [dmpBlock(dmpOne(DMP.EVENT, address, value))]);
  };

  socket.on('message', (msg, rinfo) => {
    const roots = parsePacket(msg);
    if (!roots) return;
    for (const root of roots) {
      for (const { vector, data } of root.sdt) handle(vector, data, root.cid, rinfo);
    }
  });

  function handle(vector, data, sender, rinfo) {
    if (vector === SDT.JOIN) {
      const j = parseJoin(data);
      if (!j.memberCid.equals(cid)) return;
      state.joins += 1;
      if (state.joins <= ignoreJoins) return;
      state.peer = { address: rinfo.address, port: rinfo.port, cid: sender };
      if (refuseJoin) {
        const refuse = Buffer.alloc(25);
        sender.copy(refuse, 0);
        refuse.writeUInt16BE(j.channel, 16);
        refuse.writeUInt16BE(j.mid, 18);
        refuse.writeUInt32BE(j.reliable, 20);
        refuse[24] = 4; // already a member
        send(pdu(SDT.JOIN_REFUSE, 1, null, refuse));
        return;
      }
      state.leaderChannel = j.channel;
      state.ourMidInLeader = j.mid;
      state.left = false;
      send(joinAccept({ leaderCid: sender, channel: j.channel, mid: j.mid, reliable: j.reliable, reciprocal: state.channel }));
      state.midForLeader = 1;
      send(
        join({
          memberCid: sender,
          mid: state.midForLeader,
          channel: state.channel,
          reciprocal: j.channel,
          total: state.total,
          reliable: state.reliable,
        })
      );
      return;
    }
    if (vector === SDT.JOIN_ACCEPT) {
      parseJoinAccept(data);
      clearInterval(keepalive);
      keepalive = setInterval(() => wrap(false, [], true), 1_500);
      return;
    }
    if (vector !== SDT.REL_WRAP && vector !== SDT.UNREL_WRAP) return;
    const w = parseWrapper(data);
    if (w.channel !== state.leaderChannel) return;
    if (w.firstMak !== 0xffff && w.firstMak <= state.ourMidInLeader && state.ourMidInLeader <= w.lastMak) {
      wrap(false, [
        clientBlock({ mid: state.midForLeader, protocol: PROTO_SDT, association: state.leaderChannel, payload: sdtInner(SDT.ACK, u32(w.reliableSeq)) }),
      ]);
    }
    for (const block of w.blocks) {
      if (block.protocol === PROTO_SDT) {
        for (const inner of parseSdtInner(block.payload)) onSdt(inner);
      } else if (block.protocol === PROTO_DMP) {
        onDmp(parseDmp(block.payload));
      }
    }
  }

  function onSdt({ vector }) {
    if (vector === SDT.CONNECT) {
      wrap(true, [clientBlock({ mid: state.midForLeader, protocol: PROTO_SDT, association: state.leaderChannel, payload: sdtInner(SDT.CONNECT_ACCEPT, u32(PROTO_DMP)) })]);
      wrap(true, [clientBlock({ mid: state.midForLeader, protocol: PROTO_SDT, payload: sdtInner(SDT.CONNECT, u32(PROTO_DMP)) })]);
    } else if (vector === SDT.LEAVE) {
      state.left = true;
      stopScan();
      clearInterval(keepalive);
      wrap(true, [clientBlock({ mid: state.midForLeader, protocol: PROTO_SDT, payload: sdtInner(SDT.LEAVING, Buffer.alloc(0)) })]);
    }
  }

  function onDmp(items) {
    const replies = [];
    for (const item of items) {
      switch (item.vector) {
        case DMP.GET:
          if (item.address === 0x01070131) replies.push(dmpOne(DMP.GET_REPLY, item.address, Buffer.from([scanning ? 1 : 0])));
          else if (props.has(item.address)) replies.push(dmpOne(DMP.GET_REPLY, item.address, props.get(item.address)));
          else replies.push(pdu(DMP.GET_FAIL, 1, Buffer.from([item.address > 0xff ? 0x02 : 0x00]),
            Buffer.concat([item.address > 0xff ? u32(item.address) : Buffer.from([item.address]), Buffer.from([1])])));
          break;
        case DMP.SET:
          // a real unit refused the scan settings with reason 5 while scanning
          if (scanning && item.address >= 0x01070100 && item.address <= 0x01070109 && item.address !== 0x01070103) {
            state.refused = (state.refused ?? 0) + 1;
            replies.push(pdu(DMP.SET_FAIL, 1, Buffer.from([0x02]), Buffer.concat([u32(item.address), Buffer.from([5])])));
            break;
          }
          state.sets.push([item.address, Buffer.from(item.value)]);
          applySet(item.address, item.value);
          break;
        case DMP.SUBSCRIBE:
          state.subscribed.add(item.address);
          replies.push(dmpOne(DMP.SUBSCRIBE_ACCEPT, item.address));
          break;
        case DMP.UNSUBSCRIBE:
          state.subscribed.delete(item.address);
          break;
        default:
      }
    }
    if (replies.length) wrap(true, [dmpBlock(Buffer.concat(replies), state.midForLeader)]);
  }

  function applySet(address, value) {
    if (address === 0x01070100) scan.startKhz = value.readUInt32BE(0);
    else if (address === 0x01070101) scan.stopKhz = value.readUInt32BE(0);
    else if (address === 0x01070102) scan.stepKhz = value.readUInt32BE(0);
    else if (address === 0x01070103) startScan();
    else if (address === 0x0107010e) stopScan();
  }

  function startScan() {
    if (scanning) return;
    scanning = true;
    event(0x01070110, Buffer.from([0]));
    event(0x01070131, Buffer.from([1]));
    pass();
  }

  function stopScan() {
    if (!scanning) return;
    scanning = false;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    event(0x01070131, Buffer.from([0]));
  }

  function pass() {
    if (!scanning) return;
    const stepHz = scan.stepKhz * 1000;
    const startHz = scan.startKhz * 1000;
    const count = Math.floor((scan.stopKhz - scan.startKhz) / scan.stepKhz) + 1;
    const passMs = Math.max(30, estimateScanMs((count - 1) * stepHz, stepHz) * timeScale);
    const perModule = Math.ceil(count / MODULES);
    const levelA = new Array(count);
    const tiles = [];
    for (let half = 0; half < 2; half += 1) {
      for (let m = 0; m < MODULES; m += 1) {
        for (let from = m * perModule; from < Math.min(count, (m + 1) * perModule); from += TILE_POINTS) {
          const n = Math.min(TILE_POINTS, (m + 1) * perModule - from, count - from);
          tiles.push({ half, from, n, m });
        }
      }
    }
    // modules interleave; the two halves follow one another
    tiles.sort((a, b) => a.half - b.half || a.from - a.m * perModule - (b.from - b.m * perModule) || a.m - b.m);
    tiles.forEach((tile, k) => {
      after((passMs * (k + 1)) / (tiles.length + 1), () => {
        if (!scanning) return;
        // the points of this tile, split into runs around any band it skips
        const runs = [];
        for (let i = 0; i < tile.n; i += 1) {
          const idx = tile.from + i;
          const hz = startHz + idx * stepHz;
          let v;
          if (tile.half === 0) v = levelA[idx] = simulatedLevel(hz, 0, stepHz);
          else v = Math.max(levelA[idx], simulatedLevel(hz, 1, stepHz));
          if (skip && hz >= skip[0] && hz <= skip[1]) continue;
          const run = runs[runs.length - 1];
          if (run && run.from + run.values.length === idx) run.values.push(v);
          else runs.push({ from: idx, values: [v] });
        }
        if (!state.subscribed.has(0x1fffffff)) return;
        for (const run of runs) {
          const values = Buffer.alloc(run.values.length * 2);
          run.values.forEach((v, i) => values.writeInt16BE(Math.round(v * 10), 2 * i));
          const head = Buffer.concat([u32(0x10000000 + run.from), u32(1), u32(run.values.length)]);
          wrap(true, [dmpBlock(pdu(DMP.EVENT, 1, Buffer.from([0x22]), Buffer.concat([head, values])))]);
        }
        const pct = Math.floor(((k + 1) / tiles.length) * 20) * 5;
        if (pct > (state.lastPct ?? -1) && pct % 5 === 0) {
          state.lastPct = pct;
          event(0x01070110, Buffer.from([pct]));
        }
      });
    });
    after(passMs, () => {
      if (!scanning) return;
      if ((state.lastPct ?? 0) < 100) event(0x01070110, Buffer.from([100]));
      state.lastPct = -1;
      pass();
    });
  }

  if (scanningAtStart) {
    scanning = true;
    pass();
  }

  // SLP adverts, to a loopback port in tests
  const advert = Buffer.from(
    `\x02\x07\x00\x015\x00\x00\x00\x00\x00"=\x00\x02en\x00\x00\x01 ` +
      `(cid=${cid.toString('hex').toUpperCase().replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')}),` +
      `(acn-fctn=AXT600),(acn-uacn=${name}),(acn-services=esta.dmp),` +
      `(csl-esta.dmp=esta.sdt/127.0.0.1:${port};esta.dmp/cd:CCC57006-E139-11DF-9451-0015C5F3F612)\x00`,
    'latin1'
  );
  const slpSocket = dgram.createSocket('udp4');
  let advertiser = null;
  if (slpPort) {
    const tell = () => slpSocket.send(advert, slpPort, '127.0.0.1');
    tell();
    advertiser = setInterval(tell, 200);
  }

  return {
    host: '127.0.0.1',
    port,
    cid,
    state,
    scan,
    get scanning() {
      return scanning;
    },
    /** stop answering altogether, as a unit that is unplugged */
    silence() {
      stopScan();
      clearInterval(keepalive);
      socket.removeAllListeners('message');
    },
    async close() {
      stopScan();
      clearInterval(keepalive);
      clearInterval(advertiser);
      for (const t of timers) clearTimeout(t);
      await new Promise((r) => socket.close(r));
      await new Promise((r) => slpSocket.close(r));
    },
  };
}
