import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { once } from "node:events";
import zlib from "node:zlib";

export interface ZipArchiveEntry {
  name: string;
  sourcePath: string;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
})();

function normalizeEntryName(name: string) {
  return name
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== ".." && segment !== ".")
    .join("/")
    .replace(/^\/+/, "");
}

function updateCrc32(crc: number, chunk: Buffer) {
  let value = crc >>> 0;

  for (let index = 0; index < chunk.length; index += 1) {
    const byte = chunk[index]!;
    value = CRC32_TABLE[(value ^ byte) & 0xFF]! ^ (value >>> 8);
  }

  return value >>> 0;
}

async function compressFile(filePath: string): Promise<{
  compressed: Buffer;
  crc32: number;
  uncompressedSize: number;
}> {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    const deflate = zlib.createDeflateRaw();
    const chunks: Buffer[] = [];
    let crc = 0xFFFFFFFF;
    let uncompressedSize = 0;

    input.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = updateCrc32(crc, buf);
      uncompressedSize += buf.length;
    });

    deflate.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    deflate.on("end", () => {
      resolve({
        compressed: Buffer.concat(chunks),
        crc32: (crc ^ 0xFFFFFFFF) >>> 0,
        uncompressedSize,
      });
    });

    input.on("error", reject);
    deflate.on("error", reject);
    input.pipe(deflate);
  });
}

function encodeDosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  const month = Math.max(1, date.getMonth() + 1);
  const day = Math.max(1, date.getDate());
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

async function writeBuffer(output: fs.WriteStream, chunk: Buffer) {
  if (output.write(chunk)) {
    return;
  }

  await once(output, "drain");
}

export async function createZipArchive(outputPath: string, entries: ZipArchiveEntry[]) {
  const output = fs.createWriteStream(outputPath);
  const centralDirectory: Array<{
    compressedSize: number;
    crc32: number;
    dosDate: number;
    dosTime: number;
    nameBuffer: Buffer;
    offset: number;
    uncompressedSize: number;
  }> = [];

  let offset = 0;

  try {
    for (const entry of entries) {
      const stat = await fsPromises.stat(entry.sourcePath);
      const { compressed, crc32, uncompressedSize } = await compressFile(entry.sourcePath);
      const nameBuffer = Buffer.from(normalizeEntryName(entry.name), "utf8");
      const { date: dosDate, time: dosTime } = encodeDosDateTime(stat.mtime);
      const localHeaderOffset = offset;

      const localHeader = Buffer.alloc(30 + nameBuffer.length);
      localHeader.writeUInt32LE(0x04034B50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0, 6);
      localHeader.writeUInt16LE(8, 8);  // compression method: deflate
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(crc32, 14);
      localHeader.writeUInt32LE(compressed.length, 18);  // compressed size
      localHeader.writeUInt32LE(uncompressedSize, 22);   // uncompressed size
      localHeader.writeUInt16LE(nameBuffer.length, 26);
      localHeader.writeUInt16LE(0, 28);
      nameBuffer.copy(localHeader, 30);

      await writeBuffer(output, localHeader);
      offset += localHeader.length;
      await writeBuffer(output, compressed);
      offset += compressed.length;

      centralDirectory.push({
        compressedSize: compressed.length,
        crc32,
        dosDate,
        dosTime,
        nameBuffer,
        offset: localHeaderOffset,
        uncompressedSize,
      });
    }

    const centralDirectoryOffset = offset;

    for (const entry of centralDirectory) {
      const header = Buffer.alloc(46 + entry.nameBuffer.length);
      header.writeUInt32LE(0x02014B50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0, 8);
      header.writeUInt16LE(8, 10);  // compression method: deflate
      header.writeUInt16LE(entry.dosTime, 12);
      header.writeUInt16LE(entry.dosDate, 14);
      header.writeUInt32LE(entry.crc32, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.uncompressedSize, 24);
      header.writeUInt16LE(entry.nameBuffer.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.offset, 42);
      entry.nameBuffer.copy(header, 46);

      await writeBuffer(output, header);
      offset += header.length;
    }

    const endOfCentralDirectory = Buffer.alloc(22);
    endOfCentralDirectory.writeUInt32LE(0x06054B50, 0);
    endOfCentralDirectory.writeUInt16LE(0, 4);
    endOfCentralDirectory.writeUInt16LE(0, 6);
    endOfCentralDirectory.writeUInt16LE(centralDirectory.length, 8);
    endOfCentralDirectory.writeUInt16LE(centralDirectory.length, 10);
    endOfCentralDirectory.writeUInt32LE(offset - centralDirectoryOffset, 12);
    endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
    endOfCentralDirectory.writeUInt16LE(0, 20);

    await writeBuffer(output, endOfCentralDirectory);
    output.end();
    await once(output, "close");
  } catch (error) {
    output.destroy();
    throw error;
  }
}
