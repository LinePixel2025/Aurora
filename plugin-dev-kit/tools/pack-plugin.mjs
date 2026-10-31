#!/usr/bin/env node
/* global process, Buffer */
/**
 * 把插件目录打成可安装 / 可上传 Aurora Center 市场的 zip（工具包 v0.5.9）。
 *
 *   node tools/pack-plugin.mjs <插件目录> [--out <输出.zip>] [--no-check]
 *
 * - 包根必须直接是 manifest.json（不做外层目录）；
 * - 打包前默认先跑 `tools/check-plugin.mjs`，不通过就不产出包；
 * - 只使用 Node 内置模块（zlib 压缩 + 手写 zip 头），零依赖；
 * - 跳过 node_modules / .git / 系统垃圾文件，并拒绝会超过宿主安装上限的包
 *   （条目 ≤ 2000、单文件 ≤ 10 MB、解压总量 ≤ 50 MB）。
 *
 * 产物可直接用于「设置 → 插件 → 安装插件包」，或上传到 Center 插件市场。
 */
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const EXIT_OK = 0
const EXIT_INVALID = 1
const EXIT_USAGE = 2

const HERE = dirname(fileURLToPath(import.meta.url))

const LIMITS = {
  maxEntries: 2000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
}

const SKIP_NAMES = new Set(['node_modules', '.git', '.DS_Store', 'Thumbs.db', '.env'])

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(EXIT_INVALID)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function parseTarget() {
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--out') {
      index += 1
      continue
    }
    if (arg.startsWith('--')) continue
    return arg
  }
  return undefined
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

async function collectFiles(root) {
  const files = []
  const walk = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.endsWith('.zip')) continue
      const stat = await fs.stat(absolute)
      files.push({
        absolute,
        name: relative(root, absolute).split('\\').join('/'),
        mtime: stat.mtime,
        size: stat.size,
      })
    }
  }
  await walk(root)
  files.sort((left, right) => left.name.localeCompare(right.name))
  return files
}

async function buildZip(files) {
  const localChunks = []
  const centralChunks = []
  let offset = 0

  for (const file of files) {
    const data = await fs.readFile(file.absolute)
    if (data.byteLength > LIMITS.maxFileBytes) {
      throw new Error(`单文件超过 10 MB：${file.name}`)
    }
    const compressed = deflateRawSync(data, { level: 9 })
    const useDeflate = compressed.byteLength < data.byteLength
    const payload = useDeflate ? compressed : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)
    const nameBuffer = Buffer.from(file.name, 'utf8')
    const { time, date } = dosDateTime(file.mtime)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.byteLength, 18)
    local.writeUInt32LE(data.byteLength, 22)
    local.writeUInt16LE(nameBuffer.byteLength, 26)
    local.writeUInt16LE(0, 28)

    localChunks.push(local, nameBuffer, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.byteLength, 20)
    central.writeUInt32LE(data.byteLength, 24)
    central.writeUInt16LE(nameBuffer.byteLength, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, nameBuffer)

    offset += local.byteLength + nameBuffer.byteLength + payload.byteLength
  }

  const centralSize = centralChunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, ...centralChunks, end])
}

async function main() {
  const target = parseTarget()
  if (target === undefined) {
    console.error('用法：node tools/pack-plugin.mjs <插件目录> [--out <输出.zip>] [--no-check]')
    process.exit(EXIT_USAGE)
  }
  const root = resolve(process.cwd(), target)
  const stat = await fs.stat(root).catch(() => null)
  if (stat === null || !stat.isDirectory()) fail(`插件目录不存在：${root}`)

  const manifestPath = join(root, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch {
    fail('缺少根目录 manifest.json（或不是合法 JSON）')
  }
  const outArg = argValue('--out')
  const outPath =
    outArg === undefined
      ? resolve(process.cwd(), `${manifest.id}-${manifest.version}.zip`)
      : resolve(process.cwd(), outArg)

  if (!process.argv.includes('--no-check')) {
    const check = spawnSync(process.execPath, [join(HERE, 'check-plugin.mjs'), root], {
      stdio: 'inherit',
    })
    if (check.status !== 0) {
      fail('校验未通过，未生成 zip（可用 --no-check 跳过，不推荐）')
    }
  }

  const files = await collectFiles(root)
  if (files.length === 0) fail('插件目录里没有可打包的文件')
  if (files.length > LIMITS.maxEntries) fail(`条目超过 ${LIMITS.maxEntries} 个`)
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > LIMITS.maxTotalBytes) fail('解压总量超过 50 MB')
  if (!files.some((file) => file.name === 'manifest.json')) {
    fail('manifest.json 必须在包根')
  }

  const zip = await buildZip(files)
  await fs.writeFile(outPath, zip)
  console.log(`✓ 已生成插件包：${outPath}`)
  console.log(`  文件 ${files.length} 个，压缩后 ${(zip.byteLength / 1024).toFixed(1)} KB`)
  console.log('  安装：设置 → 插件 → 安装插件包；上传市场：Center 管理页 → 插件 → 上传。')
  process.exit(EXIT_OK)
}

main().catch((cause) => {
  console.error(`✗ 打包失败：${String(cause)}`)
  process.exit(EXIT_INVALID)
})
