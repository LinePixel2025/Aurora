import { describe, expect, it } from 'vitest'
import { MODE_IDS } from '@aurora/shared'
import { MODE_CAPABILITY_MATRIX, SHARED_TOOLSET, modeCapabilityOf } from './capabilities.js'
import { createWorkMode } from './work.js'
import { createCodeMode } from './code.js'
import { createClassroomMode } from './classroom.js'

describe('模式能力矩阵（docs/05 §6 能力对齐）', () => {
  it('覆盖全部注册模式，不多不少', () => {
    expect(MODE_CAPABILITY_MATRIX.map((capability) => capability.id).sort()).toEqual(
      [...MODE_IDS].sort(),
    )
  })

  it('原则①：全模式工具集恒等（SHARED_TOOLSET）——防未来按模式裁剪工具', () => {
    for (const capability of MODE_CAPABILITY_MATRIX) {
      expect(capability.tools).toBe(SHARED_TOOLSET)
    }
  })

  it('原则②：差异只允许出现在感知订阅与特化功能两处', () => {
    for (const capability of MODE_CAPABILITY_MATRIX) {
      // 差异字段之外不允许出现任何能力裁剪字段（结构化护栏：新字段必须显式进本测试）
      expect(Object.keys(capability).sort()).toEqual(
        [
          'displayName',
          'id',
          'perceptionSubscriptions',
          'placeholder',
          'specialized',
          'tools',
        ].sort(),
      )
    }
    // 感知差异真实存在（否则"差异只在感知与特化"就是空话）
    const perceptions = MODE_CAPABILITY_MATRIX.map(
      (capability) => capability.perceptionSubscriptions.length,
    )
    expect(new Set(perceptions).size).toBeGreaterThan(1)
  })

  it('矩阵与实际模式实现的 placeholder 标记一致', () => {
    const modes = [createClassroomMode(), createWorkMode(), createCodeMode()]
    for (const mode of modes) {
      expect(modeCapabilityOf(mode.id)?.placeholder).toBe(mode.placeholder)
    }
  })
})
