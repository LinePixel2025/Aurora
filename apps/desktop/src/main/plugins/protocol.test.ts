import { describe, expect, it } from 'vitest'
import {
  PLUGIN_RPC_MAX_FRAME_BYTES,
  PLUGIN_RPC_VERSION,
  type PluginRpcMessage,
} from '@aurora/shared'
import { PluginRpcFailure, PluginRpcPeer, type PluginRpcTransport } from './protocol.js'

/** 记录出站消息的传输层（可注入 send 抛错，模拟进程已退出）。 */
function recorder(options: { failSend?: boolean } = {}): {
  transport: PluginRpcTransport
  sent: PluginRpcMessage[]
} {
  const sent: PluginRpcMessage[] = []
  return {
    sent,
    transport: {
      send: (message) => {
        if (options.failSend === true) throw new Error('进程已退出')
        sent.push(message)
      },
    },
  }
}

type RequestMessage = Extract<PluginRpcMessage, { kind: 'req' }>
type ResponseMessage = Extract<PluginRpcMessage, { kind: 'res' }>

function expectFailure(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(PluginRpcFailure)
  expect((error as PluginRpcFailure).code).toBe(code)
}

/** 等一轮微任务 / 宏任务（宿主请求处理器是异步派发的） */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('PluginRpcPeer · 出站请求', () => {
  it('请求带关联 id，收到同 id 的 res 后 resolve 并清空在途计数', async () => {
    const { transport, sent } = recorder()
    const peer = new PluginRpcPeer(transport)

    const promise = peer.request('tool.invoke', { name: 'echo' }, { timeoutMs: 1000 })
    expect(peer.inflight).toBe(1)
    const request = sent[0] as RequestMessage
    expect(request).toMatchObject({
      v: PLUGIN_RPC_VERSION,
      kind: 'req',
      method: 'tool.invoke',
      params: { name: 'echo' },
    })

    peer.handleMessage({
      v: PLUGIN_RPC_VERSION,
      kind: 'res',
      id: request.id,
      ok: true,
      result: { content: 'hi' },
    })
    await expect(promise).resolves.toEqual({ content: 'hi' })
    expect(peer.inflight).toBe(0)
  })

  it('res.ok=false 映射为 PluginRpcFailure（带 code / detail）', async () => {
    const { transport, sent } = recorder()
    const peer = new PluginRpcPeer(transport)
    const promise = peer.request('tool.invoke', {}, { timeoutMs: 1000 })
    const request = sent[0] as RequestMessage

    peer.handleMessage({
      v: PLUGIN_RPC_VERSION,
      kind: 'res',
      id: request.id,
      ok: false,
      error: { code: 'E_PLUGIN_TOOL_FAILED', message: '炸了', detail: 'stack' },
    })
    const error = await promise.catch((cause: unknown) => cause)
    expectFailure(error, 'E_PLUGIN_TOOL_FAILED')
    expect((error as PluginRpcFailure).detail).toBe('stack')
  })

  it('超时：拒绝为 E_PLUGIN_TIMEOUT 并清掉在途计数', async () => {
    const { transport } = recorder()
    const peer = new PluginRpcPeer(transport)
    const promise = peer.request('plugin.ping', {}, { timeoutMs: 10 })
    const error = await promise.catch((cause: unknown) => cause)
    expectFailure(error, 'E_PLUGIN_TIMEOUT')
    expect(peer.inflight).toBe(0)
  })

  it('signal 取消：先发 cancel 再以 E_PLUGIN_CANCELLED 拒绝；已取消的 signal 不发请求', async () => {
    const { transport, sent } = recorder()
    const peer = new PluginRpcPeer(transport)
    const controller = new AbortController()
    const promise = peer.request('tool.invoke', {}, { timeoutMs: 5000, signal: controller.signal })
    const request = sent[0] as RequestMessage

    controller.abort()
    const error = await promise.catch((cause: unknown) => cause)
    expectFailure(error, 'E_PLUGIN_CANCELLED')
    expect(sent[1]).toEqual({ v: PLUGIN_RPC_VERSION, kind: 'cancel', id: request.id })
    expect(peer.inflight).toBe(0)

    const aborted = new AbortController()
    aborted.abort()
    const before = sent.length
    const second = peer.request('tool.invoke', {}, { timeoutMs: 1000, signal: aborted.signal })
    expectFailure(await second.catch((cause: unknown) => cause), 'E_PLUGIN_CANCELLED')
    expect(sent).toHaveLength(before)
  })

  it('超过 1 MiB 的请求直接拒绝，不触达传输层', async () => {
    const { transport, sent } = recorder()
    const peer = new PluginRpcPeer(transport)
    const huge = 'x'.repeat(PLUGIN_RPC_MAX_FRAME_BYTES + 1)
    const error = await peer
      .request('tool.invoke', { data: huge }, { timeoutMs: 1000 })
      .catch((cause: unknown) => cause)
    expectFailure(error, 'E_PLUGIN_FRAME_TOO_LARGE')
    expect(sent).toEqual([])
  })

  it('在途上限：超过 maxInflight 的新请求被拒绝', async () => {
    const { transport } = recorder()
    const peer = new PluginRpcPeer(transport, { maxInflight: 2 })
    const first = peer.request('a', {}, { timeoutMs: 5000 })
    const second = peer.request('b', {}, { timeoutMs: 5000 })
    await expect(peer.request('c', {}, { timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'E_PLUGIN_TOO_MANY_INFLIGHT',
    })
    peer.dispose()
    await expect(first).rejects.toBeInstanceOf(PluginRpcFailure)
    await expect(second).rejects.toBeInstanceOf(PluginRpcFailure)
  })

  it('dispose 拒绝全部在途请求（E_PLUGIN_CRASHED），之后的请求立即拒绝', async () => {
    const { transport } = recorder()
    const peer = new PluginRpcPeer(transport)
    const pending = peer.request('tool.invoke', {}, { timeoutMs: 5000 })
    peer.dispose('进程退出（code 1）')

    const error = await pending.catch((cause: unknown) => cause)
    expectFailure(error, 'E_PLUGIN_CRASHED')
    expect((error as PluginRpcFailure).message).toBe('进程退出（code 1）')
    await expect(peer.request('tool.invoke', {}, { timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'E_PLUGIN_CRASHED',
    })
  })

  it('传输层发送抛错：请求立即以 E_PLUGIN_CRASHED 失败（不悬挂）', async () => {
    const { transport } = recorder({ failSend: true })
    const peer = new PluginRpcPeer(transport)
    const error = await peer
      .request('tool.invoke', {}, { timeoutMs: 1000 })
      .catch((cause: unknown) => cause)
    expectFailure(error, 'E_PLUGIN_CRASHED')
    expect(peer.inflight).toBe(0)
  })
})

describe('PluginRpcPeer · 入站消息', () => {
  it('req：处理器结果回 res.ok，异常按 PluginRpcFailure / 普通 Error 映射', async () => {
    const { transport, sent } = recorder()
    const peer = new PluginRpcPeer(transport, {
      onRequest: async (method, params) => {
        if (method === 'ok') return { echo: params }
        if (method === 'denied') {
          throw new PluginRpcFailure('E_PLUGIN_PERMISSION', '没有权限', 'net')
        }
        throw new Error('普通错误')
      },
    })

    peer.handleMessage({
      v: PLUGIN_RPC_VERSION,
      kind: 'req',
      id: 'p1',
      method: 'ok',
      params: { a: 1 },
    })
    await flush()
    expect(sent[0]).toMatchObject({ kind: 'res', id: 'p1', ok: true, result: { echo: { a: 1 } } })

    peer.handleMessage({
      v: PLUGIN_RPC_VERSION,
      kind: 'req',
      id: 'p2',
      method: 'denied',
      params: {},
    })
    peer.handleMessage({ v: PLUGIN_RPC_VERSION, kind: 'req', id: 'p3', method: 'boom', params: {} })
    await flush()
    const denied = sent[1] as ResponseMessage
    expect(denied.ok).toBe(false)
    if (!denied.ok)
      expect(denied.error).toEqual({
        code: 'E_PLUGIN_PERMISSION',
        message: '没有权限',
        detail: 'net',
      })
    const boom = sent[2] as ResponseMessage
    expect(boom.ok).toBe(false)
    if (!boom.ok) expect(boom.error.code).toBe('E_PLUGIN_TOOL_FAILED')
  })

  it('未注册处理器 / 空 method：回 E_PLUGIN_INVALID_ARGS', async () => {
    const { transport, sent } = recorder()
    const peer = new PluginRpcPeer(transport)
    peer.handleMessage({
      v: PLUGIN_RPC_VERSION,
      kind: 'req',
      id: 'x',
      method: 'storage.get',
      params: {},
    })
    await flush()
    expect(sent[0]).toMatchObject({
      kind: 'res',
      id: 'x',
      ok: false,
      error: { code: 'E_PLUGIN_INVALID_ARGS' },
    })
  })

  it('evt / cancel 分发给对应回调；版本不符的消息直接忽略', async () => {
    const { transport, sent } = recorder()
    const events: Array<{ event: string; payload: unknown }> = []
    const cancelled: string[] = []
    const peer = new PluginRpcPeer(transport, {
      onEvent: (event, payload) => events.push({ event, payload }),
      onCancel: (id) => cancelled.push(id),
    })

    peer.handleMessage({
      v: PLUGIN_RPC_VERSION,
      kind: 'evt',
      event: 'plugin.fatal',
      payload: 'boom',
    })
    peer.handleMessage({ v: PLUGIN_RPC_VERSION, kind: 'cancel', id: 'r1' })
    peer.handleMessage({ v: 999, kind: 'evt', event: 'ignored', payload: null })
    peer.handleMessage(null)
    peer.handleMessage('not-a-message')

    expect(events).toEqual([{ event: 'plugin.fatal', payload: 'boom' }])
    expect(cancelled).toEqual(['r1'])
    expect(sent).toEqual([])
  })

  it('结果超过 1 MiB：回 E_PLUGIN_FRAME_TOO_LARGE 而不是发送超大帧', async () => {
    const { transport, sent } = recorder()
    const peer = new PluginRpcPeer(transport, {
      onRequest: () => ({ data: 'x'.repeat(PLUGIN_RPC_MAX_FRAME_BYTES + 1) }),
    })
    peer.handleMessage({ v: PLUGIN_RPC_VERSION, kind: 'req', id: 'big', method: 'x', params: {} })
    await flush()
    expect(sent[0]).toMatchObject({
      kind: 'res',
      id: 'big',
      ok: false,
      error: { code: 'E_PLUGIN_FRAME_TOO_LARGE' },
    })
  })
})
