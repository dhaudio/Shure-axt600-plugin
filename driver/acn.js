// ACN (ANSI E1.17) as the AXT600 speaks it: the UDP root layer, SDT session
// messages, and DMP property access. Encoding and decoding only — no sockets,
// no timers — so every byte can be checked against captures of Wireless
// Workbench talking to a real unit (see __tests__/acn.test.js).
//
// The AXT600 sends DMP in the clear. Unlike the AD600, its session needs no
// key and no encryption: a standard SDT join, a DMP connect, and properties.

const PREAMBLE = Buffer.from([
  0x00, 0x10, 0x00, 0x00, 0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37,
  0x00, 0x00, 0x00,
]); // preamble size 16, postamble 0, "ASC-E1.17\0\0\0"

export const ROOT_SDT = 0x00000001;
export const PROTO_SDT = 1;
export const PROTO_DMP = 2;

export const SDT = {
  REL_WRAP: 1,
  UNREL_WRAP: 2,
  CHANNEL_PARAMS: 3,
  JOIN: 4,
  JOIN_REFUSE: 5,
  JOIN_ACCEPT: 6,
  LEAVE: 7,
  LEAVING: 8,
  CONNECT: 9,
  CONNECT_ACCEPT: 10,
  CONNECT_REFUSE: 11,
  DISCONNECT: 12,
  DISCONNECTING: 13,
  ACK: 14,
  NAK: 15,
};

export const DMP = {
  GET: 1,
  SET: 2,
  GET_REPLY: 3,
  EVENT: 4,
  SUBSCRIBE: 7,
  UNSUBSCRIBE: 8,
  GET_FAIL: 9,
  SET_FAIL: 10,
  SUBSCRIBE_ACCEPT: 12,
  SUBSCRIBE_REJECT: 13,
};

/** The channel parameters Wireless Workbench offers in its joins. */
export const CHANNEL_PARAMS = Buffer.from([
  0x05, // expiry, seconds
  0x00, // NAK outbound flag
  0x00, 0x02, // NAK holdoff
  0x00, 0x32, // NAK modulus
  0x00, 0x14, // NAK max wait
]);
const ADHOC_EXPIRY = 0xff;
const NO_MAK = 0xffff;

// ---------------------------------------------------------------------------
// PDUs
// ---------------------------------------------------------------------------

/** One PDU with every field present (flags V, H, D). */
export function pdu(vector, vectorSize, header, data) {
  const vec = Buffer.alloc(vectorSize);
  vec.writeUIntBE(vector, 0, vectorSize);
  return withLength(0x7, Buffer.concat([vec, header ?? Buffer.alloc(0), data]));
}

/** A PDU of the given flags (high nibble) around an already-built body. */
function withLength(flags, body) {
  const length = body.length + 2;
  if (length > 0x0fff) {
    const out = Buffer.alloc(3);
    out[0] = ((flags | 0x8) << 4) | ((length + 1) >> 16);
    out.writeUInt16BE((length + 1) & 0xffff, 1);
    return Buffer.concat([out, body]);
  }
  const out = Buffer.alloc(2);
  out.writeUInt16BE((flags << 12) | length, 0);
  return Buffer.concat([out, body]);
}

/**
 * Walk a run of PDUs. Yields { flags, vector, header, data } with the ACN
 * inheritance rules applied: a field whose flag is clear repeats the previous
 * PDU's. `headerSize` may be a number or a function of the vector.
 */
export function* walk(buf, vectorSize, headerSize = 0) {
  let i = 0;
  let vector = null;
  let header = null;
  let data = null;
  while (i + 2 <= buf.length) {
    const flags = buf[i] >> 4;
    let length = ((buf[i] & 0x0f) << 8) | buf[i + 1];
    let j = i + 2;
    if (flags & 0x8) {
      length = (length << 8) | buf[i + 2];
      j = i + 3;
    }
    if (length < j - i || i + length > buf.length) return;
    const end = i + length;
    if (flags & 0x4) {
      vector = buf.readUIntBE(j, vectorSize);
      j += vectorSize;
    }
    const hs =
      typeof headerSize === 'function' ? headerSize(vector) : headerSize;
    if (flags & 0x2) {
      header = buf.subarray(j, j + hs);
      j += hs;
    }
    if (flags & 0x1) data = buf.subarray(j, end);
    yield { flags, vector, header, data };
    i = end;
  }
}

// ---------------------------------------------------------------------------
// root layer
// ---------------------------------------------------------------------------

/** A UDP datagram: preamble, then one root PDU carrying SDT PDUs. */
export function rootPacket(senderCid, sdtPdus) {
  return Buffer.concat([
    PREAMBLE,
    pdu(ROOT_SDT, 4, senderCid, Buffer.concat(sdtPdus)),
  ]);
}

/** Datagram -> [{ cid, sdt: [{ vector, data }] }], or null if it is not ACN. */
export function parsePacket(buf) {
  if (buf.length < 16 || !buf.subarray(4, 13).equals(PREAMBLE.subarray(4, 13)))
    return null;
  const start = buf.readUInt16BE(0);
  const out = [];
  for (const root of walk(buf.subarray(start), 4, 16)) {
    if (root.vector !== ROOT_SDT || !root.header || !root.data) continue;
    const sdt = [];
    for (const p of walk(root.data, 1)) sdt.push({ vector: p.vector, data: p.data });
    out.push({ cid: Buffer.from(root.header), sdt });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SDT
// ---------------------------------------------------------------------------

/** JOIN from the channel leader (us) to a new member (the device). */
export function join({ memberCid, mid, channel, reciprocal = 0, total, reliable }) {
  const data = Buffer.alloc(16 + 2 + 2 + 2 + 4 + 4 + 1);
  memberCid.copy(data, 0);
  data.writeUInt16BE(mid, 16);
  data.writeUInt16BE(channel, 18);
  data.writeUInt16BE(reciprocal, 20);
  data.writeUInt32BE(total >>> 0, 22);
  data.writeUInt32BE(reliable >>> 0, 26);
  data[30] = 0; // destination address: none, reply to the sender
  return pdu(
    SDT.JOIN,
    1,
    null,
    Buffer.concat([data, CHANNEL_PARAMS, Buffer.from([ADHOC_EXPIRY])])
  );
}

export function parseJoin(data) {
  return {
    memberCid: Buffer.from(data.subarray(0, 16)),
    mid: data.readUInt16BE(16),
    channel: data.readUInt16BE(18),
    reciprocal: data.readUInt16BE(20),
    total: data.readUInt32BE(22),
    reliable: data.readUInt32BE(26),
  };
}

/** JOIN_ACCEPT, from the member back to the leader of the channel it joined. */
export function joinAccept({ leaderCid, channel, mid, reliable, reciprocal }) {
  const data = Buffer.alloc(26);
  leaderCid.copy(data, 0);
  data.writeUInt16BE(channel, 16);
  data.writeUInt16BE(mid, 18);
  data.writeUInt32BE(reliable >>> 0, 20);
  data.writeUInt16BE(reciprocal, 24);
  return pdu(SDT.JOIN_ACCEPT, 1, null, data);
}

export function parseJoinAccept(data) {
  return {
    leaderCid: Buffer.from(data.subarray(0, 16)),
    channel: data.readUInt16BE(16),
    mid: data.readUInt16BE(18),
    reliable: data.readUInt32BE(20),
    reciprocal: data.readUInt16BE(24),
  };
}

/** JOIN_REFUSE carries leader CID, channel, MID, reliable seq and a reason. */
export function parseJoinRefuse(data) {
  return {
    channel: data.length >= 18 ? data.readUInt16BE(16) : null,
    reason: data.length >= 25 ? data[24] : null,
  };
}

/** A client block inside a wrapper: one protocol's PDUs, for one member. */
export function clientBlock({ mid, protocol, association = 0, payload }) {
  const head = Buffer.alloc(6);
  head.writeUInt32BE(protocol, 0);
  head.writeUInt16BE(association, 4);
  return pdu(mid, 2, head, payload);
}

/** REL_WRAP or UNREL_WRAP around client blocks. */
export function wrapper({
  reliable,
  channel,
  total,
  reliableSeq,
  oldest,
  firstMak = NO_MAK,
  lastMak = NO_MAK,
  makThreshold = 0,
  blocks = [],
}) {
  const head = Buffer.alloc(20);
  head.writeUInt16BE(channel, 0);
  head.writeUInt32BE(total >>> 0, 2);
  head.writeUInt32BE(reliableSeq >>> 0, 6);
  head.writeUInt32BE(oldest >>> 0, 10);
  head.writeUInt16BE(firstMak, 14);
  head.writeUInt16BE(lastMak, 16);
  head.writeUInt16BE(makThreshold, 18);
  return pdu(
    reliable ? SDT.REL_WRAP : SDT.UNREL_WRAP,
    1,
    null,
    Buffer.concat([head, ...blocks])
  );
}

export function parseWrapper(data) {
  const out = {
    channel: data.readUInt16BE(0),
    total: data.readUInt32BE(2),
    reliableSeq: data.readUInt32BE(6),
    oldest: data.readUInt32BE(10),
    firstMak: data.readUInt16BE(14),
    lastMak: data.readUInt16BE(16),
    makThreshold: data.readUInt16BE(18),
    blocks: [],
  };
  for (const b of walk(data.subarray(20), 2, 6)) {
    if (!b.header || !b.data) continue;
    out.blocks.push({
      mid: b.vector,
      protocol: b.header.readUInt32BE(0),
      association: b.header.readUInt16BE(4),
      payload: b.data,
    });
  }
  return out;
}

/** An SDT PDU carried inside a client block (protocol 1): ACK, CONNECT … */
export function sdtInner(vector, data = Buffer.alloc(0)) {
  return pdu(vector, 1, null, data);
}

export const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
};

export function parseSdtInner(payload) {
  return [...walk(payload, 1)].map((p) => ({ vector: p.vector, data: p.data }));
}

// ---------------------------------------------------------------------------
// DMP
// ---------------------------------------------------------------------------

const ADDR_SINGLE_4 = 0x02; // absolute, single address, 4-byte address
const ADDR_SINGLE_1 = 0x00; // absolute, single address, 1-byte address

/**
 * DMP PDUs sharing one vector, each with a single 4-byte address, the second
 * and later inheriting vector and header — the shape Wireless Workbench sends.
 * `items` is [address] for GET/SUBSCRIBE/UNSUBSCRIBE and [[address, valueBuf]]
 * for SET.
 */
export function dmpPdus(vector, items) {
  const out = [];
  items.forEach((item, n) => {
    const [address, value] = Array.isArray(item) ? item : [item, null];
    const data = Buffer.concat([u32(address), value ?? Buffer.alloc(0)]);
    out.push(
      n === 0
        ? pdu(vector, 1, Buffer.from([ADDR_SINGLE_4]), data)
        : withLength(0x1, data)
    );
  });
  return Buffer.concat(out);
}

/**
 * The "GET address 0" Wireless Workbench appends after each SET. The device has
 * no such property and answers GET_FAIL, which is the only reply a SET gets —
 * so its arrival says every SET before it has been processed.
 */
export function syncProbe() {
  return pdu(DMP.GET, 1, Buffer.from([ADDR_SINGLE_1]), Buffer.from([0x00]));
}

/**
 * DMP payload -> [{ vector, address, increment, count, value, single }]
 *
 * Single-address PDUs carry one property; a value, when the vector has one,
 * is the rest of the data. Range PDUs (equal-size data) carry `count` values
 * starting at `address`, `increment` apart.
 */
export function parseDmp(payload) {
  const out = [];
  for (const p of walk(payload, 1, 1)) {
    if (!p.header || !p.data) continue;
    const type = p.header[0];
    const size = [1, 2, 4, 0][type & 3];
    const form = (type >> 4) & 3;
    const data = p.data;
    if (!size) continue;
    const hasValue = [DMP.SET, DMP.GET_REPLY, DMP.EVENT].includes(p.vector);
    if (form === 0) {
      if (hasValue) {
        out.push({
          vector: p.vector,
          address: data.readUIntBE(0, size),
          value: data.subarray(size),
          single: true,
        });
      } else if (p.vector === DMP.GET_FAIL || p.vector === DMP.SET_FAIL) {
        out.push({
          vector: p.vector,
          address: data.readUIntBE(0, size),
          reason: data[size] ?? null,
          single: true,
        });
      } else {
        for (let j = 0; j + size <= data.length; j += size) {
          out.push({ vector: p.vector, address: data.readUIntBE(j, size), single: true });
        }
      }
    } else {
      const address = data.readUIntBE(0, size);
      const increment = data.readUIntBE(size, size);
      const count = data.readUIntBE(2 * size, size);
      out.push({
        vector: p.vector,
        address,
        increment,
        count,
        value: hasValue ? data.subarray(3 * size) : null,
        single: false,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// values as the AXT600 encodes them
// ---------------------------------------------------------------------------

/** Strings carry a 16-bit length that counts itself. */
export function decodeString(value) {
  if (!value || value.length < 2) return '';
  const n = Math.min(value.length, value.readUInt16BE(0));
  return value.subarray(2, n).toString('latin1').replace(/\0+$/, '');
}

export const u8 = (v) => Buffer.from([v & 0xff]);

/** A component id: four random bytes, then the suffix Shure equipment uses. */
export function randomCid(randomBytes) {
  return Buffer.concat([
    randomBytes(4),
    Buffer.from('000011dda000000eddcccccc', 'hex'),
  ]);
}

export function cidFromString(text) {
  const hex = String(text ?? '').replace(/[^0-9a-f]/gi, '');
  return hex.length === 32 ? Buffer.from(hex, 'hex') : null;
}

export function cidToString(cid) {
  const h = cid.toString('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
