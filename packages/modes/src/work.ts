/**
 * Work Mode（docs/05 §4）—— BetaV2 初步实装。
 *
 * 面向办公场景：Office 文档 / 表格 / 演示文稿 / PDF 的处理、总结与生成。
 * 引导两步（工作目录 → 确认完成）；系统提示词指导 Agent 优先使用结构化 Office 工具，
 * 并强调覆盖 / 删除 / 移动前确认、产出文件落入工作目录、
 * 本模式不含课堂 / 课程表 / 课件分类功能（那些属于 ClassRoom Mode）。
 */
import type { IMode, ModeContext, ModeGuide, Settings } from '@aurora/shared'

export const WORK_GUIDE_ID = 'work-setup'
export const DEFAULT_WORK_DIR_NAME = 'Aurora/工作目录'

/** 默认工作目录：`<home>/Aurora/工作目录`（与 classroom 的感知文件夹同一套路） */
export function defaultWorkspaceDir(ctx: ModeContext): string {
  return ctx.fs.resolveUserPath(DEFAULT_WORK_DIR_NAME)
}

export const workGuide: ModeGuide = {
  id: WORK_GUIDE_ID,
  resumeable: true,
  steps: [
    {
      id: 'workspace-dir',
      field: 'modes.work.workspaceDir',
      question:
        '先设置「工作目录」：文档、表格、演示文稿等产出文件默认保存在这里。\n默认是 用户目录\\Aurora\\工作目录，你也可以直接回复一个绝对路径。',
      validate(answer, ctx) {
        if (answer.trim() === '') return '路径不能为空'
        const parsed = parsePathAnswer(answer, ctx)
        if (parsed === '') return '路径不能为空'
        return undefined
      },
      apply(answer, ctx) {
        const target = parsePathAnswer(answer, ctx)
        ctx.settings.mutate((draft) => {
          draft.modes.work.workspaceDir = target
        })
      },
    },
    {
      id: 'acknowledge',
      field: 'modes.work.guideCompleted',
      question:
        '工作模式配置完成：产出文件会保存到上面设定的工作目录，之后可随时在设置中修改。\n回复「知道了」结束本次引导。',
      validate(answer) {
        return answer.trim() === '' ? '请回复「知道了」以继续' : undefined
      },
      apply() {
        /* guideCompleted 由 GuideRunner 在全部步骤完成时统一标记 */
      },
    },
  ],
}

export function createWorkMode(): IMode {
  return {
    id: 'work',
    displayName: '工作模式',
    description: '办公场景：Office 文档、表格、演示文稿与 PDF 的处理、总结与生成。',
    placeholder: false,
    guide: workGuide,
    perceptionSubscriptions: [{ kind: 'clock', intervalMs: 60_000 }],

    async onActivate(ctx) {
      const workspaceDir = ctx.settings.get().modes.work.workspaceDir
      if (workspaceDir === '') {
        ctx.logger.info('工作模式已激活（尚未配置工作目录）')
        return
      }
      try {
        // 工作目录按需创建，避免用户手动建目录（引导 apply 是同步契约，只能在激活钩子里建）
        await ctx.fs.ensureDir(workspaceDir)
        ctx.logger.info('工作模式已激活', { workspaceDir })
      } catch (error) {
        // 目录创建失败不阻断模式激活（docs/02 §7 降级原则）
        ctx.logger.warn('工作目录创建失败', { workspaceDir, error: String(error) })
      }
    },

    async onDeactivate(ctx) {
      ctx.logger.info('工作模式已停用')
    },

    systemPrompt(ctx) {
      const workspaceDir = ctx.settings.get().modes.work.workspaceDir
      const dir = workspaceDir === '' ? '（尚未配置）' : workspaceDir
      return [
        '当前模式：工作模式（办公场景）。',
        '你是一位办公文档助手：擅长 Word 文档、Excel 表格、PowerPoint 演示文稿与 PDF 的处理、总结与生成。',
        `本模式工作目录（回落位）：${dir}`,
        '工作目录按单一回落链解析（docs/06 §5.1）：会话绑定项目 > 当前项目 > 本模式工作目录 > 电脑操控工具工作目录 > 用户主目录。',
        '不显式传 cwd 的命令、不传根的文件与检索工具、写入边界与免确认判定都落在同一条链解析出的目录上 ——',
        '提示词与工具链同源，不要假设存在别的「工作目录」；产出文件保存到该目录。',
        '工作方式：优先使用 office_read / office_create / office_edit 处理 DOCX / XLSX / PPTX；',
        '这些工具不依赖本机 Office，也不应为了普通创建 / 编辑再手写 PowerShell COM。',
        '默认另存新文件；只有用户明确要求覆盖时才传 overwrite，工具会强制先保存二进制快照。',
        '旧格式 .doc / .xls / .ppt、宏、复杂 SmartArt / 图表 / 动画或 PDF 导出若确需 COM，',
        '先明确说明风险并征得用户同意，再走 run_command；结构化工具报不支持时不得自动改用 COM。',
        '普通文本 / CSV / Markdown 仍用 read_file / write_file / list_dir；操作要点参考 office-work 技能。',
        '安全约束：覆盖 / 删除 / 移动用户的文件之前，必须先说明将要做什么并等待用户确认。',
        '职责边界：本模式不含课堂 / 课程表 / 课件分类功能——那些属于 ClassRoom Mode；',
        '若用户提出这类需求，请说明边界并引导其切换模式。',
      ].join('\n')
    },
  }
}

// ───────────────────────── 引导答案解析 ─────────────────────────

function parsePathAnswer(answer: string, ctx: ModeContext): string {
  const trimmed = answer.trim()
  if (isDefaultAnswer(trimmed)) return defaultWorkspaceDir(ctx)
  return ctx.fs.resolveUserPath(trimmed)
}

function isDefaultAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase()
  return normalized === '' || normalized === '默认' || normalized === 'default'
}

/** 供设置页展示：当前配置是否已具备办公场景的前提条件。 */
export function workReadiness(settings: Settings): { ready: boolean; missing: string[] } {
  const missing: string[] = []
  if (settings.modes.work.workspaceDir.trim() === '') missing.push('工作目录')
  return { ready: missing.length === 0, missing }
}
