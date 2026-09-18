/** Work Mode —— v1 占位实现（docs/05 §4），能力位留给 P7。 */
import type { IMode, ModeGuide } from '@aurora/shared'

export const WORK_GUIDE_ID = 'work-setup'

export const workGuide: ModeGuide = {
  id: WORK_GUIDE_ID,
  resumeable: true,
  steps: [
    {
      id: 'acknowledge',
      field: 'modes.work.guideCompleted',
      question:
        'Work Mode 目前处于建设中：后续会提供日程 / 邮件 / 待办、文档摘要与会议纪要能力。\n回复「知道了」即可完成本次引导。',
      validate(answer) {
        return answer.trim() === '' ? '请回复「知道了」以继续' : undefined
      },
      apply() {
        /* 占位模式无需写入额外配置 */
      },
    },
  ],
}

export function createWorkMode(): IMode {
  return {
    id: 'work',
    displayName: 'Work Mode',
    description: '办公场景（功能建设中）：日程、文档摘要、会议纪要等能力将在后续版本提供。',
    placeholder: true,
    guide: workGuide,
    async onActivate(ctx) {
      ctx.logger.info('Work Mode 已激活（占位实现）')
    },
    async onDeactivate(ctx) {
      ctx.logger.info('Work Mode 已停用')
    },
    systemPrompt() {
      return [
        '当前模式：Work Mode（办公，功能建设中）。',
        '你可以正常对话与答疑；与该模式相关的日程 / 邮件 / 待办能力尚未接入，',
        '若用户请求这些功能，请说明当前版本暂未提供，并给出可用的替代做法。',
      ].join('\n')
    },
  }
}
