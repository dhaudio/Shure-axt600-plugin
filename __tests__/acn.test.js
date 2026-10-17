// The ACN encoder and decoder against real traffic.
//
// fixtures/wwb-axt600.json holds datagrams captured between Wireless Workbench
// and an AXT600 (firmware 2.1.41). Every packet Wireless Workbench sent is
// rebuilt here from its fields with this plugin's encoder and must come out
// byte for byte the same; every packet the AXT600 sent must decode to what it
// meant. If a change to driver/acn.js breaks one of these, it breaks talking to
// the hardware.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DMP,
  PROTO_DMP,
  PROTO_SDT,
  SDT,
  clientBlock,
  decodeString,
  dmpPdus,
  join,
  joinAccept,
  parseDmp,
  parseJoin,
  parseJoinAccept,
  parsePacket,
  parseSdtInner,
  parseWrapper,
  rootPacket,
  sdtInner,
  syncProbe,
  u32,
  u8,
  wrapper,
} from '../driver/acn.js';

const fx = Object.fromEntries(
  Object.entries(
    JSON.parse(
      readFileSync(new URL('./fixtures/wwb-axt600.json', import.meta.url), 'utf8')
    )
  ).map(([k, v]) => [k, Buffer.from(v, 'hex')])
);

const WWB_CID = Buffer.from('d34c5e9d000011dda000000eddcccccc', 'hex');
const AXT_CID = Buffer.from('a1b2c3d4000011dda000000eddcccccc', 'hex');

const only = (buf) => {
  const roots = parsePacket(buf);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].sdt.length, 1);
  return { cid: roots[0].cid, ...roots[0].sdt[0] };
};

/** Rebuild a captured wrapper from its parsed header plus the given blocks. */
const rewrap = (captured, blocks) => {
  const { vector, data, cid } = only(captured);
  const w = parseWrapper(data);
  return rootPacket(cid, [
    wrapper({ ...w, reliable: vector === SDT.REL_WRAP, blocks }),
  ]);
};

test('the join is rebuilt byte for byte', () => {
  const { cid, vector, data } = only(fx.wwb_join);
  assert.equal(vector, SDT.JOIN);
  assert.ok(cid.equals(WWB_CID));
  const j = parseJoin(data);
  assert.ok(j.memberCid.equals(AXT_CID));
  assert.deepEqual(
    rootPacket(WWB_CID, [join({ ...j, memberCid: AXT_CID })]),
    fx.wwb_join
  );
});

test('the device accepts, and joins back', () => {
  const accept = only(fx.device_join_accept);
  assert.equal(accept.vector, SDT.JOIN_ACCEPT);
  const a = parseJoinAccept(accept.data);
  assert.ok(a.leaderCid.equals(WWB_CID));
  assert.equal(a.mid, 1);

  const back = only(fx.device_join);
  assert.equal(back.vector, SDT.JOIN);
  const j = parseJoin(back.data);
  assert.equal(j.reciprocal, a.channel); // the device's join names our channel
  assert.equal(j.channel, a.reciprocal); // and its own is the one it accepted with

  const ours = parseJoinAccept(only(fx.wwb_join_accept).data);
  assert.deepEqual(
    rootPacket(WWB_CID, [
      joinAccept({
        leaderCid: AXT_CID,
        channel: j.channel,
        mid: j.mid,
        reliable: j.reliable,
        reciprocal: j.reciprocal,
      }),
    ]),
    fx.wwb_join_accept
  );
  assert.equal(ours.reliable, j.reliable);
});

test('ACK, CONNECT and CONNECT_ACCEPT are rebuilt byte for byte', () => {
  const ack = parseWrapper(only(fx.wwb_ack).data);
  const ackSeq = parseSdtInner(ack.blocks[0].payload)[0].data.readUInt32BE(0);
  assert.deepEqual(
    rewrap(fx.wwb_ack, [
      clientBlock({
        mid: 1,
        protocol: PROTO_SDT,
        association: ack.blocks[0].association,
        payload: sdtInner(SDT.ACK, u32(ackSeq)),
      }),
    ]),
    fx.wwb_ack
  );

  assert.deepEqual(
    rewrap(fx.wwb_connect, [
      clientBlock({
        mid: 1,
        protocol: PROTO_SDT,
        payload: sdtInner(SDT.CONNECT, u32(PROTO_DMP)),
      }),
    ]),
    fx.wwb_connect
  );

  const ca = parseWrapper(only(fx.wwb_connect_accept).data);
  assert.deepEqual(
    rewrap(fx.wwb_connect_accept, [
      clientBlock({
        mid: 1,
        protocol: PROTO_SDT,
        association: ca.blocks[0].association,
        payload: sdtInner(SDT.CONNECT_ACCEPT, u32(PROTO_DMP)),
      }),
    ]),
    fx.wwb_connect_accept
  );

  const dev = parseWrapper(only(fx.device_connect_accept).data);
  const inner = parseSdtInner(dev.blocks[0].payload)[0];
  assert.equal(inner.vector, SDT.CONNECT_ACCEPT);
  assert.equal(inner.data.readUInt32BE(0), PROTO_DMP);
});

test('the keepalive is an empty wrapper asking member 1 to acknowledge', () => {
  const w = parseWrapper(only(fx.wwb_keepalive).data);
  assert.equal(w.blocks.length, 0);
  assert.equal(w.firstMak, 1);
  assert.equal(w.lastMak, 1);
  assert.deepEqual(rewrap(fx.wwb_keepalive, []), fx.wwb_keepalive);
});

test('subscriptions are rebuilt byte for byte', () => {
  const addresses = [
    0x01000012, 0x01000023, 0x01000024, 0x01000025, 0x01000026, 0x01000028,
    0x0100002b, 0x01010101, 0x01010102, 0x01010103,
  ];
  assert.deepEqual(
    rewrap(fx.wwb_subscribe, [
      clientBlock({
        mid: 1,
        protocol: PROTO_DMP,
        payload: dmpPdus(DMP.SUBSCRIBE, addresses),
      }),
    ]),
    fx.wwb_subscribe
  );
});

test('the scan settings, start and stop are rebuilt byte for byte', () => {
  const mid = parseWrapper(only(fx.wwb_set_scan).data).blocks[0].mid;
  assert.deepEqual(
    rewrap(fx.wwb_set_scan, [
      clientBlock({
        mid,
        protocol: PROTO_DMP,
        payload: dmpPdus(DMP.SET, [
          [0x01070100, u32(470_000)], // start, kHz
          [0x01070101, u32(952_000)], // stop, kHz
          [0x01070102, u32(25)], // step, kHz
          [0x01070108, u32(25)], // resolution, kHz
          [0x01070109, u8(0xff)],
        ]),
      }),
    ]),
    fx.wwb_set_scan
  );
  assert.deepEqual(
    rewrap(fx.wwb_set_start, [
      clientBlock({
        mid,
        protocol: PROTO_DMP,
        payload: dmpPdus(DMP.SET, [[0x01070103, u8(0)]]),
      }),
    ]),
    fx.wwb_set_start
  );
  assert.deepEqual(
    rewrap(fx.wwb_set_stop_sync, [
      clientBlock({
        mid,
        protocol: PROTO_DMP,
        payload: Buffer.concat([
          dmpPdus(DMP.SET, [[0x0107010e, u8(0)]]),
          syncProbe(),
        ]),
      }),
    ]),
    fx.wwb_set_stop_sync
  );
  assert.deepEqual(
    rewrap(fx.wwb_unsubscribe, [
      clientBlock({
        mid,
        protocol: PROTO_DMP,
        payload: Buffer.concat([
          dmpPdus(DMP.UNSUBSCRIBE, [0x1fffffff, 0x01070120, 0x01070110]),
          syncProbe(),
        ]),
      }),
    ]),
    fx.wwb_unsubscribe
  );
});

const dmpOf = (buf) => {
  const w = parseWrapper(only(buf).data);
  return parseDmp(w.blocks[0].payload);
};

test('property replies decode: model, firmware, step list', () => {
  const byAddress = new Map(dmpOf(fx.device_get_reply).map((r) => [r.address, r]));
  assert.equal(decodeString(byAddress.get(0x01000012).value), 'AXT600');
  const fw = byAddress.get(0x01000004).value;
  assert.deepEqual([fw.readUInt16BE(0), fw.readUInt16BE(2), fw.readUInt16BE(4)], [2, 1, 41]);
});

test('a SET is answered only by the GET_FAIL of the sync probe', () => {
  const [fail] = dmpOf(fx.device_get_fail);
  assert.equal(fail.vector, DMP.GET_FAIL);
  assert.equal(fail.address, 0);
});

test('scan progress and scan data decode', () => {
  const [progress] = dmpOf(fx.device_progress_event);
  assert.equal(progress.vector, DMP.EVENT);
  assert.equal(progress.address, 0x01070110);

  const [scan] = dmpOf(fx.device_scan_event);
  assert.equal(scan.vector, DMP.EVENT);
  assert.equal(scan.single, false);
  assert.equal(scan.address, 0x10000000);
  assert.equal(scan.increment, 1);
  assert.equal(scan.count, 51);
  assert.equal(scan.value.length, 102);
  // big-endian int16, tenths of a dBm
  assert.equal(scan.value.readInt16BE(0) / 10, -114.9);
});
