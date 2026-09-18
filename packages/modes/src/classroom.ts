/**
 * ClassRoom Mode（docs/05 §3）—— v1 唯一完整实现的模式。
 *
 * P1 落地范围：模式激活 / 停用、系统提示词片段、对话式引导（感知文件夹 → 科目列表
 * → 每科目标文件夹 → 课前提醒）。文件监听与分类管线属 P4，不在此实现。
 */
import type { IMode, ModeContext, ModeGuide } from '@aurora/shared'
import { DEFAULT_SUBJECT_FOLDER_PREFIX, createDefaultSubjects, type Settings } from '@aurora/shared'
import { validateAbsolutePath } from './helpers.js'

const STATE_SUBJECTS = 'classroom.pendingSubjects'

export const CLASSROOM_GUIDE_ID = 'classroom-setup'
export const DEFAULT_WATCH_DIR_NAME = 'Aurora/感知文件夹'

/** 04 §P1 默认感知文件夹：`<home>/Aurora/感知文件夹` */
export function defaultWatchDir(ctx: ModeContext): string {
  return ctx.fs.resolveUserPath(DEFAULT_WATCH_DIR_NAME)
}

export const classroomGuide: ModeGuide = {
  id: CLASSROOM_GUIDE_ID,
  resumeable: true,
  steps: [
    {
      id: 'watch-dir',
      field: 'modes.classroom.watchDir',
      question:
        '先设置「智慧感知文件夹」：把新文件拖进去，我就能自动分析并归类。\n默认是 用户目录\\Aurora\\感知文件夹，你也可以直接回复一个绝对路径。',
      validate(answer, ctx) {
        if (answer.trim() === '') return '路径不能为空'
        const parsed = parsePathAnswer(answer, ctx)
        if (parsed === '') return '路径不能为空'
        return undefined
      },
      apply(answer, ctx) {
        const target = parsePathAnswer(answer, ctx)
        ctx.settings.mutate((draft) => {
          draft.modes.classroom.watchDir = target
        })
      },
    },
    {
      id: 'subjects',
      field: 'modes.classroom.subjects',
      question:
        '接下来是科目列表。默认包含 语文/数学/英语/物理/化学/生物/历史/地理/政治，\n如需调整请用逗号分隔回复（如：数学,物理,化学），回复「默认」使用模板。',
      validate(answer) {
        const names = parseNames(answer)
        return names.length === 0 && !isDefaultAnswer(answer) ? '至少需要一个科目' : undefined
      },
      apply(answer, ctx) {
        const names = isDefaultAnswer(answer)
          ? createDefaultSubjects().map((s) => s.name)
          : parseNames(answer)
        ctx.state.set(STATE_SUBJECTS, names)
        ctx.settings.mutate((draft) => {
          draft.modes.classroom.subjects = names.map((name) => ({
            name,
            folder: `${DEFAULT_SUBJECT_FOLDER_PREFIX}/${name}`,
            keywords:
              draft.modes.classroom.subjects.find((item) => item.name === name)?.keywords ?? [],
          }))
        })
      },
    },
    {
      id: 'subject-folders',
      field: 'modes.classroom.subjects[].folder',
      question:
        '每个科目的目标文件夹默认是「感知文件夹/分类/<科目>」。\n回复「默认」沿用该规则，或用「数学=D:\\课程\\数学」的形式逐个指定。',
      validate(answer) {
        if (isDefaultAnswer(answer) || answer.trim() === '') return undefined
        const pairs = parseFolderPairs(answer)
        if (pairs.length === 0) return '格式示例：数学=D:\\课程\\数学，多个用逗号分隔'
        return pairs.some((pair) => validateAbsolutePath(pair.folder) !== undefined)
          ? '目标文件夹需要是绝对路径'
          : undefined
      },
      apply(answer, ctx) {
        const pairs =
          isDefaultAnswer(answer) || answer.trim() === '' ? [] : parseFolderPairs(answer)
        const mapping = new Map(pairs.map((pair) => [pair.subject, pair.folder]))
        ctx.settings.mutate((draft) => {
          draft.modes.classroom.subjects = draft.modes.classroom.subjects.map((subject) => ({
            ...subject,
            folder: mapping.get(subject.name) ?? subject.folder ?? defaultFolder(subject.name),
          }))
        })
      },
    },
    {
      id: 'pre-class-reminder',
      field: 'modes.classroom.preClassReminder',
      question:
        '是否开启「上课前提醒」（按手动课程表，课前 5 分钟提醒并打开科目文件夹）？回复 是 / 否。',
      validate(answer) {
        return parseYesNo(answer) === undefined ? '请回复「是」或「否」' : undefined
      },
      apply(answer, ctx) {
        const enabled = parseYesNo(answer) ?? true
        ctx.settings.mutate((draft) => {
          draft.modes.classroom.preClassReminder = enabled
          if (!enabled) draft.modes.classroom.schedule = { provider: 'manual', lessons: [] }
        })
      },
    },
  ],
}

export function createClassroomMode(): IMode {
  return {
    id: 'classroom',
    displayName: 'ClassRoom Mode',
    description: '面向课堂学习：智慧感知文件夹自动归类资料，课前提醒并打开科目文件夹。',
    placeholder: false,
    guide: classroomGuide,
    perceptionSubscriptions: [{ kind: 'clock', intervalMs: 30_000 }, { kind: 'schedule' }],

    async onActivate(ctx) {
      const watchDir = ctx.settings.get().modes.classroom.watchDir
      if (watchDir !== '') {
        await ctx.fs.ensureDir(watchDir)
        ctx.logger.info('ClassRoom Mode 已激活', { watchDir })
      } else {
        ctx.logger.info('ClassRoom Mode 已激活（尚未配置感知文件夹）')
      }
      // 科目目标文件夹按需创建，避免用户手动建目录
      for (const subject of ctx.settings.get().modes.classroom.subjects) {
        const folder = subject.folder.trim()
        if (folder === '') continue
        try {
          await ctx.fs.ensureDir(ctx.fs.resolveUserPath(folder))
        } catch (error) {
          // 单个目录创建失败不应阻断模式激活（docs/02 §7 降级原则）
          ctx.logger.warn('科目文件夹创建失败', { subject: subject.name, error: String(error) })
        }
      }
    },

    async onDeactivate(ctx) {
      ctx.logger.info('ClassRoom Mode 已停用')
    },

    systemPrompt(ctx) {
      const settings = ctx.settings.get()
      const classroom = settings.modes.classroom
      const subjects = classroom.subjects.map((s) => s.name).join('、')
      const watchDir = classroom.watchDir === '' ? '（尚未配置）' : classroom.watchDir
      return [
        '当前模式：ClassRoom Mode（课堂学习）。',
        `智慧感知文件夹：${watchDir}`,
        `科目列表：${subjects || '（尚未配置）'}`,
        `课前提醒：${classroom.preClassReminder ? '已开启' : '已关闭'}（课程表：${classroom.schedule.lessons.length} 节课）`,
        '职责：帮助学生把资料归类到正确科目；回答时优先引用上述科目；',
        '涉及移动 / 删除文件的操作必须先说明将要做什么并等待用户确认。',
      ].join('\n')
    },
  }
}

// ───────────────────────── 引导答案解析 ─────────────────────────

function parsePathAnswer(answer: string, ctx: ModeContext): string {
  const trimmed = answer.trim()
  if (trimmed === '' || isDefaultAnswer(trimmed)) return defaultWatchDir(ctx)
  return ctx.fs.resolveUserPath(trimmed)
}

function isDefaultAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase()
  return normalized === '' || normalized === '默认' || normalized === 'default'
}

function parseNames(answer: string): string[] {
  return answer
    .split(/[,，、;；\n\r\t]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '' && !isDefaultAnswer(item))
}

function parseFolderPairs(answer: string): Array<{ subject: string; folder: string }> {
  const pairs: Array<{ subject: string; folder: string }> = []
  for (const chunk of answer.split(/[,，\n\r;；]+/)) {
    const [subject, folder] = chunk.split(/[=＝]/)
    if (subject === undefined || folder === undefined) continue
    const name = subject.trim()
    const target = folder.trim()
    if (name === '' || target === '') continue
    pairs.push({ subject: name, folder: target })
  }
  return pairs
}

function parseYesNo(answer: string): boolean | undefined {
  const normalized = answer.trim().toLowerCase()
  if (['是', '好', '开启', 'yes', 'y', 'true', 'ok'].includes(normalized)) return true
  if (['否', '不', '关闭', 'no', 'n', 'false'].includes(normalized)) return false
  return undefined
}

function defaultFolder(subject: string): string {
  return `${DEFAULT_SUBJECT_FOLDER_PREFIX}/${subject}`
}

/** 供设置页展示：当前配置是否已具备分类前提条件。 */
export function classroomReadiness(settings: Settings): { ready: boolean; missing: string[] } {
  const missing: string[] = []
  if (settings.modes.classroom.watchDir.trim() === '') missing.push('智慧感知文件夹')
  if (settings.modes.classroom.subjects.length === 0) missing.push('科目列表')
  return { ready: missing.length === 0, missing }
}
