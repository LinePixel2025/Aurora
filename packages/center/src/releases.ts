/**
 * Center 自托管客户端更新产物（docs/09 §10）。
 *
 * 上传先进入 staging，只有 latest.yml、安装包与 blockmap 三者齐全且 sha512 / size 对齐时
 * 才原子切换 index。公开路由只读取当前 index 中列出的文件。
 */
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { CenterReleaseFileInfo, CenterReleaseInfo, Logger } from '@aurora/shared'
import { JsonStore } from './store.js'

interface ReleaseIndex {
  version: 1
  current?: CenterReleaseInfo
}

export interface ReleaseStoreOptions {
  dataDir: string
  logger?: Logger
  maxBytes?: number
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024

export class ReleaseStore {
  private readonly root: string
  private readonly filesRoot: string
  private readonly stagingRoot: string
  private readonly indexStore: JsonStore<ReleaseIndex>
  private readonly maxBytes: number
  private index: ReleaseIndex = { version: 1 }

  constructor(options: ReleaseStoreOptions) {
    this.root = join(options.dataDir, 'releases')
    this.filesRoot = join(this.root, 'files')
    this.stagingRoot = join(this.root, '.staging')
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.indexStore = new JsonStore<ReleaseIndex>(
      join(this.root, 'index.json'),
      () => ({ version: 1 }),
      options.logger,
    )
  }

  async init(): Promise<void> {
    await fs.mkdir(this.filesRoot, { recursive: true })
    await fs.mkdir(this.stagingRoot, { recursive: true })
    this.index = await this.indexStore.load()
  }

  current(): CenterReleaseInfo | undefined {
    return this.index.current === undefined ? undefined : structuredClone(this.index.current)
  }

  async stage(name: string, body: Buffer): Promise<void> {
    if (!isAllowedReleaseFile(name)) throw new Error('不允许的发布文件名')
    if (body.byteLength > this.maxBytes) throw new Error('发布文件超过大小上限')
    await fs.mkdir(this.stagingRoot, { recursive: true })
    await fs.writeFile(join(this.stagingRoot, name), body)
  }

  async publish(): Promise<CenterReleaseInfo> {
    const names = await fs.readdir(this.stagingRoot).catch(() => [])
    const manifestName = names.find((name) => name === 'latest.yml')
    const installerName = names.find((name) => /^Aurora-Setup-\d+\.\d+\.\d+\.exe$/.test(name))
    const blockmapName = names.find((name) =>
      /^Aurora-Setup-\d+\.\d+\.\d+\.exe\.blockmap$/.test(name),
    )
    if (manifestName === undefined || installerName === undefined || blockmapName === undefined) {
      throw new Error('发布需要同时上传 latest.yml、安装包与 blockmap')
    }
    if (blockmapName !== `${installerName}.blockmap`) {
      throw new Error('blockmap 与安装包不匹配')
    }

    const manifest = await fs.readFile(join(this.stagingRoot, manifestName), 'utf8')
    const version = yamlScalar(manifest, 'version')
    const entry = yamlFileEntry(manifest)
    if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error('latest.yml 缺少合法 version')
    }
    if (entry.url !== installerName) throw new Error('latest.yml 指向的安装包不匹配')

    const installer = await fs.readFile(join(this.stagingRoot, installerName))
    const blockmap = await fs.readFile(join(this.stagingRoot, blockmapName))
    const sha512 = createHash('sha512').update(installer).digest('base64')
    if (entry.size !== installer.byteLength) throw new Error('latest.yml size 与实际安装包不一致')
    if (entry.sha512 !== sha512) throw new Error('latest.yml sha512 与实际安装包不一致')

    const targetDir = join(this.filesRoot, version)
    const tempDir = join(this.filesRoot, `.publish-${randomBytes(4).toString('hex')}`)
    await fs.mkdir(tempDir, { recursive: true })
    await fs.writeFile(join(tempDir, installerName), installer)
    await fs.writeFile(join(tempDir, blockmapName), blockmap)
    await fs.writeFile(join(tempDir, manifestName), manifest)
    await fs.rm(targetDir, { recursive: true, force: true })
    await fs.rename(tempDir, targetDir)

    const files: CenterReleaseFileInfo[] = [
      fileInfo(installerName, installer, 'installer'),
      fileInfo(blockmapName, blockmap, 'blockmap'),
      fileInfo(manifestName, Buffer.from(manifest, 'utf8'), 'manifest'),
    ]
    const info: CenterReleaseInfo = {
      version,
      publishedAt: new Date().toISOString(),
      channel: 'latest',
      files,
    }
    this.index = { version: 1, current: info }
    await this.indexStore.save(this.index)
    await fs.rm(this.stagingRoot, { recursive: true, force: true })
    await fs.mkdir(this.stagingRoot, { recursive: true })
    return structuredClone(info)
  }

  /** 当前 index 中某个公开资产的文件路径；未登记文件名返回 undefined。 */
  assetPath(name: string): string | undefined {
    if (basename(name) !== name) return undefined
    const current = this.index.current
    if (current === undefined) return undefined
    if (!current.files.some((file) => file.name === name)) return undefined
    return join(this.filesRoot, current.version, name)
  }
}

function isAllowedReleaseFile(name: string): boolean {
  return (
    name === 'latest.yml' ||
    /^Aurora-Setup-\d+\.\d+\.\d+\.exe$/.test(name) ||
    /^Aurora-Setup-\d+\.\d+\.\d+\.exe\.blockmap$/.test(name)
  )
}

function fileInfo(
  name: string,
  body: Buffer,
  kind: CenterReleaseFileInfo['kind'],
): CenterReleaseFileInfo {
  return {
    name,
    size: body.byteLength,
    sha512: createHash('sha512').update(body).digest('base64'),
    kind,
  }
}

function yamlScalar(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '')
}

function yamlFileEntry(text: string): { url?: string; sha512?: string; size?: number } {
  const url = /-\s*url:\s*(.+)$/m.exec(text)?.[1]?.trim()
  const sha512 = /^\s*sha512:\s*(.+)$/m.exec(text)?.[1]?.trim()
  const rawSize = /^\s*size:\s*(\d+)\s*$/m.exec(text)?.[1]
  return {
    url,
    sha512,
    ...(rawSize === undefined ? {} : { size: Number(rawSize) }),
  }
}
