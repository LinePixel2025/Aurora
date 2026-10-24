/**
 * 斜杠命令（`/`）的纯逻辑（docs/07 §2.3）。
 *
 * 从组件里抽出来的两个理由：
 * 1. `<script setup>` 的类型不能被外部导入，而 `App.vue` 需要 `SlashItem`；
 * 2. 过滤规则（前缀匹配、分组顺序、命令 vs 技能的处理差异）是**可以单测的纯函数**，
 *    不该埋在 SFC 里只能靠手点验证。
 *
 * 命令与技能的处理差异（用户可见的行为，改之前先想清楚）：
 * - `command`：**选中即执行**（`/new` 没有「补全成一句话再说」的意义）；
 * - `skill`：**只补全成 `/技能名 `** 并把焦点留在输入框，用户接着写需求 ——
 *   `/system-status 现在几点` 里的技能名只是「本轮把这份指令注入上下文」的开关。
 */
import type { PluginCommandInfo, SkillSummary } from '@aurora/shared'

export interface SlashItem {
  /** 唯一 id（`command:new` / `skill:file-classify` / `plugin:<id>:<name>`） */
  id: string
  /**
   * 三类：
   * - `command`：内置命令，选中即执行；
   * - `plugin-command`：插件命令（清单 `contributes.commands`），`action` 选中即执行、`prompt` 只补全；
   * - `skill`：技能，只补全成 `/技能名 `。
   */
  kind: 'command' | 'plugin-command' | 'skill'
  /** 插入 / 匹配用的名字（不含前缀），如 `new` / `file-classify` */
  name: string
  /** 主文案 */
  label: string
  /** 一句话说明 */
  description: string
  /** 插件命令的归属与模式（仅 `plugin-command` 使用） */
  pluginId?: string
  pluginMode?: 'action' | 'prompt'
}

/** 常驻命令（「停止回复」只在流式期间出现，单独一条） */
export const BUILTIN_COMMANDS: readonly SlashItem[] = [
  {
    id: 'command:new',
    kind: 'command',
    name: 'new',
    label: '新对话',
    description: '新建会话并切过去',
  },
  {
    id: 'command:clear',
    kind: 'command',
    name: 'clear',
    label: '清空消息区',
    description: '只清当前视图，已保存的历史不受影响',
  },
  {
    id: 'command:init',
    kind: 'command',
    name: 'init',
    label: '初始化 AGENTS.md',
    description: '探查当前项目并生成 / 补全 AGENTS.md 指南',
  },
  {
    id: 'command:compact',
    kind: 'command',
    name: 'compact',
    label: '压缩上下文',
    description: '把历史压成摘要，降低后续请求的上下文占用',
  },
  {
    id: 'command:subagents',
    kind: 'command',
    name: 'subagents',
    label: '子代理',
    description: '打开子代理页面看本会话的运行',
  },
  {
    id: 'command:settings',
    kind: 'command',
    name: 'settings',
    label: '设置',
    description: '打开设置窗口',
  },
]

/** 流式期间才有意义的命令：没有正在进行的回复时列出来只会点了没反应 */
export const SLASH_STOP_COMMAND: SlashItem = {
  id: 'command:stop',
  kind: 'command',
  name: 'stop',
  label: '停止回复',
  description: '中止正在进行的回复',
}

/**
 * 当前输入是否处于「命令名」区间：整串就是 `/xxx`（字母数字下划线连字符，无空格换行）。
 * 返回 `null` 表示不进入浮层；返回字符串表示匹配前缀（空串 = 刚敲完 `/`）。
 *
 * 刻意**只认开头的 `/` 且整串必须干净**：用户敲了空格（`/system-status 现在几点`）之后
 * 已经在写需求了，再挂一个浮层会挡住输入区。
 */
export function slashQueryOf(value: string): string | null {
  const matched = /^\/([A-Za-z0-9_-]*)$/.exec(value)
  return matched === null ? null : (matched[1] ?? '')
}

/**
 * 过滤候选：命令在前、技能在后（与菜单分组一致），组内保持原顺序。
 *
 * 前缀匹配而不是模糊匹配：命令名都很短，模糊匹配会把 `/s` 匹配到一堆不相干的技能上，
 * 反而要用户多按几次方向键。
 */
export function filterSlashItems(
  query: string,
  skills: readonly SkillSummary[],
  streaming: boolean,
  pluginCommands: readonly PluginCommandInfo[] = [],
): SlashItem[] {
  const needle = query.toLowerCase()
  const commands = streaming ? [SLASH_STOP_COMMAND, ...BUILTIN_COMMANDS] : BUILTIN_COMMANDS
  const matchedCommands = commands.filter((item) => item.name.startsWith(needle))
  const matchedPluginCommands = pluginCommands
    .filter((command) => command.name.toLowerCase().startsWith(needle))
    .map<SlashItem>((command) => ({
      id: `plugin:${command.pluginId}:${command.name}`,
      kind: 'plugin-command',
      name: command.name,
      label: command.title,
      description:
        command.description.trim() === ''
          ? `${command.pluginName} · ${command.mode === 'action' ? '选中即执行' : '补全为提示词'}`
          : `${command.pluginName} · ${command.description}`,
      pluginId: command.pluginId,
      pluginMode: command.mode,
    }))
  const matchedSkills = skills
    .filter((skill) => skill.enabled && skill.name.toLowerCase().startsWith(needle))
    .map<SlashItem>((skill) => ({
      id: `skill:${skill.name}`,
      kind: 'skill',
      name: skill.name,
      label: skill.name,
      description: skill.description.trim() === '' ? '调用该技能' : skill.description,
    }))
  return [...matchedCommands, ...matchedPluginCommands, ...matchedSkills]
}
