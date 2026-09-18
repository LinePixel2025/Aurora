#!/usr/bin/env node
/**
 * 生成 Aurora 占位图标（托盘 + 应用图标）。
 *
 * 为什么用脚本生成：仓库不引入二进制设计资产，且图标属于 P6 品牌工作；
 * 这里用纯 Node（zlib + 手写 PNG chunk）生成 16/32/64/256 的多尺寸图标，
 * 保证 `pnpm dev` 与打包都能拿到真实 PNG。
 *
 * 用法：node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'apps', 'desktop', 'resources')
mkdirSync(outDir, { recursive: true })

/** 极光绿 → 蓝的竖向渐变圆点，带透明边缘 */
function render(size) {
  const radius = size / 2
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - radius
      const dy = y + 0.5 - radius
      const distance = Math.hypot(dx, dy)
      const index = (y * size + x) * 4
      // 抗锯齿：边缘 1px 渐变
      const alpha = Math.max(0, Math.min(1, radius - distance))
      if (alpha <= 0) continue
      const t = y / Math.max(1, size - 1)
      pixels[index] = Math.round(56 + t * (86 - 56)) // R: 极光绿 → 蓝
      pixels[index + 1] = Math.round(209 + t * (132 - 209)) // G
      pixels[index + 2] = Math.round(150 + t * (255 - 150)) // B
      pixels[index + 3] = Math.round(alpha * 255)
    }
  }
  return encodePng(size, size, pixels)
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

const targets = [
  ['tray-16.png', 16],
  ['tray-32.png', 32],
  ['icon-64.png', 64],
  ['icon-256.png', 256],
]

for (const [name, size] of targets) {
  const buffer = render(size)
  writeFileSync(join(outDir, name), buffer)
  console.log(`generated ${name} (${size}×${size}, ${buffer.length} bytes)`)
}

// 托盘默认图标
writeFileSync(join(outDir, 'tray.png'), render(16))
console.log('generated tray.png (16×16)')

/**
 * 打包用 ICO：electron-builder 在缺少 .ico 时会去下载 winCodeSign 工具链转换，
 * 而那是联网 + 首次运行才有的依赖。这里直接按 ICO 容器格式写入内嵌 PNG
 * （Vista+ 支持 PNG 压缩的图标条目），让打包**离线可完成**。
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const icoImages = ICO_SIZES.map((size) => ({ size, png: render(size) }))
writeFileSync(join(outDir, 'icon.ico'), encodeIco(icoImages))
console.log(`generated icon.ico (${ICO_SIZES.join('/')}, ${ICO_SIZES.length} entries)`)

function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length

  images.forEach((image, index) => {
    const entry = index * 16
    // 256 在 ICO 目录里用 0 表示
    directory[entry] = image.size >= 256 ? 0 : image.size
    directory[entry + 1] = image.size >= 256 ? 0 : image.size
    directory[entry + 2] = 0 // 调色板数量
    directory[entry + 3] = 0 // reserved
    directory.writeUInt16LE(1, entry + 4) // color planes
    directory.writeUInt16LE(32, entry + 6) // bits per pixel
    directory.writeUInt32LE(image.png.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += image.png.length
  })

  return Buffer.concat([header, directory, ...images.map((image) => image.png)])
}
