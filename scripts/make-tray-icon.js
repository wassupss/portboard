'use strict'
// Generates the macOS menu-bar template icon: a server box with a check mark overlaid
// (knocked out of the body so it reads at 16px). No image dependencies.
// Output: electron/assets/iconTemplate.png + iconTemplate@2x.png
// Pass --preview to also emit visible previews next to this script.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function crc32(b) { let c = ~0 >>> 0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return (~c) >>> 0 }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const tt = Buffer.from(t, 'ascii'); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tt, d])), 0); return Buffer.concat([l, tt, d, cr]) }
function png(S, rgba) { const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const ih = Buffer.alloc(13); ih.writeUInt32BE(S, 0); ih.writeUInt32BE(S, 4); ih[8] = 8; ih[9] = 6; const st = S * 4; const raw = Buffer.alloc((st + 1) * S); for (let y = 0; y < S; y++) rgba.copy(raw, y * (st + 1) + 1, y * st, y * st + st); return Buffer.concat([sig, chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]) }

function distSeg(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) }
function roundRect(px, py, x0, y0, x1, y1, r) { const ix0 = x0 + r, iy0 = y0 + r, ix1 = x1 - r, iy1 = y1 - r; const qx = Math.max(ix0 - px, 0, px - ix1); const qy = Math.max(iy0 - py, 0, py - iy1); return Math.hypot(qx, qy) <= r }

// returns true if (px,py) in icon (server box with check knocked out + check stroke on top)
function inside(px, py, S) {
  // server body
  const body = roundRect(px, py, 0.13 * S, 0.14 * S, 0.63 * S, 0.86 * S, 0.09 * S)
  // horizontal slits (rack units)
  const slit = (Math.abs(py - 0.38 * S) <= 0.035 * S || Math.abs(py - 0.62 * S) <= 0.035 * S) && px >= 0.19 * S && px <= 0.45 * S
  // status LEDs
  const led = [[0.54, 0.26]].some(([lx, ly]) => Math.hypot(px - lx * S, py - ly * S) <= 0.03 * S)
  const inBody = body && !slit && !led

  // check mark
  const cd = Math.min(
    distSeg(px, py, 0.49 * S, 0.60 * S, 0.59 * S, 0.74 * S),
    distSeg(px, py, 0.59 * S, 0.74 * S, 0.89 * S, 0.39 * S)
  )
  const wc = 0.085 * S
  const inCheck = cd <= wc
  const inHalo = cd <= wc + 0.05 * S // clear gap around the check, cut from the body

  return inCheck || (inBody && !inHalo)
}

function render(S, fg, bg) {
  const ss = 4, buf = Buffer.alloc(S * S * 4)
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let cov = 0
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) if (inside(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss, S)) cov++
    cov /= ss * ss
    const i = (y * S + x) * 4
    if (bg) { // opaque preview
      buf[i] = Math.round(bg[0] * (1 - cov) + fg[0] * cov); buf[i + 1] = Math.round(bg[1] * (1 - cov) + fg[1] * cov); buf[i + 2] = Math.round(bg[2] * (1 - cov) + fg[2] * cov); buf[i + 3] = 255
    } else {  // black template + alpha
      buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = Math.round(cov * 255)
    }
  }
  return buf
}

const outDir = path.join(__dirname, '..', 'electron', 'assets')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'iconTemplate.png'), png(18, render(18)))
fs.writeFileSync(path.join(outDir, 'iconTemplate@2x.png'), png(36, render(36)))
console.log('wrote template 18 + 36')

if (process.argv.includes('--preview')) {
  const fg = [28, 28, 32], bg = [228, 229, 233]
  fs.writeFileSync(path.join(__dirname, 'preview-80.png'), png(80, render(80, fg, bg)))
  fs.writeFileSync(path.join(__dirname, 'preview-32.png'), png(32, render(32, fg, bg)))
  console.log('wrote previews')
}
