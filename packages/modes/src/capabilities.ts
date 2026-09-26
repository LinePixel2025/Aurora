/**
 * 模式能力矩阵（docs/05 §6「模式能力对齐」）。
 *
 * 原则：**模式差异只体现在「自主感知能力」与「特化功能」两处，绝不裁剪 Agent 的
 * 基础能力**。工具注册与模式无关（`ModeManager` 不参与 `ToolRegistry`），因此
 * 每个条目的 `tools` 恒为 `SHARED_TOOLSET`——回归测试钉住这一点，防止未来有人
 * 给某个模式加「按模式裁剪工具」的隐性行为。
 */
import type { ModeId } from '@aurora/shared'

/** 全模式共享的基础工具集标识（工具表由全局门控决定，与模式无关） */
export const SHARED_TOOLSET = 'all-registered-globally' as const

export interface ModeCapability {
  id: ModeId
  displayName: string
  /** 基础工具集：恒为 SHARED_TOOLSET（docs/05 §6 原则 1） */
  tools: typeof SHARED_TOOLSET
  /** 自主感知订阅（差异点①）：模式「主动知道什么」 */
  perceptionSubscriptions: readonly string[]
  /** 特化功能（差异点②）：模式提示词 / 引导 / 专属配置带来的增量能力 */
  specialized: readonly string[]
  /** 是否仍为占位实现 */
  placeholder: boolean
}

export const MODE_CAPABILITY_MATRIX: readonly ModeCapability[] = [
  {
    id: 'classroom',
    displayName: 'ClassRoom Mode',
    tools: SHARED_TOOLSET,
    perceptionSubscriptions: ['clock(30s)', 'schedule(课程表)'],
    specialized: [
      '智慧感知文件夹分类管线',
      '课前提醒与科目文件夹直达',
      'ClassIsland 桥接（课表 / 状态 / 提醒）',
      'Agent 可修改的 ClassRoom 设置清单',
    ],
    placeholder: false,
  },
  {
    id: 'work',
    displayName: '工作模式',
    tools: SHARED_TOOLSET,
    perceptionSubscriptions: ['clock(60s)'],
    specialized: ['办公文档指引（Word / Excel / PPT / PDF）', '工作目录（workspaceDir）'],
    placeholder: false,
  },
  {
    id: 'code',
    displayName: '代码模式',
    tools: SHARED_TOOLSET,
    perceptionSubscriptions: [],
    specialized: ['（特化能力建设中：工作区项目识别、Git 状态感知等）'],
    placeholder: true,
  },
]

export function modeCapabilityOf(id: ModeId): ModeCapability | undefined {
  return MODE_CAPABILITY_MATRIX.find((capability) => capability.id === id)
}
