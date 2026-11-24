// A small ZIP writer: stored entries (no compression; WAV barely compresses), UTF-8 names.
// Enough for datasets under 4 GB and 65,535 files.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class ZipWriter {
  constructor(date = new Date()) {
    this.parts = [];
    this.central = [];
    this.offset = 0;
    this.count = 0;
    this.time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
    this.date = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  }

  add(name, data) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const size = data.length;
    if (this.offset + 30 + nameBytes.length + size > 0xffffffff || this.count >= 0xffff) {
      throw new Error("The dataset is too large for a single ZIP file.");
    }

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, this.time, true);
    local.setUint16(12, this.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    this.parts.push(local.buffer, nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true); // version made by
    entry.setUint16(6, 20, true); // version needed
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, this.time, true);
    entry.setUint16(14, this.date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint16(30, 0, true); // extra
    entry.setUint16(32, 0, true); // comment
    entry.setUint16(34, 0, true); // disk
    entry.setUint16(36, 0, true); // internal attributes
    entry.setUint32(38, 0, true); // external attributes
    entry.setUint32(42, this.offset, true);
    this.central.push(entry.buffer, nameBytes);

    this.offset += 30 + nameBytes.length + size;
    this.count++;
  }

  blob() {
    let size = 0;
    for (const part of this.central) size += part.byteLength;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true);
    end.setUint16(10, this.count, true);
    end.setUint32(12, size, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end.buffer], { type: "application/zip" });
  }
}
