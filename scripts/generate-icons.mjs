#!/usr/bin/env node
/**
 * 生成 Aurora 图标（托盘 + 应用图标）。
 *
 * 设计稿：`scripts/assets/aurora-icon.png`（浅色底 + 黑色字母 A）。
 * 这里把设计稿居中裁成正方形，再套透明圆角矩形蒙版，最后用面积平均（box filter）
 * 重采样出各尺寸，所以从 16px 托盘到 256px 应用图标都是同一张圆角稿子，
 * 改稿只需替换这张 PNG。
 *
 * 为什么用脚本生成：仓库运行时只消费 PNG / ICO，不把多份派生产物当手改资产。
 * 解码 / 重采样 / 编码全部用纯 Node（zlib + 手写 PNG / ICO chunk），离线、可重复，
 * `pnpm icons` 一条命令即可重放。
 *
 * 用法：node scripts/generate-icons.mjs
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(here, 'assets', 'aurora-icon.png')
const outDir = join(here, '..', 'apps', 'desktop', 'resources')
mkdirSync(outDir, { recursive: true })

/* ------------------------------------------------------------------ *
 * PNG 解码：仅支持 8bit RGBA（color type 6）、非隔行 —— 也正是设计稿的格式
 * ------------------------------------------------------------------ */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是有效的 PNG 文件')
  const view = { width: 0, height: 0, depth: 0, colorType: 0, interlace: 0 }
  const idat = []
  let offset = 8
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      view.width = data.readUInt32BE(0)
      view.height = data.readUInt32BE(4)
      view.depth = data[8]
      view.colorType = data[9]
      view.interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (view.depth !== 8 || view.colorType !== 6 || view.interlace !== 0) {
    throw new Error(
      `设计稿需为 8bit RGBA 非隔行 PNG（当前 depth=${view.depth} colorType=${view.colorType} interlace=${view.interlace}）`,
    )
  }

  const raw = inflateSync(Buffer.concat(idat))
  const { width, height } = view
  const stride = width * 4
  const pixels = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const lineStart = y * (stride + 1) + 1
    const cur = pixels.subarray(y * stride, (y + 1) * stride)
    raw.copy(cur, 0, lineStart, lineStart + stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0
      const b = prev[i]
      const c = i >= 4 ? prev[i - 4] : 0
      if (filter === 0) continue
      if (filter === 1) cur[i] = (cur[i] + a) & 0xff
      else if (filter === 2) cur[i] = (cur[i] + b) & 0xff
      else if (filter === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      } else throw new Error(`不支持的 PNG 行过滤器 ${filter}`)
    }
    prev = cur
  }
  return { width, height, pixels }
}

/** 居中裁成正方形（设计稿 811×778 左右各裁掉一点即可完整保留字母） */
function cropSquare(image) {
  const side = Math.min(image.width, image.height)
  if (image.width === side && image.height === side) return image
  const offsetX = (image.width - side) >> 1
  const offsetY = (image.height - side) >> 1
  const pixels = Buffer.alloc(side * side * 4)
  for (let y = 0; y < side; y++) {
    const from = ((y + offsetY) * image.width + offsetX) * 4
    image.pixels.copy(pixels, y * side * 4, from, from + side * 4)
  }
  return { width: side, height: side, pixels }
}

/**
 * 透明圆角矩形蒙版。
 *
 * 圆角半径取边长的 22%，边缘由 1px 覆盖带做抗锯齿；再交给面积平均重采样，
 * 16px 托盘图标也不会出现硬方角。
 */
const ROUNDED_CORNER_RATIO = 0.22

function applyRoundedRectMask(image) {
  const { width, height, pixels } = image
  const radius = Math.min(width, height) * ROUNDED_CORNER_RATIO
  const halfWidth = width / 2
  const halfHeight = height / 2
  const out = Buffer.from(pixels)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const qx = Math.abs(x + 0.5 - halfWidth) - (halfWidth - radius)
      const qy = Math.abs(y + 0.5 - halfHeight) - (halfHeight - radius)
      const distance =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
      const coverage = Math.min(1, Math.max(0, 0.5 - distance))
      if (coverage >= 1) continue
      const alphaIndex = (y * width + x) * 4 + 3
      out[alphaIndex] = Math.round(out[alphaIndex] * coverage)
    }
  }

  return { width, height, pixels: out }
}

/**
 * 仅保留主体图形的透明稿。
 *
 * 明度越低越保留、越高越透明；低于约 6% 的浅灰阴影直接归零。输出像素统一为黑色，
 * 只让 alpha 表达抗锯齿，避免把源图的白底或阴影带到深色背景上。
 */
function createTransparentMark(image) {
  const { width, height, pixels } = image
  const out = Buffer.alloc(width * height * 4)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const luminance = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]
      const coverage = Math.min(1, Math.max(0, (200 - luminance) / 150))
      const alpha = coverage <= 0.06 ? 0 : (coverage - 0.06) / 0.94
      out[i + 3] = Math.round(pixels[i + 3] * alpha)
    }
  }

  return { width, height, pixels: out }
}

/**
 * 面积平均重采样（按重叠面积加权、预乘 alpha）。
 * 缩到 16px 时一个目标像素要平均约 48×48 个源像素，纯最近邻会严重锯齿。
 */
function resizeArea(image, size) {
  const { width: sw, height: sh, pixels: src } = image
  const out = Buffer.alloc(size * size * 4)
  for (let dy = 0; dy < size; dy++) {
    const sy0 = (dy * sh) / size
    const sy1 = ((dy + 1) * sh) / size
    for (let dx = 0; dx < size; dx++) {
      const sx0 = (dx * sw) / size
      const sx1 = ((dx + 1) * sw) / size
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let sumA = 0
      let sumW = 0
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0)
        if (wy <= 0) continue
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0)
          if (wx <= 0) continue
          const w = wx * wy
          const i = (sy * sw + sx) * 4
          const alpha = src[i + 3] / 255
          sumR += src[i] * alpha * w
          sumG += src[i + 1] * alpha * w
          sumB += src[i + 2] * alpha * w
          sumA += alpha * w
          sumW += w
        }
      }
      const o = (dy * size + dx) * 4
      if (sumA <= 0) continue
      out[o] = Math.round(sumR / sumA)
      out[o + 1] = Math.round(sumG / sumA)
      out[o + 2] = Math.round(sumB / sumA)
      out[o + 3] = Math.round((sumA / sumW) * 255)
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * PNG 编码
 * ------------------------------------------------------------------ */
function encodePng(size, rgba) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
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

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */
const square = cropSquare(decodePng(readFileSync(sourcePath)))
const master = applyRoundedRectMask(square)
const transparentMark = createTransparentMark(square)
console.log(`source ${sourcePath} → square ${square.width}×${square.height} → rounded rect`)

const targets = [
  ['tray-16.png', 16],
  ['tray-32.png', 32],
  ['icon-64.png', 64],
  ['icon-256.png', 256],
]

for (const [name, size] of targets) {
  const buffer = encodePng(size, resizeArea(master, size))
  writeFileSync(join(outDir, name), buffer)
  console.log(`generated ${name} (${size}×${size}, ${buffer.length} bytes)`)
}

// 托盘默认图标
writeFileSync(join(outDir, 'tray.png'), encodePng(16, resizeArea(master, 16)))
console.log('generated tray.png (16×16)')

// 渲染层品牌标：桌面与 Center Web 共用 theme.css 的 `.aurora-mark` 指向这一张
const markPath = join(
  here,
  '..',
  'packages',
  'shared',
  'src',
  'browser',
  'assets',
  'aurora-mark.png',
)
const markSize = 256
writeFileSync(markPath, encodePng(markSize, resizeArea(master, markSize)))
console.log(
  `generated packages/shared/src/browser/assets/aurora-mark.png (${markSize}×${markSize})`,
)

// 主界面聊天空态：只保留主体 A，不带白底、圆角卡片或投影
const bareMarkPath = join(
  here,
  '..',
  'packages',
  'shared',
  'src',
  'browser',
  'assets',
  'aurora-mark-transparent.png',
)
writeFileSync(bareMarkPath, encodePng(markSize, resizeArea(transparentMark, markSize)))
console.log(
  `generated packages/shared/src/browser/assets/aurora-mark-transparent.png (${markSize}×${markSize})`,
)

/**
 * 打包用 ICO：electron-builder 在缺少 .ico 时会去下载 winCodeSign 工具链转换，
 * 而那是联网 + 首次运行才有的依赖。这里直接按 ICO 容器格式写入内嵌 PNG
 * （Vista+ 支持 PNG 压缩的图标条目），让打包**离线可完成**。
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const icoImages = ICO_SIZES.map((size) => ({
  size,
  png: encodePng(size, resizeArea(master, size)),
}))
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
