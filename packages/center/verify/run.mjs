/* global process */
/**
 * Aurora Center Web 的**视觉 + 行为验收 harness**（`pnpm --filter @aurora/center verify:web`）。
 *
 * 桌面端有一套 Electron 版核对工具（`apps/desktop/src/main/capture.ts`），Center 的网页 SPA
 * 没有任何"看得见它"的手段 —— 它是纯浏览器产物，只能在真浏览器里跑。本文件就是那一套：
 * 起**真实的服务器子进程** + 一台**桩客户端**（`stub-client.mjs`）+ `puppeteer-core` 驱动的
 * Edge/Chrome，把每条场景推到位后截图 + 读 DOM，最后写 `report.json` 并以退出码报成败
 * （与 capture.ts 同一口径：任何一条 `ok: false` → 退出码 2）。
 *
 * 为什么每样都"真的"：SPA 的行为由**三件事**共同决定 —— 服务器路由、客户端上报的数据、
 * 浏览器的渲染。任何一处用假的，验的就不是真实链路了；只有浏览器是真的、其余造假，
 * 得到的结论（"点击没反应"之类）无法区分是 SPA 坏了还是桩机没喂对。
 *
 * 开关（镜像桌面端的 `AURORA_CAPTURE*` 一族）：
 *   AURORA_CWEB_OUT=<dir>            报告与截图输出目录（默认 %TEMP%/aurora-cweb）
 *   AURORA_CWEB_ONLY=<子串>[,<子串>]  只跑匹配的场景名；特殊值 `failed` = 只重跑上次失败的
 *   AURORA_CWEB_THEME=dark|light     只跑一个主题（默认两个都跑，报告里场景名带 @light）
 *   AURORA_CWEB_VIEWPORT=mobile      只跑移动视口的场景（desktop = 只跑桌面）
 *   AURORA_CWEB_KEEP=1               跑完保留子服务器与临时数据目录（排障用）
 *   AURORA_CWEB_BROWSER=<exe>        指定浏览器可执行文件
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  SCENARIOS,
  domDigest,
  scenarioMatches,
} from './scenarios.mjs'
import { StubClient } from './stub-client.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CENTER_ROOT = dirname(HERE)
const SERVER_BIN = join(CENTER_ROOT, 'bin', 'aurora-center.js')
const DIST_INDEX = join(CENTER_ROOT, 'dist-web', 'index.html')

/** 管理员账号（CLI `init` 建，密码已知；`start` 自动引导时密码是随机打印一次、拿不到） */
const ADMIN_USER = 'admin'
const ADMIN_PASSWORD = 'aurora-verify-1'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ───────────────────────── 环境开关 ─────────────────────────

const outDir = process.env.AURORA_CWEB_OUT ?? join(tmpdir(), 'aurora-cweb')
const onlySelectors = (process.env.AURORA_CWEB_ONLY ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter((item) => item !== '')
const themeSwitch = (process.env.AURORA_CWEB_THEME ?? '').trim()
const viewportSwitch = (process.env.AURORA_CWEB_VIEWPORT ?? '').trim()
const keep = process.env.AURORA_CWEB_KEEP === '1'

/**
 * 浏览器探测顺序：显式环境变量 → Edge（x86 版是我们这台机器上实际存在的那个）→
 * 另一条 Edge 路径 → Chrome。找不到就 SKIP（退出码 0）—— 这条 harness 不该让
 * 没装浏览器的机器（比如 CI 里的纯 Linux 容器）变成红的。
 */
function findBrowser() {
  const candidates = [
    process.env.AURORA_CWEB_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((item) => typeof item === 'string' && item !== '')
  return candidates.find((item) => existsSync(item)) ?? ''
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

// ───────────────────────── 服务器子进程 ─────────────────────────

/**
 * 起一个真实的 Center 服务器。
 *
 * 账号走 CLI `init --admin-password`：`/api/auth/register` 只建 `role: 'user'` 的账号
 * （server.ts 的 register 路由 + auth.registerUser 固定 role），而管理端场景需要**管理员**；
 * `start` 的自动引导会把随机密码只打印一次、抓不到。init 与 start 是同一个数据目录，
 * start 时 `ensureAdmin` 发现已有管理员就不再建。
 * 顺手再用 `/api/auth/register` 建一个普通账号：既验证自助注册这条路，也让管理端的
 * 用户表有第二行可看。
 */
async function startServer({ dataDir, port }) {
  const logs = { out: '', err: '' }
  const runOnce = (args, label) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SERVER_BIN, ...args], {
        cwd: CENTER_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', (chunk) => {
        logs.out += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        logs.err += String(chunk)
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${label} 退出码 ${code}\n${logs.out}\n${logs.err}`))
      })
    })

  await runOnce(
    ['init', '--data', dataDir, '--admin-user', ADMIN_USER, '--admin-password', ADMIN_PASSWORD],
    'aurora-center init',
  )

  logs.out = ''
  logs.err = ''
  const server = spawn(
    process.execPath,
    [SERVER_BIN, 'start', '--port', String(port), '--data', dataDir],
    {
      cwd: CENTER_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let exited = null
  server.stdout.on('data', (chunk) => {
    logs.out += String(chunk)
  })
  server.stderr.on('data', (chunk) => {
    logs.err += String(chunk)
  })
  server.once('exit', (code, signal) => {
    exited = { code, signal }
  })

  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15_000
  for (;;) {
    if (exited !== null) {
      throw new Error(
        `Center 服务器提前退出（code=${exited.code} signal=${exited.signal}）\n${logs.out}\n${logs.err}`,
      )
    }
    try {
      const response = await fetch(`${baseUrl}/`)
      if (response.ok) break
    } catch {
      // 还没起来：继续等
    }
    if (Date.now() > deadline) {
      throw new Error(`Center 服务器 15s 内未就绪\n${logs.out}\n${logs.err}`)
    }
    await sleep(200)
  }
  return { server, baseUrl, logs }
}

/** 结束服务器：先请它自己收尾（CLI 挂了 SIGTERM），超时再硬杀 */
async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return
  const done = new Promise((resolve) => server.once('exit', resolve))
  server.kill('SIGTERM')
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000))
  await Promise.race([done, timeout])
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL')
}

// ───────────────────────── 报告 ─────────────────────────

/**
 * 打印 + 落盘一条结果。行格式与桌面端 capture.ts 一致，方便 grep：
 *   `PASS — <场景名> — <判定 JSON>`（失败时打 FAIL 与实际读数）。
 */
function reportLine(check) {
  const flag = check.ok && check.result?.pass !== false ? 'PASS' : 'FAIL'
  const payload = JSON.stringify(check.result ?? null)
  return `${flag} — ${check.name} — ${payload.length > 600 ? `${payload.slice(0, 600)}…` : payload}`
}

async function readPreviousReport(dir) {
  try {
    const raw = await readFile(join(dir, 'report.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.checks) ? parsed.checks : []
  } catch {
    return []
  }
}

// ───────────────────────── 浏览器侧 ─────────────────────────

/** 走真实的登录表单（`data-field` 三件套 + 提交按钮），成功后等服务端把控制台渲染出来 */
async function loginThroughForm(page, username, password) {
  await page.waitForSelector('[data-panel="login"]', { timeout: 10_000 })
  await page.type('[data-field="login.username"]', username)
  await page.type('[data-field="login.password"]', password)
  await page.click('[data-action="login.submit"]')
  await page.waitForSelector('[data-panel="console"]', { timeout: 15_000 })
}

async function logout(page) {
  await page.evaluate(() => window.localStorage.clear()).catch(() => undefined)
}

/**
 * 回到"未登录、停在登录页"的干净状态。
 *
 * ⚠️ 必须先有过一次真实导航：新开的标签页停在 `about:blank`，那里**读 localStorage 会抛
 * SecurityError**（踩过一次，整轮以"Access is denied"中断，一条场景都没跑）。
 * 之后用 `reload` 而不是 `goto` —— 同一 URL（含 hash）的 goto 会被当成同文档导航，不重新加载。
 */
async function resetAuth(page, baseUrl) {
  if (page.url().startsWith('about:')) {
    await page.goto(`${baseUrl}/#/login`, { waitUntil: 'domcontentloaded' })
  }
  await page.evaluate(() => {
    window.localStorage.clear()
    window.location.hash = '#/login'
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
  if (!existsSync(DIST_INDEX)) {
    console.error('请先跑 pnpm --filter @aurora/center build')
    process.exit(1)
  }
  const browserPath = findBrowser()
  if (browserPath === '') {
    console.log('SKIP: 未找到可用的浏览器（Edge/Chrome）')
    process.exit(0)
  }

  await mkdir(outDir, { recursive: true })
  const previous = onlySelectors.includes('failed') ? await readPreviousReport(outDir) : []
  const failedNames = previous
    .filter((check) => check.ok === false || check.result?.pass === false)
    .map((check) => check.name)
  const effectiveOnly = onlySelectors.includes('failed') ? failedNames : onlySelectors
  if (onlySelectors.includes('failed') && failedNames.length === 0) {
    console.log('上次报告没有失败项，按 --only failed 语义不跑任何场景')
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'aurora-cweb-'))
  const port = await freePort()
  const startedAt = new Date().toISOString()
  const checks = []
  const files = []
  let server = null
  let browser = null
  let stub = null
  let fatal = null

  try {
    const started = await startServer({ dataDir, port })
    server = started.server
    const baseUrl = started.baseUrl
    console.log(`Center 服务器：${baseUrl}（数据目录 ${dataDir}）`)

    // 自助注册一个普通账号（注册路由默认开启；失败不致命 —— 管理端场景只要求 ≥1 行用户）
    const registered = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'verify-user', password: 'verify-user-1' }),
    }).catch(() => null)
    console.log(
      `注册普通账号 verify-user：${registered === null ? '请求失败' : `HTTP ${registered.status}`}`,
    )

    stub = new StubClient({
      baseUrl,
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
      clientId: 'cweb-stub-1',
    })
    await stub.start()
    await stub.waitWelcome()

    const puppeteer = (await import('puppeteer-core')).default
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--no-sandbox'],
    })
    // 复制按钮走 navigator.clipboard：localhost 是安全上下文，但权限仍需显式授予
    await browser
      .defaultBrowserContext()
      .overridePermissions(baseUrl, ['clipboard-read', 'clipboard-write'])
      .catch(() => undefined)
    const page = await browser.newPage()
    await page.setViewport(DESKTOP_VIEWPORT)

    const themes = themeSwitch === '' ? ['dark', 'light'] : [themeSwitch]
    for (const theme of themes) {
      // CDP 设置 prefers-color-scheme：theme.css 只有 `:root` + light 媒体查询，
      // 不设这一项浏览器默认按 light 走（headless 的缺省是 light）
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }])
      const themeSuffix = themes.length > 1 ? `@${theme}` : ''
      // 主题场景自带 `theme-dark` / `theme-light` 这种名字，不再叠后缀（探针名要稳定）
      const displayName = (scenario) =>
        scenario.theme === undefined ? `${scenario.name}${themeSuffix}` : scenario.name
      const selected = SCENARIOS.filter((scenario) => {
        if (scenario.viewport === 'mobile' && viewportSwitch === 'desktop') return false
        if (viewportSwitch === 'mobile' && scenario.viewport !== 'mobile') return false
        if (scenario.theme !== undefined && scenario.theme !== theme) return false
        // 匹配用的是**报告里的名字**（带 `@主题` 后缀）：上一份报告的失败项就长这样，
        // 拿裸场景名去 includes 一个带后缀的选择器会一条都匹配不上（`failed` 会变成空跑）
        return scenarioMatches(displayName(scenario), effectiveOnly)
      })
      if (selected.length === 0) continue

      // 未登录场景先跑（`login-page` 是唯一必须在未登录态的），随后统一登录
      const loggedOutBatch = selected.filter((scenario) => scenario.loggedOut === true)
      const normalBatch = selected.filter((scenario) => scenario.loggedOut !== true)
      if (loggedOutBatch.length > 0 || normalBatch.length > 0) {
        await resetAuth(page, baseUrl)
      }
      for (const scenario of loggedOutBatch) {
        const name = displayName(scenario)
        const file = join(outDir, `${name}.png`)
        let check
        try {
          await page.setViewport(
            scenario.viewport === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT,
          )
          const ctx = { page, stub, baseUrl, port, theme, outDir }
          const result = await scenario.run(ctx)
          check = { name, file, result, checked: true, ok: true }
        } catch (error) {
          check = {
            name,
            file,
            result: { pass: false, error: String(error) },
            checked: true,
            ok: false,
          }
        }
        if (check.result?.pass === false || check.ok === false) check.dom = await domDigest(page)
        try {
          await page.screenshot({ path: file, fullPage: false })
          files.push(file)
        } catch (error) {
          check.ok = false
          check.result = { ...(check.result ?? {}), screenshotError: String(error) }
        }
        checks.push(check)
        console.log(reportLine(check))
      }
      if (normalBatch.length > 0) {
        await loginThroughForm(page, ADMIN_USER, ADMIN_PASSWORD)
        await page.waitForFunction(
          () => document.querySelector('[data-field="rail.client-row"]') !== null,
          { timeout: 15_000 },
        )
        for (const scenario of normalBatch) {
          const name = displayName(scenario)
          const file = join(outDir, `${name}.png`)
          let check
          try {
            await page.setViewport(
              scenario.viewport === 'mobile' ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT,
            )
            const ctx = { page, stub, baseUrl, port, theme, outDir }
            const result = await scenario.run(ctx)
            check = { name, file, result, checked: true, ok: true }
          } catch (error) {
            check = {
              name,
              file,
              result: { pass: false, error: String(error) },
              checked: true,
              ok: false,
            }
          }
          if (check.result?.pass === false || check.ok === false) {
            check.dom = await domDigest(page)
          }
          try {
            await page.screenshot({ path: file, fullPage: false })
            files.push(file)
          } catch (error) {
            check.ok = false
            check.result = { ...(check.result ?? {}), screenshotError: String(error) }
          }
          checks.push(check)
          console.log(reportLine(check))
        }
      }
    }

    // 每条场景自带前置与收尾，但整轮结束时把界面留在控制台上（截图/肉眼核对方便）
    await logout(page)
    await page.goto(`${baseUrl}/#/login`, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
  } catch (error) {
    fatal = String(error)
  } finally {
    try {
      await browser?.close()
    } catch {
      // 关不掉就算了，进程退出时会被回收
    }
    stub?.close()
    if (server !== null) {
      if (keep) {
        console.log(`AURORA_CWEB_KEEP=1：保留服务器（port=${port}）与数据目录 ${dataDir}`)
      } else {
        await stopServer(server)
        await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
      }
    } else if (!keep) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  const failed = checks.filter((check) => check.ok === false || check.result?.pass === false)
  const report = {
    dir: outDir,
    browser: browserPath,
    startedAt,
    finishedAt: new Date().toISOString(),
    port,
    themes: themeSwitch === '' ? ['dark', 'light'] : [themeSwitch],
    checks,
    files,
    ...(fatal === null ? {} : { fatal }),
  }
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`\n报告：${join(outDir, 'report.json')}`)
  console.log(`场景：${checks.length}，失败：${failed.length}`)
  if (fatal !== null) console.error(`整轮中断：${fatal}`)
  process.exit(fatal !== null || failed.length > 0 ? 2 : 0)
}

main().catch((error) => {
  console.error(`harness 自身异常：${error?.stack ?? String(error)}`)
  process.exit(2)
})
