import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const width = 1200;
const height = 720;
const rgba = Buffer.alloc(width * height * 4);

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, sum]);
}

function setPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const idx = (Math.floor(y) * width + Math.floor(x)) * 4;
  rgba[idx] = color[0];
  rgba[idx + 1] = color[1];
  rgba[idx + 2] = color[2];
  rgba[idx + 3] = color[3] ?? 255;
}

function rect(x, y, w, h, color) {
  for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy += 1) {
    for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx += 1) setPixel(xx, yy, color);
  }
}

function line(x0, y0, x1, y1, color, thickness = 2) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    rect(Math.round(x - thickness / 2), Math.round(y - thickness / 2), thickness, thickness, color);
  }
}

function circle(cx, cy, r, color) {
  for (let y = cy - r; y <= cy + r; y += 1) {
    for (let x = cx - r; x <= cx + r; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r ** 2) setPixel(x, y, color);
    }
  }
}

function blendBackground() {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x / width;
      const dy = y / height;
      const warm = Math.max(0, 1 - Math.hypot(dx - 0.2, dy - 0.08) * 1.4);
      const cool = Math.max(0, 1 - Math.hypot(dx - 0.82, dy - 0.45) * 1.1);
      const r = 232 + warm * 18 - cool * 16;
      const g = 238 + warm * 9 + cool * 8;
      const b = 231 - warm * 18 + cool * 22;
      setPixel(x, y, [r, g, b, 255]);
    }
  }
}

blendBackground();

for (let x = 72; x < width - 72; x += 48) line(x, 72, x, height - 76, [204, 213, 202, 120], 1);
for (let y = 84; y < height - 72; y += 44) line(72, y, width - 72, y, [204, 213, 202, 120], 1);

rect(78, 76, 1044, 568, [255, 255, 250, 230]);
rect(78, 76, 1044, 4, [32, 41, 38, 255]);
rect(78, 76, 4, 568, [32, 41, 38, 255]);
rect(1118, 76, 4, 568, [32, 41, 38, 255]);
rect(78, 640, 1044, 4, [32, 41, 38, 255]);

rect(112, 112, 240, 392, [41, 50, 47, 255]);
rect(132, 140, 144, 14, [246, 248, 242, 255]);
rect(132, 176, 174, 10, [121, 198, 142, 255]);
rect(132, 204, 132, 10, [75, 129, 220, 255]);
rect(132, 232, 190, 10, [232, 166, 74, 255]);
rect(132, 292, 172, 56, [247, 248, 244, 255]);
rect(132, 376, 148, 56, [247, 248, 244, 255]);

const nodes = [
  [470, 188, 20, [121, 198, 142, 255]],
  [648, 148, 14, [75, 129, 220, 255]],
  [812, 236, 18, [232, 166, 74, 255]],
  [566, 340, 16, [233, 107, 91, 255]],
  [760, 430, 22, [121, 198, 142, 255]],
  [968, 364, 15, [75, 129, 220, 255]]
];
const links = [[0, 1], [1, 2], [0, 3], [3, 4], [2, 5], [4, 5], [2, 4]];
for (const [a, b] of links) {
  line(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1], [32, 41, 38, 160], 3);
  line(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1], [247, 248, 244, 210], 1);
}
for (const [x, y, r, color] of nodes) {
  circle(x, y, r + 7, [247, 248, 244, 255]);
  circle(x, y, r, color);
  circle(x - 4, y - 4, Math.max(3, Math.floor(r / 4)), [255, 255, 255, 190]);
}

const bars = [126, 192, 94, 248, 166, 306, 218, 118, 278, 202, 146, 232];
for (let i = 0; i < bars.length; i += 1) {
  const x = 420 + i * 48;
  const h = bars[i];
  const c = i % 3 === 0 ? [121, 198, 142, 255] : i % 3 === 1 ? [75, 129, 220, 255] : [232, 166, 74, 255];
  rect(x, 598 - h, 28, h, c);
}
line(392, 600, 1012, 600, [32, 41, 38, 255], 2);
line(392, 298, 392, 600, [32, 41, 38, 255], 2);

rect(856, 112, 218, 56, [32, 41, 38, 255]);
rect(876, 132, 72, 10, [121, 198, 142, 255]);
rect(876, 152, 154, 8, [246, 248, 242, 255]);
rect(856, 184, 218, 56, [246, 248, 242, 255]);
rect(876, 204, 116, 10, [233, 107, 91, 255]);
rect(876, 224, 170, 8, [32, 41, 38, 255]);

const raw = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y += 1) {
  raw[y * (width * 4 + 1)] = 0;
  rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

mkdirSync("apps/web/public/assets", { recursive: true });
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0))
]);
writeFileSync("apps/web/public/assets/benchmark-console.png", png);
