// Draws Beam's app icon and tray icon as PNGs with no image dependencies.
// Run: node scripts/make-icons.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, size, pixel) {
  const SS = 3; // supersampling for smooth edges
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

function insideRoundedSquare(u, v, inset, radius) {
  const x = Math.min(u - inset, 1 - inset - u);
  const y = Math.min(v - inset, 1 - inset - v);
  if (x < 0 || y < 0) return false;
  if (x >= radius || y >= radius) return true;
  return (radius - x) ** 2 + (radius - y) ** 2 <= radius ** 2;
}

/** Distance from point to the segment a-b, for drawing a capped line. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The beam: a bold diagonal bar with a small spark at its tip. */
function onBeam(u, v, width) {
  if (segmentDistance(u, v, 0.3, 0.7, 0.62, 0.38) < width) return true;
  return Math.hypot(u - 0.72, v - 0.28) < width * 0.75;
}

fs.mkdirSync("assets", { recursive: true });

writePng("assets/icon.png", 512, (u, v) => {
  if (!insideRoundedSquare(u, v, 0.04, 0.2)) return [0, 0, 0, 0];
  if (onBeam(u, v, 0.075)) return [255, 255, 255, 1];
  const t = (u + v) / 2; // gradient from coral (top-left) to violet (bottom-right)
  return [255 + (124 - 255) * t, 99 + (77 - 99) * t, 99 + (255 - 99) * t, 1];
});

writePng("assets/tray.png", 32, (u, v) => (onBeam(u, v, 0.11) ? [255, 255, 255, 1] : [0, 0, 0, 0]));

console.log("Wrote assets/icon.png and assets/tray.png");
