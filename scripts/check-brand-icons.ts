// Brand-icon drift check (pixel-canonical).
//
// Runs after `npm run icons:brand` has regenerated the assets on disk. For each
// asset we compare the DECODED pixel content of the freshly generated file
// against the committed version (from git HEAD), not the raw compressed bytes.
//
// Why: zlib's DEFLATE output can differ between macOS and Linux builds of Node
// even for byte-identical pixels, which made the previous raw-byte `git diff`
// drift check fail on CI for no real reason. Comparing decoded pixels is
// platform-independent and still catches genuine geometry/colour drift.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const FILES = ["app/icon.svg", "app/icon.png", "app/apple-icon.png", "app/favicon.ico"];

function committed(path: string): Buffer {
  return Buffer.from(execSync(`git show HEAD:${path}`, { maxBuffer: 1 << 26 }));
}

function generated(path: string): Buffer {
  return readFileSync(path);
}

// Minimal PNG decoder for the generator's output: RGBA, 8-bit, no interlace.
function decodePng(buf: Buffer): Buffer {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (colorType !== 6 || bitDepth !== 8) {
    throw new Error(`unsupported PNG colorType=${colorType} bitDepth=${bitDepth}`);
  }
  const bpp = 4;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p++];
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const rawByte = raw[p++];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let val: number;
      switch (filter) {
        case 0:
          val = rawByte;
          break;
        case 1:
          val = rawByte + a;
          break;
        case 2:
          val = rawByte + b;
          break;
        case 3:
          val = rawByte + ((a + b) >> 1);
          break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          val = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      cur[i] = val & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return out;
}

// ICO containers wrap one PNG per entry; compare the concatenated decoded
// pixels of every embedded PNG.
function extractIcoPngs(buf: Buffer): Buffer[] {
  if (buf.readUInt16LE(2) !== 0x0001) throw new Error("not an ICO");
  const count = buf.readUInt16LE(4);
  const pngs: Buffer[] = [];
  let off = 6;
  for (let i = 0; i < count; i += 1) {
    const bytesInRes = buf.readUInt32LE(off + 8);
    const imageOffset = buf.readUInt32LE(off + 12);
    pngs.push(buf.subarray(imageOffset, imageOffset + bytesInRes));
    off += 16;
  }
  return pngs;
}

function pixelsOf(buf: Buffer, path: string): Buffer {
  if (path.endsWith(".svg")) return buf;
  if (buf.readUInt32BE(0) === 0x89504e47) return decodePng(buf);
  if (buf.readUInt16LE(2) === 0x0001) {
    return Buffer.concat(extractIcoPngs(buf).map(decodePng));
  }
  throw new Error(`unknown asset format for ${path}`);
}

let failed = false;
for (const path of FILES) {
  const gen = generated(path);
  const com = committed(path);
  const gp = pixelsOf(gen, path);
  const cp = pixelsOf(com, path);
  if (gp.equals(cp)) {
    console.log(`OK    ${path}`);
  } else {
    failed = true;
    console.error(
      `DRIFT ${path} (generated ${gen.length}B / committed ${com.length}B; decoded pixels differ)`,
    );
  }
}

if (failed) {
  console.error("Brand-icon drift detected: generated assets differ from committed source.");
  process.exit(1);
}
console.log("Brand-icon drift check passed: generated assets match committed source.");
