/**
 * Minimal ZIP writer, store method only.
 *
 * Media from Shopee is already compressed (JPEG, MP4), so deflating it would
 * cost CPU and save almost nothing. Store mode keeps the writer small enough
 * to read in one sitting and fast on runs of several hundred files.
 *
 * ZIP64 fields are emitted only when the classic 32-bit fields overflow, so
 * ordinary archives stay maximally compatible while very large ones (past
 * 4 GB, or past 65535 files) remain valid.
 *
 * Loaded via importScripts() in the service worker and require() in tests.
 */
(function (root, factory) {
  const api = factory();
  root.SRME_Zip = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const U32_MAX = 0xFFFFFFFF;
  const U16_MAX = 0xFFFF;

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const encoder = new TextEncoder();

  /** DOS date and time halves for a JS Date. */
  function dosStamp(date) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const year = Math.max(1980, d.getFullYear());
    const time = ((d.getHours() & 0x1F) << 11) |
      ((d.getMinutes() & 0x3F) << 5) |
      ((Math.floor(d.getSeconds() / 2)) & 0x1F);
    const dateBits = (((year - 1980) & 0x7F) << 9) |
      (((d.getMonth() + 1) & 0x0F) << 5) |
      (d.getDate() & 0x1F);
    return { time: time, date: dateBits };
  }

  /** Grow-as-needed little-endian byte sink. */
  function Sink() {
    this.chunks = [];
    this.length = 0;
  }
  Sink.prototype.push = function (bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  };
  Sink.prototype.u16 = function (v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v >>> 0, true);
    this.push(b);
  };
  Sink.prototype.u32 = function (v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
  };
  Sink.prototype.u64 = function (v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    this.push(b);
  };
  Sink.prototype.toUint8Array = function () {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };

  /**
   * Build a ZIP archive.
   *
   * entries: [{ path: string, data: Uint8Array, date?: Date }]
   * Returns a Uint8Array. Paths must already be unique and sanitised; this
   * writer does not rename anything for you.
   */
  function createZip(entries) {
    const sink = new Sink();
    const central = [];

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.path);

      // A single entry over 4 GB is not something this extension produces;
      // fail loudly rather than write a silently corrupt archive. This reads
      // the declared length before any coercion, so an oversized entry is
      // never allocated or CRC'd first — doing that can exhaust the machine.
      //
      // byteLength is read first because an ArrayBuffer has no .length at
      // all: reading only .length let one of any size through as 0, straight
      // into the allocation this guard exists to prevent.
      const raw = entry.data;
      const declared = Number(
        raw == null ? 0 : (raw.byteLength != null ? raw.byteLength : raw.length)
      ) || 0;

      // >= rather than >. At exactly U32_MAX two things go wrong at once: the
      // 32-bit size fields below would carry 0xFFFFFFFF, which readers take as
      // the ZIP64 sentinel rather than a size, and the allocation is a
      // process-fatal OOM rather than a catchable throw — so the guard has to
      // stop it here or not at all.
      if (declared >= U32_MAX) {
        throw new Error('Entry too large for this writer: ' + entry.path);
      }

      const data = entry.data instanceof Uint8Array
        ? entry.data
        : new Uint8Array(entry.data);
      const crc = crc32(data);
      const stamp = dosStamp(entry.date);
      const localOffset = sink.length;

      // Local file header.
      sink.u32(0x04034B50);
      sink.u16(20);            // version needed
      sink.u16(0x0800);        // UTF-8 filename
      sink.u16(0);             // method: store
      sink.u16(stamp.time);
      sink.u16(stamp.date);
      sink.u32(crc);
      sink.u32(data.length);   // compressed size
      sink.u32(data.length);   // uncompressed size
      sink.u16(nameBytes.length);
      sink.u16(0);             // extra length
      sink.push(nameBytes);
      sink.push(data);

      central.push({
        nameBytes: nameBytes,
        crc: crc,
        size: data.length,
        stamp: stamp,
        localOffset: localOffset
      });
    }

    const centralStart = sink.length;

    for (const e of central) {
      const needsZip64Offset = e.localOffset > U32_MAX;

      sink.u32(0x02014B50);
      sink.u16(needsZip64Offset ? 45 : 20);  // version made by
      sink.u16(needsZip64Offset ? 45 : 20);  // version needed
      sink.u16(0x0800);
      sink.u16(0);
      sink.u16(e.stamp.time);
      sink.u16(e.stamp.date);
      sink.u32(e.crc);
      sink.u32(e.size);
      sink.u32(e.size);
      sink.u16(e.nameBytes.length);
      sink.u16(needsZip64Offset ? 12 : 0);   // extra length
      sink.u16(0);                           // comment length
      sink.u16(0);                           // disk number start
      sink.u16(0);                           // internal attributes
      sink.u32(0);                           // external attributes
      sink.u32(needsZip64Offset ? U32_MAX : e.localOffset);
      sink.push(e.nameBytes);

      if (needsZip64Offset) {
        sink.u16(0x0001);     // ZIP64 extra field
        sink.u16(8);          // body size: offset only
        sink.u64(e.localOffset);
      }
    }

    const centralSize = sink.length - centralStart;
    const count = central.length;
    const needsZip64End =
      count > U16_MAX || centralSize > U32_MAX || centralStart > U32_MAX;

    if (needsZip64End) {
      const zip64Start = sink.length;

      sink.u32(0x06064B50);   // ZIP64 end of central directory
      sink.u64(44);           // size of this record after this field
      sink.u16(45);
      sink.u16(45);
      sink.u32(0);            // this disk
      sink.u32(0);            // disk with central directory
      sink.u64(count);
      sink.u64(count);
      sink.u64(centralSize);
      sink.u64(centralStart);

      sink.u32(0x07064B50);   // ZIP64 locator
      sink.u32(0);
      sink.u64(zip64Start);
      sink.u32(1);
    }

    // End of central directory.
    sink.u32(0x06054B50);
    sink.u16(0);
    sink.u16(0);
    // Each field carries the sentinel only if THAT field overflows. Writing
    // all four as sentinels whenever any one of them did meant a 70000-entry
    // archive advertised a 4 GB central directory at offset 4 GB, so an
    // extractor that does not read ZIP64 failed outright instead of falling
    // back to showing the first 65535 entries.
    sink.u16(count > U16_MAX ? U16_MAX : count);
    sink.u16(count > U16_MAX ? U16_MAX : count);
    sink.u32(centralSize > U32_MAX ? U32_MAX : centralSize);
    sink.u32(centralStart > U32_MAX ? U32_MAX : centralStart);
    sink.u16(0);

    return sink.toUint8Array();
  }

  return {
    createZip: createZip,
    crc32: crc32
  };
});
