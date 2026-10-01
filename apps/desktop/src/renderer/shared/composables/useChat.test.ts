import { describe, expect, it } from 'vitest'
import { matchUserMessageEcho, USER_MESSAGE_ECHO_WINDOW_MS, type ChatMessage } from './useChat.js'

/**
 * `user-message` 广播去重判定的回归用例（P2-19）。
 *
 * 背景（bug/P2-一般.md P2-19）：quick 会话由提示条面板与主界面共用，任一侧发送都会向
 * 所有窗口广播 `user-message`。旧判定「内容 + 30 秒窗口」在**跨窗口 30 秒内重发同文本**
 * （"继续"、"好"等短命令复发）时会命中上一轮广播生成的 `u-evt-` 气泡（它已带 seq），
 * 把它的 seq / createdAt 覆写成这一轮的 —— 第二条消息被吞、第一条被错锚。
 *
 * 修法：**只与无 `seq` 的本地临时气泡对账**（`send()` 本地 push 的那条），带 seq 的跳过。
 */

/** 造一条 user 气泡：`seq === undefined` 就是 `send()` 本地 push 的临时态 */
function userMessage(content: string, createdAt: number, seq?: number): ChatMessage {
  return {
    id: seq === undefined ? `u-local-${createdAt}` : `u-evt-${seq}`,
    role: 'user',
    content,
    createdAt,
    ...(seq === undefined ? {} : { seq }),
  }
}

const T0 = 1_700_000_000_000

describe('matchUserMessageEcho（user-message 广播去重键）', () => {
  it('带 seq 的已确认气泡跳过 content 匹配：同文本重发命中不了上一轮（P2-19 主场景）', () => {
    // 上一轮广播生成的 `u-evt-` 气泡：已带 seq，30 秒内
    const confirmed = userMessage('继续', T0, 7)
    expect(matchUserMessageEcho([confirmed], '继续', T0 + 5_000)).toBe(-1)
  })

  it('同文本重发不吞：命中的是第二条临时气泡，已确认的第一条不被覆写', () => {
    const first = userMessage('继续', T0, 7)
    const second = userMessage('继续', T0 + 5_000)
    // 末尾往前扫取最近一条临时气泡（第二条），第一条（带 seq）被跳过
    expect(matchUserMessageEcho([first, second], '继续', T0 + 5_000)).toBe(1)
    // 若只有已确认的第一条（无临时气泡），则本次广播应**追加**新气泡而非覆写它
    expect(matchUserMessageEcho([first], '继续', T0 + 5_000)).toBe(-1)
  })

  it('无 seq 的临时气泡正常对账：发送方自己的本地气泡被广播确认', () => {
    const local = userMessage('你好', T0)
    expect(matchUserMessageEcho([local], '你好', T0 + 100)).toBe(0)
  })

  it('跨过带 seq 的气泡继续往前扫，能命中更早的临时气泡', () => {
    const local = userMessage('继续', T0)
    const confirmed = userMessage('继续', T0 + 1_000, 3)
    // 末尾是已确认的（跳过），继续往前扫命中本地临时气泡
    expect(matchUserMessageEcho([local, confirmed], '继续', T0 + 1_500)).toBe(0)
  })

  it('超出时间窗即停止回扫：更早的同文本气泡不算本次广播的原作者', () => {
    const old = userMessage('继续', T0)
    const later = T0 + USER_MESSAGE_ECHO_WINDOW_MS + 1
    expect(matchUserMessageEcho([old], '继续', later)).toBe(-1)
  })

  it('只对账 user 角色：助手同文本消息不参与匹配', () => {
    const assistant: ChatMessage = {
      id: 'a-1',
      role: 'assistant',
      content: '继续',
      createdAt: T0,
    }
    expect(matchUserMessageEcho([assistant], '继续', T0 + 100)).toBe(-1)
  })

  it('文本不同不匹配', () => {
    const local = userMessage('继续', T0)
    expect(matchUserMessageEcho([local], '好', T0 + 100)).toBe(-1)
  })
})
