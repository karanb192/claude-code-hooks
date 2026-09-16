import sharp from 'sharp'
import { writeFileSync } from 'node:fs'

const C = {
  void: '#0A0B0D', panel: '#101216', line: '#23272E', text: '#E7EAEE', dim: '#9BA2AC', faint: '#5C636D',
  block: '#FF5C46', amber: '#E3B341', pass: '#3FB950',
  iceTop: '#BFEFFF', iceLeft: '#5FC6F2', iceRight: '#2E8FC4', iceEdge: '#E9FBFF',
  warmTop: '#FFE2A3', warmLeft: '#F0B54A', warmRight: '#C4831C', warmEdge: '#FFF3D6',
}
const MONO = "'JetBrains Mono', Menlo, monospace"
const SANS = "'Inter', 'Helvetica Neue', Arial, sans-serif"

// An isometric cube: top, left, right faces plus a bright edge, in a 100x100 box.
function cube(x, y, size, warm = false) {
  const p = warm ? [C.warmTop, C.warmLeft, C.warmRight, C.warmEdge] : [C.iceTop, C.iceLeft, C.iceRight, C.iceEdge]
  const s = size / 100
  const pt = (px, py) => `${(x + px * s).toFixed(2)},${(y + py * s).toFixed(2)}`
  return `
  <g>
    <polygon points="${pt(50, 8)} ${pt(92, 32)} ${pt(50, 56)} ${pt(8, 32)}" fill="${p[0]}"/>
    <polygon points="${pt(8, 32)} ${pt(50, 56)} ${pt(50, 100)} ${pt(8, 76)}" fill="${p[1]}"/>
    <polygon points="${pt(50, 56)} ${pt(92, 32)} ${pt(92, 76)} ${pt(50, 100)}" fill="${p[2]}"/>
    <polyline points="${pt(8, 32)} ${pt(50, 56)} ${pt(92, 32)}" fill="none" stroke="${p[3]}" stroke-width="${(2.2 * s).toFixed(2)}" stroke-linejoin="round"/>
    <line x1="${(x + 50 * s).toFixed(2)}" y1="${(y + 56 * s).toFixed(2)}" x2="${(x + 50 * s).toFixed(2)}" y2="${(y + 100 * s).toFixed(2)}" stroke="${p[3]}" stroke-width="${(2.2 * s).toFixed(2)}" opacity="0.7"/>
    <polyline points="${pt(20, 26)} ${pt(50, 12)} ${pt(80, 26)}" fill="none" stroke="#FFFFFF" stroke-width="${(1.6 * s).toFixed(2)}" opacity="0.55" stroke-linecap="round"/>
  </g>`
}

function icon(size, warm = false) {
  const r = size * 0.22
  const pad = size * 0.14
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" fill="${C.panel}"/>
  <rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="${r}" fill="none" stroke="${C.line}"/>
  ${cube(pad, pad, size - 2 * pad, warm)}
</svg>`
}

function chip(x, y, label, color) {
  const w = label.length * 13.2 + 34
  return `<rect x="${x}" y="${y}" width="${w}" height="40" rx="8" fill="${C.void}" stroke="${color}" stroke-opacity="0.55"/>
  <text x="${x + 17}" y="${y + 27}" font-family="${MONO}" font-size="21" fill="${color}">${label}</text>`
}

function card(w, h) {
  const cubeSize = h * 0.42
  const cx = w * 0.075, cy = (h - cubeSize) / 2 - h * 0.04
  const tx = cx + cubeSize + w * 0.06
  const base = h * 0.40
  const chips = [['read $0.25/MTok', C.iceLeft], ['write $20/MTok', C.block], ['80x', C.amber]]
  let chipX = tx, chipSvg = ''
  for (const [l, c] of chips) { chipSvg += chip(chipX, base + h * 0.245, l, c); chipX += l.length * 13.2 + 34 + 14 }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="g" cx="0.18" cy="0.5" r="0.7"><stop offset="0" stop-color="#17303F"/><stop offset="1" stop-color="${C.void}"/></radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  ${cube(cx, cy, cubeSize)}
  <text x="${tx}" y="${base}" font-family="${MONO}" font-size="${h * 0.15}" font-weight="700" fill="${C.text}">cache-tax</text>
  <text x="${tx}" y="${base + h * 0.095}" font-family="${SANS}" font-size="${h * 0.046}" fill="${C.dim}">The comeback price of a cold prompt cache,</text>
  <text x="${tx}" y="${base + h * 0.155}" font-family="${SANS}" font-size="${h * 0.046}" fill="${C.dim}">before you pay it.</text>
  ${chipSvg}
  <text x="${tx}" y="${h - h * 0.075}" font-family="${MONO}" font-size="${h * 0.03}" fill="${C.faint}">a Claude Code hook and a Claude Mod  ·  hooks.karanbansal.in</text>
</svg>`
}

const out = async (name, svg, opts = {}) => {
  writeFileSync(`${name}.svg`, svg)
  await sharp(Buffer.from(svg), { density: 192 }).resize(opts.w, opts.h).png().toFile(`${name}.png`)
  console.log('wrote', name + '.png')
}
await out('cache-tax-icon-512', icon(512), { w: 512, h: 512 })
await out('cache-tax-icon-warm-512', icon(512, true), { w: 512, h: 512 })
await out('cache-tax-favicon-32', icon(32), { w: 32, h: 32 })
await out('cache-tax-social-1280x640', card(1280, 640), { w: 1280, h: 640 })
await out('cache-tax-x-1200x675', card(1200, 675), { w: 1200, h: 675 })
