// Generates the macOS app icon: a blue squircle with the white server+check glyph.
// Output: build-resources/icon.png (1024). electron-builder turns it into icon.icns.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function crc32(b) { let c = ~0 >>> 0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return (~c) >>> 0 }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const tt = Buffer.from(t, 'ascii'); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tt, d])), 0); return Buffer.concat([l, tt, d, cr]) }
function png(S, rgba) { const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const ih = Buffer.alloc(13); ih.writeUInt32BE(S, 0); ih.writeUInt32BE(S, 4); ih[8] = 8; ih[9] = 6; const st = S * 4; const raw = Buffer.alloc((st + 1) * S); for (let y = 0; y < S; y++) rgba.copy(raw, y * (st + 1) + 1, y * st, y * st + st); return Buffer.concat([sig, chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]) }

function distSeg(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) }
function roundRect(px, py, x0, y0, x1, y1, r) { const ix0 = x0 + r, iy0 = y0 + r, ix1 = x1 - r, iy1 = y1 - r; const qx = Math.max(ix0 - px, 0, px - ix1); const qy = Math.max(iy0 - py, 0, py - iy1); return Math.hypot(qx, qy) <= r }

// server box with the check knocked out + drawn on top (G = glyph box size)
function glyph(px, py, G) {
  const body = roundRect(px, py, 0.13 * G, 0.14 * G, 0.63 * G, 0.86 * G, 0.09 * G)
  const slit = (Math.abs(py - 0.38 * G) <= 0.035 * G || Math.abs(py - 0.62 * G) <= 0.035 * G) && px >= 0.19 * G && px <= 0.45 * G
  const led = Math.hypot(px - 0.54 * G, py - 0.26 * G) <= 0.03 * G
  const inBody = body && !slit && !led
  const cd = Math.min(distSeg(px, py, 0.49 * G, 0.60 * G, 0.59 * G, 0.74 * G), distSeg(px, py, 0.59 * G, 0.74 * G, 0.89 * G, 0.39 * G))
  const wc = 0.085 * G
  return (cd <= wc) || (inBody && cd > wc + 0.05 * G)
}

function build(size) {
  const ss = 3
  const buf = Buffer.alloc(size * size * 4)
  const radius = 0.185 * size            // squircle-ish corner
  const gSize = 0.62 * size              // glyph box
  const off = (size - gSize) / 2         // centered
  const top = [79, 139, 255], bottom = [37, 99, 235]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCov = 0, gCov = 0
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss
        if (roundRect(px, py, 0, 0, size, size, radius)) bgCov++
        if (glyph(px - off, py - off, gSize)) gCov++
      }
      bgCov /= ss * ss; gCov /= ss * ss
      const k = y / size
      const r = Math.round(top[0] * (1 - k) + bottom[0] * k)
      const g = Math.round(top[1] * (1 - k) + bottom[1] * k)
      const b = Math.round(top[2] * (1 - k) + bottom[2] * k)
      const i = (y * size + x) * 4
      // white glyph over the blue background
      buf[i] = Math.round(r * (1 - gCov) + 255 * gCov)
      buf[i + 1] = Math.round(g * (1 - gCov) + 255 * gCov)
      buf[i + 2] = Math.round(b * (1 - gCov) + 255 * gCov)
      buf[i + 3] = Math.round(bgCov * 255)
    }
  }
  return buf
}

const outDir = path.join(__dirname, '..', 'build-resources')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'icon.png'), png(1024, build(1024)))
console.log('wrote build-resources/icon.png (1024)')
