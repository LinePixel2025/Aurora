/**
 * 插件子进程（`utilityProcess`）的宿主侧封装（docs/14 §2.2）。
 *
 * 一个启用的插件一个进程：崩溃 / 死循环 / OOM 不牵连主进程与其他插件。
 * 本文件是**唯一** import electron 的插件模块；`manager.ts` 只依赖
 * `PluginProcessFactory` 接口，所以状态机与 RPC 可以脱离 Electron 单测。
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import type { PluginManifest } from '@aurora/shared'
import { PluginRpcPeer, type PluginRpcTransport } from './protocol.js'

export interface PluginSpawnRequest {
  pluginId: string
  root: string
  dataDir: string
  isDev: boolean
  manifest: PluginManifest
  config: Record<string, unknown>
  hostVersion: string
}

export interface PluginProcessCallbacks {
  onExit(code: number | null): void
  onOutput(stream: 'stdout' | 'stderr', line: string): void
}

export interface PluginProcessHandle {
  readonly peer: PluginRpcPeer
  start(): void
  kill(): void
}

export interface PluginProcessFactory {
  create(request: PluginSpawnRequest, callbacks: PluginProcessCallbacks): PluginProcessHandle
}

class UtilityPluginProcess implements PluginProcessHandle {
  readonly peer: PluginRpcPeer
  private readonly request: PluginSpawnRequest
  private readonly callbacks: PluginProcessCallbacks
  private readonly hostPath: string
  private child: UtilityProcess | undefined
  private exited = false

  constructor(hostPath: string, request: PluginSpawnRequest, callbacks: PluginProcessCallbacks) {
    this.hostPath = hostPath
    this.request = request
    this.callbacks = callbacks
    // peer 在 start() 之前就可用：manager 可能在 spawn 后立刻 request（init），
    // transport 用箭头闭包取 child，child 未就绪时抛错由 request 统一转成 E_PLUGIN_CRASHED。
    const transport: PluginRpcTransport = {
      send: (message) => {
        if (this.child === undefined || this.exited) {
          throw new Error('插件进程尚未启动')
        }
        this.child.postMessage(message)
      },
    }
    this.peer = new PluginRpcPeer(transport)
  }

  start(): void {
    if (this.child !== undefined) return
    const child = utilityProcess.fork(this.hostPath, [this.request.root], {
      serviceName: `aurora-plugin-${this.request.pluginId}`,
      env: process.env,
    })
    this.child = child
    child.on('message', (message: unknown) => {
      // Electron 的 message 事件直接给消息体；个别版本包一层 `{ data }`，两种都接。
      const payload =
        typeof message === 'object' && message !== null && 'data' in message
          ? (message as { data: unknown }).data
          : message
      this.peer.handleMessage(payload)
    })
    child.on('exit', (code: number) => {
      this.exited = true
      this.peer.dispose(`插件进程退出（code ${code}）`)
      this.callbacks.onExit(code)
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      this.callbacks.onOutput('stdout', chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.callbacks.onOutput('stderr', chunk.toString('utf8'))
    })
  }

  kill(): void {
    if (this.child === undefined) return
    this.exited = true
    try {
      this.child.kill()
    } catch {
      /* 已退出 */
    }
    this.child = undefined
  }

  get pid(): number | undefined {
    return this.child?.pid
  }
}

/** 生产环境的工厂：`hostPath` = `out/main/plugin-host.js`（与 index.js 同目录）。 */
export function createUtilityPluginProcessFactory(hostPath: string): PluginProcessFactory {
  return {
    create(request, callbacks) {
      return new UtilityPluginProcess(hostPath, request, callbacks)
    },
  }
}
