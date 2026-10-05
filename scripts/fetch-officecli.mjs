import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '1.0.153'
const TAG = `v${VERSION}`
const ASSET = 'officecli-win-x64.exe'
const SHA256 = '05dd712595690672ea1c220a516c0996a27f7c3e7f870a270c19d538e9fc04f3'
const GITHUB = `https://github.com/iOfficeAI/OfficeCLI/releases/download/${TAG}`
const MIRROR = `https://d.officecli.ai/releases/download/${TAG}`

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(`OfficeCLI ${VERSION} 当前只随 Windows x64 分发`)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'apps', 'desktop', 'resources', 'officecli')
const binaryPath = join(outDir, 'officecli.exe')
const licensePath = join(outDir, 'LICENSE')
const versionPath = join(outDir, 'VERSION.txt')
const force = process.argv.includes('--force')

await fs.mkdir(outDir, { recursive: true })

if (force || !(await matchesSha256(binaryPath, SHA256))) {
  const bytes = await downloadFirst([`${MIRROR}/${ASSET}`, `${GITHUB}/${ASSET}`])
  const actual = sha256(bytes)
  if (actual !== SHA256) {
    throw new Error(`OfficeCLI SHA256 不匹配：expected=${SHA256} actual=${actual}`)
  }
  await fs.writeFile(binaryPath, bytes)
  console.log(`[officecli] ${binaryPath} (${bytes.byteLength} bytes, sha256 ${actual})`)
} else {
  console.log(`[officecli] ${binaryPath} 已存在且 SHA256 匹配`)
}

if (force || !(await exists(licensePath))) {
  const license = await downloadFirst([
    'https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/main/LICENSE',
  ])
  await fs.writeFile(licensePath, license)
}

await fs.writeFile(
  versionPath,
  [
    `version=${VERSION}`,
    `asset=${ASSET}`,
    `sha256=${SHA256}`,
    `source=https://github.com/iOfficeAI/OfficeCLI`,
    '',
  ].join('\n'),
  'utf8',
)

async function matchesSha256(path, expected) {
  try {
    return sha256(await fs.readFile(path)) === expected
  } catch {
    return false
  }
}

async function exists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function downloadFirst(urls) {
  let lastError
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'aurora-build' },
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
