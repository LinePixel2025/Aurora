/**
 * 插件页面专用 preload（docs/14 §2.4）。
 *
 * 只暴露 `window.auroraPlugin`：`request` 走 `sendToHost` 交给宿主渲染层中继，
 * `onEvent` 订阅宿主推送。**没有** `window.aurora`、没有 Node 能力、没有文件系统 ——
 * 页面拿到的能力完全由插件进程的白名单决定。
 *
 * 本文件与主 preload 一样必须**自包含**：只 `require('electron')`，不 import 工作区包。
 */
import { contextBridge, ipcRenderer } from 'electron'

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

let sequence = 0
const pending = new Map<string, PendingCall>()

ipcRenderer.on('aurora:response', (_event, payload: unknown) => {
  if (typeof payload !== 'object' || payload === null) return
  const message = payload as {
    id?: unknown
    ok?: unknown
    result?: unknown
    error?: { message?: unknown }
  }
  const id = typeof message.id === 'string' ? message.id : ''
  const call = pending.get(id)
  if (call === undefined) return
  pending.delete(id)
  if (message.ok === true) {
    call.resolve(message.result)
  } else {
    call.reject(
      new Error(
        typeof message.error?.message === 'string' ? message.error.message : '插件请求失败',
      ),
    )
  }
})

function request(method: string, params?: unknown): Promise<unknown> {
  if (typeof method !== 'string' || method === '' || method.length > 64) {
    return Promise.reject(new Error('method 必须是 1–64 字符的字符串'))
  }
  const id = `p${++sequence}`
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      ipcRenderer.sendToHost('aurora:request', { id, method, params })
    } catch (error) {
      pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function onEvent(listener: (event: string, payload: unknown) => void): () => void {
  if (typeof listener !== 'function') return () => undefined
  const handler = (_event: unknown, payload: unknown): void => {
    if (typeof payload !== 'object' || payload === null) return
    const message = payload as { event?: unknown; payload?: unknown }
    if (typeof message.event !== 'string') return
    listener(message.event, message.payload)
  }
  ipcRenderer.on('aurora:event', handler)
  return () => {
    ipcRenderer.removeListener('aurora:event', handler)
  }
}

contextBridge.exposeInMainWorld('auroraPlugin', { request, onEvent })
