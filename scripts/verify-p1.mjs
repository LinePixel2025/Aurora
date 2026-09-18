#!/usr/bin/env node
/**
 * 端到端验收脚本（真实磁盘，不依赖 Electron UI）。
 *
 * 覆盖 docs/04 §P1 验收中的关键点：
 *  1. 全新环境 → 配置落盘 → 结构正确、version=当前 CONFIG_VERSION、需要引导
 *  2. 写入 API Key → 磁盘上无明文、重启后可解密读回
 *  3. 损坏配置 → 备份 + 重建
 *  4. 字段非法 → 字段级回退默认值
 *  5. 旧版本配置 → 迁移链执行
 *
 * 用法：node scripts/verify-p1.mjs
 * 退出码 0 = 全部通过。
 */
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const shared = require('../packages/shared/dist/index.js')

const { SettingsStore, CONFIG_VERSION } = shared

/** 可逆的假 safeStorage：真实实现由 Electron safeStorage 提供（见 apps/desktop/src/main/crypto.ts） */
const crypto = {
  isAvailable: () => true,
  encrypt: (plain) => `fake-v1:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (cipher) => {
    if (!cipher.startsWith('fake-v1:')) throw new Error('invalid ciphertext')
    return Buffer.from(cipher.slice('fake-v1:'.length), 'base64').toString('utf8')
  },
}

const checks = []
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 已创建的 store：写盘前必须先 flush + dispose，否则在途写会覆盖新 fixture */
const liveStores = []

async function disposeStores() {
  for (const store of liveStores.splice(0)) {
    try {
      await store.flush()
    } catch {
      /* 忽略：测试夹具不关心上一次写入结果 */
    }
    store.dispose()
  }
}

async function newStore(dir) {
  // 新一轮读取前先排空旧实例的在途写，避免与 fixture 写入竞争
  await disposeStores()
  const store = new SettingsStore({ dir, crypto, writeDebounceMs: 0 })
  const report = await store.init()
  liveStores.push(store)
  return { store, report }
}

/** 覆盖 fixture 前先断开所有旧 store，保证磁盘状态可控 */
async function writeFixture(path, content) {
  await disposeStores()
  await fs.writeFile(path, content, 'utf8')
}

async function main() {
  const root = await fs.mkdtemp(join(tmpdir(), 'aurora-verify-'))
  const dir = join(root, 'Aurora')
  const configPath = join(dir, 'config.json')
  const secret = 'sk-verify-super-secret-1234'

  try {
    // ① 全新环境
    const { store, report } = await newStore(dir)
    check('全新环境：创建配置文件', report.created)
    check('全新环境：需要首次引导', report.needsOnboarding)
    check('安全存储可用', report.cryptoAvailable)
    await store.flush()
    const fresh = JSON.parse(await fs.readFile(configPath, 'utf8'))
    check('config.version = 当前版本', fresh.version === CONFIG_VERSION, `version=${fresh.version}`)
    check('默认模式为 classroom', fresh.modes.current === 'classroom')
    check('默认科目为九科模板', fresh.modes.classroom.subjects.length === 9)
    check('未配置模型时 llm.active 为空', fresh.llm.active === '')

    // ② 写入模型配置 + API Key
    store.update({
      llm: {
        active: 'deepseek',
        providers: {
          deepseek: {
            type: 'openai-compat',
            baseUrl: 'https://api.deepseek.com',
            apiKeyEnc: '',
            model: 'deepseek-chat',
            temperature: 0.7,
          },
        },
      },
    })
    const persisted = store.setSecret('llm.providers.deepseek.apiKey', secret)
    await store.flush()
    check('API Key 已加密落盘', persisted)
    const raw = await fs.readFile(configPath, 'utf8')
    check('磁盘不含明文 API Key', !raw.includes(secret))
    check('磁盘包含密文标记', raw.includes('fake-v1:'))
    check('配置文件无 apiKey 明文字段', !raw.includes('"apiKey"'))
    check('needsOnboarding 变为 false', store.needsOnboarding() === false)

    // ③ 重启后读回
    const reopened = await newStore(dir)
    check('重启后不再需要引导', !reopened.report.needsOnboarding)
    check(
      '重启后可解密读回 API Key',
      reopened.store.getSecret('llm.providers.deepseek.apiKey') === secret,
    )

    // ④ 损坏配置
    await writeFixture(configPath, '{ 这不是合法 JSON')
    const corrupt = await newStore(dir)
    check('损坏配置被识别', corrupt.report.corrupted)
    check('损坏配置已备份', typeof corrupt.report.backupPath === 'string')
    const backups = (await fs.readdir(dir)).filter((name) => name.startsWith('config.corrupt-'))
    check('备份文件存在于磁盘', backups.length === 1, backups.join(','))
    check('损坏后回退默认配置', corrupt.store.get().modes.current === 'classroom')

    // ⑤ 字段级回退
    await writeFixture(
      configPath,
      JSON.stringify({ version: 1, general: { language: 123, hotkey: 'Ctrl+Alt+A' } }),
    )
    const repaired = await newStore(dir)
    check('非法字段回退默认值', repaired.store.get().general.language === 'zh-CN')
    check('合法字段被保留', repaired.store.get().general.hotkey === 'Ctrl+Alt+A')
    check('记录了字段级问题', repaired.report.sanitizeIssues.length >= 1)

    // ⑥ 旧版本迁移（v0 扁平 apiKey）
    await writeFixture(
      configPath,
      JSON.stringify({
        mode: 'classroom',
        llm: {
          apiKey: 'sk-legacy-plain',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
        },
      }),
    )
    const migrated = await newStore(dir)
    await migrated.store.flush()
    // v0 缺 version 字段，需连续走完 0→1→…→当前版本；断言"迁移确实发生"而非条数，
    // 这样每次新增迁移（如 v1→v2 补分类配置）都不需要改本脚本。
    check(
      '执行了 v0 → 当前版本的迁移链',
      migrated.report.appliedMigrations.length === CONFIG_VERSION,
      `count=${migrated.report.appliedMigrations.length}/${CONFIG_VERSION}`,
    )
    check('模式字段已归一', migrated.store.get().modes.current === 'classroom')
    const migratedRaw = await fs.readFile(configPath, 'utf8')
    check(
      '迁移后的明文凭据被补加密',
      !migratedRaw.includes('sk-legacy-plain') && migratedRaw.includes('fake-v1:'),
    )
    check(
      '迁移后凭据可读回',
      migrated.store.getSecret('llm.providers.deepseek.apiKey') === 'sk-legacy-plain',
    )

    // ⑦ 导出脱敏
    const redacted = migrated.store.exportRedacted()
    check('导出配置已脱敏', redacted.llm.providers.deepseek.apiKeyEnc === '***')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }

  const failed = checks.filter((item) => !item.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
  if (failed.length > 0) {
    console.error('失败项：')
    for (const item of failed) console.error(` - ${item.name} ${item.detail}`)
    process.exitCode = 1
  }
}

await main()
