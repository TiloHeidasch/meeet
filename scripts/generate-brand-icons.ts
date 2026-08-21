// Brand-icon generator.
//
// Derives every brand-icon touchpoint from the single source of truth
// lib/client/brand-mark.ts (the pin-headed "M" mark):
//
//   - app/icon.svg        → master SVG, written from the same constants
//   - app/favicon.ico     → 16×16 and 32×32 PNG entries in an ICO container
//   - app/icon.png        → 512×512 RGBA PNG
//   - app/apple-icon.png  → 180×180 RGBA PNG
//
// Plain Node, no runtime dependencies beyond node:zlib (run via tsx).
// Rasterization is a supersampled point-in-polygon test against the flattened
// geometry; PNG/ICO encoding uses only node:zlib. The generated assets are
// committed, and CI (`Brand icon drift check`) fails if they ever drift from
// the source.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BRAND_MARK_LETTER_D, BRAND_MARK_PLATE_D } from "../lib/client/brand-mark";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = {
  svg: join(ROOT, "app", "icon.svg"),
  ico: join(ROOT, "app", "favicon.ico"),
  png: join(ROOT, "app", "icon.png"),
  apple: join(ROOT, "app", "apple-icon.png"),
};

const ICON_SIZES = [16, 32]; // entries inside favicon.ico
const PNG_SIZE = 512;
const APPLE_SIZE = 180;

const PLATE_RGB = [32, 37, 34] as const; // #202522 = --foreground
const LETTER_RGB = [240, 202, 67] as const; // #f0ca43 = --yellow

// --- Geometry flattening ---------------------------------------------------

type Point = readonly [number, number];

interface BrandShape {
  readonly points: ReadonlyArray<Point>;
  readonly rgb: readonly [number, number, number];
}

function pathPoints(d: string): Point[] {
  // Flatten the path `d` into an array of [x, y] outline points.
  // Supports M/L line segments, 90-degree A arcs (flattened into segments),
  // and Z closes. Everything else is rejected loudly.
  const tokens = d.split(/(?=[MLAZ])/).filter((token) => token.trim() !== "");
  const points: Point[] = [];
  let cursor: Point | null = null;
  let start: Point | null = null;
  for (const token of tokens) {
    const command = token[0];
    const args = (token.slice(1).match(NUMBER) ?? []).map(Number);
    switch (command) {
      case "M": {
        if (args.length !== 2) throw new Error(`unsupported M args: ${token}`);
        cursor = [args[0], args[1]];
        start = cursor;
        points.push(cursor);
        break;
      }
      case "L": {
        if (cursor === null) throw new Error(`line without an explicit start: ${token}`);
        if (args.length !== 2) throw new Error(`unsupported L args: ${token}`);
        cursor = [args[0], args[1]];
        points.push(cursor);
        break;
      }
      case "A": {
        if (cursor === null) throw new Error(`arc without an explicit start: ${token}`);
        if (args.length !== 7) throw new Error(`unsupported A args: ${token}`);
        const [rx, ry, , largeArc, sweep, x2, y2] = args;
        const segments = flattenArc(cursor[0], cursor[1], x2, y2, rx, ry, largeArc, sweep);
        for (const segment of segments) points.push(segment);
        cursor = [x2, y2];
        break;
      }
      case "Z": {
        if (start === null) throw new Error(`close without an explicit start: ${token}`);
        points.push([...start]);
        cursor = start;
        break;
      }
      default:
        throw new Error(`unsupported path command: ${command}`);
    }
  }
  return points;
}

const NUMBER = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

// Fixed-precision rounding for the flattened arc geometry (see flattenArc).
const ROUND = 1e3;
const round = (n: number) => Math.round(n * ROUND) / ROUND;

// Fixed-point factor for the rasterizer. All polygon geometry and sample
// positions are scaled by FP into integers so the point-in-polygon test uses
// exact integer arithmetic (no floating-point division/comparison). This makes
// the rasterized pixels bit-identical across platforms and Node versions, which
// is what the CI brand-icon drift check requires.
const FP = 1e6;

function flattenArc(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rx: number,
  ry: number,
  largeArc: number,
  sweep: number,
  segments = 24,
): Point[] {
  // SVG endpoint-to-center arc parameterization, then linear flattening.
  // All arcs in the brand mark are simple quarter arcs, but the general
  // algorithm keeps the script correct if the geometry is ever tweaked.
  const cosPhi = 1; // phi = 0, our arcs are axis-aligned
  const sinPhi = 0;
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const sign = largeArc === sweep ? -1 : 1;
  const coef = sign * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * (-(ry * x1p) / rx);
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let theta = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) theta = -theta;
    return theta;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = angle(1, 0, ux, uy);
  let delta = angle(ux, uy, vx, vy);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  const out: Point[] = [];
  for (let step = 1; step <= segments; step += 1) {
    const theta = theta1 + (delta * step) / segments;
    // Round to a fixed precision so the flattened geometry is bit-identical
    // across platforms: Math.hypot/Math.acos can differ in the last ULP
    // between glibc (Linux CI) and macOS libm, which would otherwise make the
    // raster output non-deterministic and trip the CI drift check.
    out.push([
      round(cx + rx * Math.cos(theta)),
      round(cy + ry * Math.sin(theta)),
    ]);
  }
  return out;
}

function pointInPolygon(px: number, py: number, points: ReadonlyArray<Point>): boolean {
  // Even-odd ray casting using exact integer arithmetic. `px`/`py` and every
  // point in `points` are fixed-point integers (scaled by FP), so the crossing
  // test reduces to integer cross-products with no floating-point division —
  // bit-identical on every platform and Node version.
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    if ((yi > py) !== (yj > py)) {
      const dy = yj - yi;
      const lhs = (xj - xi) * (py - yi);
      const rhs = dy * (px - xi);
      const crosses = dy > 0 ? rhs < lhs : rhs > lhs;
      if (crosses) inside = !inside;
    }
  }
  return inside;
}

// --- Rasterization ---------------------------------------------------------

function rasterize(shapes: readonly BrandShape[], size: number): Uint8Array {
  // Shapes are painted in array order; later shapes cover earlier ones. The
  // generator passes the letter after the plate, so the yellow M wins over
  // the black plate. Colors come from each shape's named rgb, never from an
  // array position. Supersampled 4×4 coverage with a 5-sample uniformity fast
  // path for large flat areas. Output is RGBA over a transparent background.
  const overlay = shapes[shapes.length - 1];
  const base = shapes[0];
  const scale = size / 64;
  const pixels = new Uint8Array(size * size * 4);
  const colorAt = (px: number, py: number): BrandShape | null => {
    for (let s = shapes.length - 1; s >= 0; s -= 1) {
      if (pointInPolygon(px, py, shapes[s].points)) return shapes[s];
    }
    return null;
  };
  const SAMPLE = 4;
  const samples: Point[] = [];
  for (let sy = 0; sy < SAMPLE; sy += 1) {
    for (let sx = 0; sx < SAMPLE; sx += 1) {
      samples.push([(sx + 0.5) / SAMPLE, (sy + 0.5) / SAMPLE]);
    }
  }
  const FAST: Point[] = [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.2], [0.5, 0.8]];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let yellow = 0;
      let plate = 0;
      const record = (offset: Point): "none" | "mark" | "plate" => {
        const px = Math.round(((x + offset[0]) / scale) * FP);
        const py = Math.round(((y + offset[1]) / scale) * FP);
        const shape = colorAt(px, py);
        if (shape === null) return "none";
        if (shape === overlay) {
          yellow += 1;
          return "mark";
        }
        plate += 1;
        return "plate";
      };
      const total = (count: number) => count / SAMPLE / SAMPLE;
      // Fast path: five probes; fall back to the full grid only at edges.
      const first = record(FAST[0]);
      if (FAST.slice(1).every((offset) => record(offset) === first)) {
        if (first === "none") continue;
        const color = first === "mark" ? overlay.rgb : base.rgb;
        const index = (y * size + x) * 4;
        pixels[index] = color[0];
        pixels[index + 1] = color[1];
        pixels[index + 2] = color[2];
        pixels[index + 3] = 255;
        continue;
      }
      yellow = 0;
      plate = 0;
      for (const offset of samples) record(offset);
      const yFrac = total(yellow);
      const pFrac = total(plate);
      const alpha = yFrac + pFrac;
      const index = (y * size + x) * 4;
      if (alpha > 0) {
        const mark = overlay.rgb;
        const body = base.rgb;
        pixels[index] = Math.round((mark[0] * yFrac + body[0] * pFrac) / alpha);
        pixels[index + 1] = Math.round((mark[1] * yFrac + body[1] * pFrac) / alpha);
        pixels[index + 2] = Math.round((mark[2] * yFrac + body[2] * pFrac) / alpha);
      }
      pixels[index + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

// --- SVG output ------------------------------------------------------------

function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function buildSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    "  <title>meeet</title>",
    "  <!-- Pin-headed plate: rounded square (r 13) with a 45-degree pin notch",
    "       cut into the bottom edge (tip at 32,46; feet at 20/44,58). -->",
    `  <path d="${BRAND_MARK_PLATE_D}" fill="${rgbToHex(PLATE_RGB)}"/>`,
    "  <!-- Bold geometric M: 8-unit stems at x 11..19 and 45..53, counter V",
    "       from y 12 down to the apex at 32,40. -->",
    `  <path d="${BRAND_MARK_LETTER_D}" fill="${rgbToHex(LETTER_RGB)}"/>`,
    "</svg>",
    "",
  ].join("\n");
}

// --- PNG / ICO encoding ----------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc;
});

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels: Uint8Array, size: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    pixels.subarray(y * size * 4, (y + 1) * size * 4).forEach((value, offset) => {
      raw[rowStart + 1 + offset] = value;
    });
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(pngs: ReadonlyArray<{ readonly size: number; readonly png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(pngs.length * 16);
  let offset = 6 + entries.length;
  pngs.forEach(({ size, png }, index) => {
    const base = index * 16;
    entries[base] = size; // width
    entries[base + 1] = size; // height
    entries.writeUInt16LE(1, base + 4); // planes
    entries.writeUInt16LE(32, base + 6); // bit count
    entries.writeUInt32LE(png.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...pngs.map(({ png }) => png)]);
}

// --- Main ------------------------------------------------------------------

function main(): void {
  // Named constants for the two brand shapes; the letter is painted over the
  // plate. No path parsing and no array-position color assumptions anywhere.
  // Geometry is lifted into fixed-point integers (scaled by FP) so the
  // rasterizer's point-in-polygon test is exact and platform-independent.
  const toFixed = (pts: ReadonlyArray<Point>): Point[] =>
    pts.map(([x, y]) => [Math.round(x * FP), Math.round(y * FP)] as Point);
  const plate: BrandShape = { points: toFixed(pathPoints(BRAND_MARK_PLATE_D)), rgb: PLATE_RGB };
  const letter: BrandShape = { points: toFixed(pathPoints(BRAND_MARK_LETTER_D)), rgb: LETTER_RGB };
  const shapes = [plate, letter];

  writeFileSync(OUT.svg, buildSvg());

  const ico = encodeIco(
    ICON_SIZES.map((size) => ({ size, png: encodePng(rasterize(shapes, size), size) })),
  );
  writeFileSync(OUT.ico, ico);

  const png = encodePng(rasterize(shapes, PNG_SIZE), PNG_SIZE);
  writeFileSync(OUT.png, png);

  const apple = encodePng(rasterize(shapes, APPLE_SIZE), APPLE_SIZE);
  writeFileSync(OUT.apple, apple);

  console.log(`wrote ${OUT.svg}`);
  console.log(`wrote ${OUT.ico} (${ico.length} bytes, ${ICON_SIZES.join("+")}px)`);
  console.log(`wrote ${OUT.png} (${png.length} bytes, ${PNG_SIZE}px)`);
  console.log(`wrote ${OUT.apple} (${apple.length} bytes, ${APPLE_SIZE}px)`);
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isDirectRun) {
  main();
}
