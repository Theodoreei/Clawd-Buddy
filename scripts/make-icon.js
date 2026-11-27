// Draws the app icon (pixel Clawd on a dark rounded square) and writes build/icon-1024.png.
// Run with Electron: npx electron scripts/make-icon.js
const { app, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

const N = 1024;
const buf = Buffer.alloc(N * N * 4); // BGRA

function px(x, y, [r, g, b], a = 255) {
  const i = (y * N + x) * 4;
  buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
}
function rect(x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(x, y, color);
}

// macOS-style rounded square (824px on a 1024 canvas), dark panel colour from MyClawd.
const inset = 100, size = N - 2 * inset, radius = 185;
for (let y = inset; y < inset + size; y++) {
  for (let x = inset; x < inset + size; x++) {
    const dx = Math.max(inset + radius - x, 0, x - (inset + size - 1 - radius));
    const dy = Math.max(inset + radius - y, 0, y - (inset + size - 1 - radius));
    const d = Math.hypot(dx, dy);
    if (d > radius + 0.5) continue;
    const edge = Math.max(0, Math.min(1, radius + 0.5 - d)); // soft corner edge
    const t = (y - inset) / size;
    const c = [Math.round(30 - 8 * t), Math.round(32 - 8 * t), Math.round(48 - 12 * t)];
    px(x, y, c, Math.round(255 * edge));
  }
}

// Clawd on a 12 x 8 block grid (same shape as the MyClawd sprites).
const CORAL = [212, 132, 90], BLACK = [0, 0, 0];
const B = 56; // block size in px
const gx = (N - 12 * B) / 2, gy = (N - 8 * B) / 2 + 20;
const block = (c, r, w, h, color) => rect(gx + c * B, gy + r * B, w * B, h * B, color);
block(2, 0, 8, 2, CORAL); // head
block(0, 2, 12, 2, CORAL); // body + arms
block(2, 4, 8, 2, CORAL); // lower body
for (const c of [2, 4, 7, 9]) block(c, 6, 1, 2, CORAL); // legs
block(3, 1, 1, 1, BLACK); // eyes
block(8, 1, 1, 1, BLACK);

app.whenReady().then(() => {
  const img = nativeImage.createFromBitmap(buf, { width: N, height: N });
  const out = path.join(__dirname, "..", "build", "icon-1024.png");
  const assetCopy = path.join(__dirname, "..", "assets", "icon.png");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  fs.writeFileSync(assetCopy, img.resize({ width: 256, height: 256 }).toPNG());
  console.log("wrote", out);
  app.quit();
});
