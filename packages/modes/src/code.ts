/** Code Mode —— v1 占位实现（docs/05 §4），能力位留给 P7。 */
import type { IMode, ModeGuide } from '@aurora/shared'

export const CODE_GUIDE_ID = 'code-setup'

export const codeGuide: ModeGuide = {
  id: CODE_GUIDE_ID,
  resumeable: true,
  steps: [
    {
      id: 'acknowledge',
      field: 'modes.code.guideCompleted',
      question:
        'Code Mode 目前处于建设中：后续会提供工作区项目识别、Git 状态感知与终端工具组。\n回复「知道了」即可完成本次引导。',
      validate(answer) {
        return answer.trim() === '' ? '请回复「知道了」以继续' : undefined
      },
      apply() {
        /* 占位模式无需写入额外配置 */
      },
    },
  ],
}

export function createCodeMode(): IMode {
  return {
    id: 'code',
    displayName: 'Code Mode',
    description: '编码场景（功能建设中）：工作区识别、Git 感知、终端工具组将在后续版本提供。',
    placeholder: true,
    guide: codeGuide,
    async onActivate(ctx) {
      ctx.logger.info('Code Mode 已激活（占位实现）')
    },
    async onDeactivate(ctx) {
      ctx.logger.info('Code Mode 已停用')
    },
    systemPrompt() {
      return [
        '当前模式：Code Mode（编码，功能建设中）。',
        '你可以正常对话与答疑；工作区识别、Git 感知与命令执行工具尚未接入，',
        '若用户请求这些功能，请说明当前版本暂未提供，并给出可用的替代做法。',
      ].join('\n')
    },
  }
}
