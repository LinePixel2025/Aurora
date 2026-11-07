import { describe, expect, it } from 'vitest'
import type { ChangedFileInfo } from '@aurora/shared'
import {
  cacheTurnChanges,
  matchUserMessageEcho,
  readTurnChanges,
  USER_MESSAGE_ECHO_WINDOW_MS,
  type ChatMessage,
} from './useChat.js'

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

describe('轮终改动缓存（chat:turnChanges）', () => {
  const file = (path: string): ChangedFileInfo => ({
    path,
    display: path,
    status: 'modified',
    added: 1,
    removed: 0,
  })

  it('按 (sessionId, requestId) 缓存：同一会话 / 请求读到同一份；别的会话读不到', () => {
    cacheTurnChanges({
      sessionId: 'cache-a',
      requestId: 'req-1',
      files: [file('D:\\proj\\a.txt')],
    })
    expect(readTurnChanges('cache-a').get('req-1')?.length).toBe(1)
    expect(readTurnChanges('cache-b').size).toBe(0)
  })

  it('同一 requestId 后写的覆盖前一份（不重复累积）', () => {
    cacheTurnChanges({ sessionId: 'cache-c', requestId: 'req-1', files: [file('a')] })
    cacheTurnChanges({ sessionId: 'cache-c', requestId: 'req-1', files: [file('b'), file('c')] })
    expect(
      readTurnChanges('cache-c')
        .get('req-1')
        ?.map((item) => item.path),
    ).toEqual(['b', 'c'])
  })

  it('空清单不入缓存（没有改动 = 不渲染卡片）', () => {
    cacheTurnChanges({ sessionId: 'cache-d', requestId: 'req-1', files: [] })
    expect(readTurnChanges('cache-d').size).toBe(0)
  })

  it('有界：超过 200 条时最旧的被淘汰', () => {
    for (let index = 0; index < 205; index += 1) {
      cacheTurnChanges({
        sessionId: `cache-evict-${index}`,
        requestId: 'req',
        files: [file('a')],
      })
    }
    expect(readTurnChanges('cache-evict-0').size).toBe(0)
    expect(readTurnChanges('cache-evict-204').size).toBe(1)
  })
})
