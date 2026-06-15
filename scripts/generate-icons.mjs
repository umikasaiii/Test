// Generates PWA icons using Canvas API via node-canvas
// Run: node scripts/generate-icons.mjs
import { createCanvas } from 'canvas'
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '..', 'public', 'icons')
mkdirSync(outDir, { recursive: true })

const sizes = [72, 96, 128, 192, 384, 512]

for (const size of sizes) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, size, size)
  grad.addColorStop(0, '#1f2937')
  grad.addColorStop(1, '#111827')
  ctx.fillStyle = grad
  roundRect(ctx, 0, 0, size, size, size * 0.22)
  ctx.fill()

  // Orange circle accent
  ctx.beginPath()
  ctx.arc(size * 0.5, size * 0.45, size * 0.32, 0, Math.PI * 2)
  ctx.fillStyle = '#f97316'
  ctx.fill()

  // Hard hat silhouette (simplified)
  const hw = size * 0.38
  const hh = size * 0.26
  const hx = size * 0.5 - hw / 2
  const hy = size * 0.28
  ctx.fillStyle = '#ffffff'
  // brim
  roundRect(ctx, hx - size * 0.04, hy + hh * 0.65, hw + size * 0.08, hh * 0.22, 4)
  ctx.fill()
  // dome
  ctx.beginPath()
  ctx.ellipse(size * 0.5, hy + hh * 0.5, hw * 0.5, hh * 0.55, 0, Math.PI, 0)
  ctx.fillStyle = '#ffffff'
  ctx.fill()

  // "EG" text below
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${size * 0.14}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('EdilGest', size * 0.5, size * 0.8)

  writeFileSync(join(outDir, `icon-${size}.png`), canvas.toBuffer('image/png'))
  console.log(`icon-${size}.png ✓`)
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}
