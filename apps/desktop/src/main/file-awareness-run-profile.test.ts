import { describe, expect, it } from 'vitest'
import { fileAwarenessRunProfile, isFileAwarenessSession } from './file-awareness-run-profile.js'

describe('file-awareness-run-profile', () => {
  it('按 origin 或会话前缀命中，并给出空工具面', () => {
    const profile = fileAwarenessRunProfile({
      sessionId: 'awareness-abc',
      origin: 'file-awareness',
    })
    expect(profile?.allowedTools).toEqual([])
    expect(profile?.persona).toContain('文件自感知')
    expect(isFileAwarenessSession('awareness-abc')).toBe(true)
  })

  it('普通会话不受影响', () => {
    expect(fileAwarenessRunProfile({ sessionId: 'main', origin: 'chat' })).toBeUndefined()
    expect(isFileAwarenessSession('main')).toBe(false)
  })
})
