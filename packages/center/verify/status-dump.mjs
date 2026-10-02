/* global process */
/**
 * Aurora Center 的**客户端上报诊断器**（docs/12 §6.1）。
 *
 * 用途：在**真实部署**的 Center 前面回答一句话的问题 ——「麦克风 / 朗读按钮不出现」
 * 到底是**客户端没上报 voice 位**，还是**服务器/网页还是旧包**？
 * 它跟验收 harness 一样走真实链路：REST 登录拿网页令牌 → `/api/ws?token=` 连上
 * → 把收到的 `clients` 全量快照与每条 `client.status` 的**关键字段原样打出来**
 * （clientId / online / mode / llm / voice / agent.tools / center.allow*）。
 * `voice` 缺失时明确写「voice 缺失（旧客户端或未上报）」—— 看到这一行就是客户端侧的事，
 * 看到 voice 有值而网页没按钮才是网页包的事。
 *
 * 用法（不需要装任何额外依赖，Node ≥22 自带 WebSocket；老 Node 走 ws 回落）：
 *   node verify/status-dump.mjs --server http://127.0.0.1:8787 --user admin --password ****** \
 *     [--seconds 8]
 */
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    user: { type: 'string' },
    password: { type: 'string' },
    seconds: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (
  values.help === true ||
  values.server === undefined ||
  values.user === undefined ||
  values.password === undefined
) {
  process.stdout.write(
    [
      '用法：node verify/status-dump.mjs --server <url> --user <name> --password <pw> [--seconds 8]',
      '',
      '  --server    Center 地址，如 http://127.0.0.1:8787（也接受 https / 带尾斜杠）',
      '  --user      网页账号（管理员能看到全部客户端，普通账号只看自己名下）',
      '  --password  密码',
      '  --seconds   观察窗口秒数（默认 8）',
      '',
    ].join('\n'),
  )
  process.exit(values.help === true ? 0 : 2)
}

const base = values.server.replace(/\/+$/, '')
const seconds = Number.parseInt(values.seconds ?? '8', 10)
const observeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 8000

const stamp = () => new Date().toISOString().slice(11, 23)

function printStatus(clientId, status, online) {
  const voice = status?.voice
  const lines = [
    `[${stamp()}] client.status  ${clientId}`,
    `    在线：${online === undefined ? '（未知，尚未收到 clients 快照）' : online ? '在线' : '离线'}`,
    `    mode=${status?.mode ?? '?'}  version=${status?.version ?? '?'}  platform=${status?.platform ?? '?'}`,
    `    llm: activeProviderId=${status?.llm?.activeProviderId ?? '?'} model=${status?.llm?.model ?? '?'} reasoningEffort=${status?.llm?.reasoningEffort ?? '?'}`,
  ]
  if (voice === undefined || voice === null) {
    lines.push('    voice 缺失（旧客户端或未上报）')
  } else {
    lines.push(`    voice: stt=${voice.stt === true} tts=${voice.tts === true}`)
  }
  const tools = status?.agent?.tools
  lines.push(
    `    agent.permissionMode=${status?.agent?.permissionMode || '?'} tools=${tools === undefined ? '?' : JSON.stringify(tools)}`,
  )
  lines.push(
    `    center.allow: session=${status?.center?.allowRemoteSession} remoteConfig=${status?.center?.allowRemoteConfig} fileTransfer=${status?.center?.allowFileTransfer}`,
  )
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function main() {
  process.stdout.write(`登录 ${base}（账号 ${values.user}）…\n`)
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: values.user, password: values.password }),
  })
  if (!login.ok) {
    process.stderr.write(`登录失败：HTTP ${login.status} ${await login.text()}\n`)
    process.exit(1)
  }
  const { token, user } = await login.json()
  process.stdout.write(`已登录：${user.username}（${user.role}）\n`)

  const WebSocketImpl = globalThis.WebSocket ?? (await import('ws')).WebSocket
  const wsUrl = `${base.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(token)}`
  const socket = new WebSocketImpl(wsUrl)
  const onlineByClient = new Map()

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.type === 'clients') {
      for (const client of message.clients ?? []) onlineByClient.set(client.clientId, client.online)
      process.stdout.write(
        `[${stamp()}] clients 快照：${
          (message.clients ?? [])
            .map(
              (client) => `${client.name}(${client.clientId}) ${client.online ? '在线' : '离线'}`,
            )
            .join('、') || '（空）'
        }\n`,
      )
      return
    }
    if (message.type === 'client.status') {
      printStatus(message.clientId, message.status, onlineByClient.get(message.clientId))
      return
    }
  })
  socket.addEventListener('error', (error) => {
    process.stderr.write(`WS 错误：${String(error?.message ?? error)}\n`)
  })
  socket.addEventListener('close', () => {
    process.stdout.write('WS 已关闭\n')
  })

  await new Promise((resolve) => setTimeout(resolve, observeMs))
  socket.close()
  process.stdout.write(
    `\n观察 ${observeMs / 1000}s 结束。判读：status 帧里 voice 缺失 = 客户端没上报（升级桌面端）；\nvoice 有值但网页没有麦克风 / 朗读按钮 = 网页包或服务器版本旧。\n`,
  )
  process.exit(0)
}

main().catch((error) => {
  process.stderr.write(`status-dump 异常：${error?.stack ?? String(error)}\n`)
  process.exit(1)
})
