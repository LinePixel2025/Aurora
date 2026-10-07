import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ReleaseStore } from './releases.js'

const dirs: string[] = []

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-center-release-'))
  dirs.push(dir)
  const store = new ReleaseStore({ dataDir: dir })
  await store.init()
  return store
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Center Release 存储', () => {
  it('校验 latest.yml 与安装包并原子切换 latest', async () => {
    const store = await makeStore()
    const installer = Buffer.from('fake-installer')
    const blockmap = Buffer.from('fake-blockmap')
    const sha512 = createHash('sha512').update(installer).digest('base64')
    const manifest = [
      'version: 1.2.3',
      'files:',
      '  - url: Aurora-Setup-1.2.3.exe',
      `    sha512: ${sha512}`,
      `    size: ${installer.byteLength}`,
      '',
    ].join('\n')
    await store.stage('Aurora-Setup-1.2.3.exe', installer)
    await store.stage('Aurora-Setup-1.2.3.exe.blockmap', blockmap)
    await store.stage('latest.yml', Buffer.from(manifest))
    const current = await store.publish()
    expect(current.version).toBe('1.2.3')
    expect(store.assetPath('Aurora-Setup-1.2.3.exe')).toBeDefined()
    expect(store.current()?.files).toHaveLength(3)
  })

  it('sha512 不匹配时拒绝发布；路径穿越资产不可读', async () => {
    const store = await makeStore()
    const installer = Buffer.from('fake')
    await store.stage('Aurora-Setup-1.2.3.exe', installer)
    await store.stage('Aurora-Setup-1.2.3.exe.blockmap', Buffer.from('x'))
    await store.stage(
      'latest.yml',
      Buffer.from(
        'version: 1.2.3\nfiles:\n  - url: Aurora-Setup-1.2.3.exe\n    sha512: bad\n    size: 4\n',
      ),
    )
    await expect(store.publish()).rejects.toThrow(/sha512/)
    expect(store.assetPath('../latest.yml')).toBeUndefined()
  })
})
