/**
 * MCP 配置签名（P1-05）的单测。
 *
 * 判据：签名必须**含值**。旧实现只取 `Object.keys(envEnc/headersEnc).sort()`，
 * 于是「只轮换某个 env / header 的值」（键名集合不变、密文变了）不产生新签名 →
 * `apply()` 提前 return → hub 里的 definition 仍是旧解密值：stdio 重连用旧 env、
 * HTTP 每次请求带旧 Authorization 头，状态灯却一直 `ready`（轮换泄漏的 token 静默失效）。
 *
 * 断言只关心「签名变 / 不变」——签名里序列化的是 safeStorage **密文**，
 * 既不复述内容、也不进日志（只与 `appliedSignature` 比较）。
 */
import { describe, expect, it } from 'vitest'
import { signatureOf } from './mcp.js'
import type { McpServerConfig } from '@aurora/shared'

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: 'demo',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'demo-mcp'],
    envEnc: {},
    headersEnc: {},
    enabled: true,
    ...overrides,
  }
}

/** 与 `McpController.apply` 调用口径一致（只吃 `mcp` 这一组） */
function signature(servers: readonly McpServerConfig[], lazyConnect = false): string {
  return signatureOf({ mcp: { lazyConnect, servers: [...servers] } })
}

describe('signatureOf：MCP 配置签名', () => {
  it('键与值都没变 → 签名不变（不同对象实例也算同一份配置）', () => {
    const base = server({
      envEnc: { TOKEN: 'enc-1', MODE: 'enc-2' },
      headersEnc: { Authorization: 'enc-3' },
    })
    const same = server({
      envEnc: { TOKEN: 'enc-1', MODE: 'enc-2' },
      headersEnc: { Authorization: 'enc-3' },
    })
    expect(signature([base])).toBe(signature([same]))
  })

  it('仅轮换 env 的值（键名集合不变）→ 签名变化，apply 不再提前返回（P1-05）', () => {
    const before = server({ envEnc: { TOKEN: 'enc-old', MODE: 'enc-2' } })
    const rotated = server({ envEnc: { TOKEN: 'enc-new', MODE: 'enc-2' } })
    // 前提核实：键名集合确实没变（这正是旧实现漏判的那条路径）
    expect(Object.keys(rotated.envEnc).sort()).toEqual(Object.keys(before.envEnc).sort())
    expect(signature([rotated])).not.toBe(signature([before]))
  })

  it('仅轮换 header 的值 → 签名变化（HTTP 传输的 Authorization 同款）', () => {
    const before = server({
      transport: 'http',
      url: 'https://mcp.example.com/rpc',
      headersEnc: { Authorization: 'enc-old' },
    })
    const rotated = server({
      transport: 'http',
      url: 'https://mcp.example.com/rpc',
      headersEnc: { Authorization: 'enc-new' },
    })
    expect(signature([rotated])).not.toBe(signature([before]))
  })

  it('键名变化（增 / 删）→ 签名变化（既有语义不回退）', () => {
    const before = server({ envEnc: { TOKEN: 'enc-1' } })
    const added = server({ envEnc: { TOKEN: 'enc-1', EXTRA: 'enc-2' } })
    const removed = server({ envEnc: {} })
    expect(signature([added])).not.toBe(signature([before]))
    expect(signature([removed])).not.toBe(signature([before]))
    // headers 同款
    const headerBefore = server({ headersEnc: { X: 'enc-1' } })
    const headerAfter = server({ headersEnc: { X: 'enc-1', Y: 'enc-2' } })
    expect(signature([headerAfter])).not.toBe(signature([headerBefore]))
  })

  it('键序变化但键值均相同 → 签名不变（稳定序列化，不因键序抖动误判重连）', () => {
    const first = server({ envEnc: { A: 'enc-a', B: 'enc-b', C: 'enc-c' } })
    const reordered = server({ envEnc: { C: 'enc-c', A: 'enc-a', B: 'enc-b' } })
    expect(signature([reordered])).toBe(signature([first]))
  })

  it('连接相关字段（transport / url / enabled / lazyConnect）变化 → 签名变化', () => {
    const base = server()
    expect(signature([server({ enabled: false })])).not.toBe(signature([base]))
    expect(signature([server({ transport: 'http', url: 'https://x/y' })])).not.toBe(
      signature([base]),
    )
    expect(signature([base], true)).not.toBe(signature([base], false))
  })

  it('多条服务器与顺序：增删 / 改序都进签名', () => {
    const a = server({ name: 'a' })
    const b = server({ name: 'b' })
    expect(signature([a, b])).toBe(signature([a, b]))
    expect(signature([a])).not.toBe(signature([a, b]))
    expect(signature([b, a])).not.toBe(signature([a, b]))
  })
})
