<script setup lang="ts">
/**
 * Agent 设置页（docs/06 §11、docs/08 §1，BetaV2 六页 IA；2026-10 前称「智能与工具」）：
 * 「电脑操控工具」「技能」「MCP 服务器」三个可折叠区组同页（spec §9）。
 *
 * 2026-09 信息架构收拢（docs/07 §2.5）：工具组默认展开、技能 / MCP 默认收起
 * （组头摘要承载状态，capture 探针先展开再计数）；安全告诫只在本组说明里完整表述一次；
 * 技能 / MCP 区组的操作回执经 `notify` 事件上抛，由本页唯一的 AppToast 统一渲染。
 *
 * 「电脑操控」是给模型装上"手"的一组工具（`COMPUTER_TOOL_NAMES` 里那 8 个：run_command /
 * read_file / write_file / edit_file / list_dir / open_path / grep / glob）：默认全开，
 * 但命令执行与文件写入（含 edit_file）是敏感工具，越界时逐次确认后才执行。
 * 本页是这套工具的**唯一**开关面，保存后由主进程 `onSettingsChanged` →
 * `computerTools.sync()` 立即重注册，无需重启。
 *
 * 为什么每处保存都要回传**完整**的 `agent.tools` 子树：
 * `settings:update` 只做**顶层浅合并**（见 packages/shared/src/ipc/types.ts 的
 * SettingsPatch 注释），`agent` 这一层不递归补全 —— 只传 `{ terminal: {...} }` 会让
 * `files` / `open` 被整块替换掉，等于静默丢配置（capture 里已有同类回归探针，别重犯）。
 * 所以本页所有保存都走 `save(patch)`：先读当前 tree，再 `{ ...currentTools, ...patch }`；
 * 改子对象时（terminal / files / search）patch 里也要带**完整子对象**，否则同级的 timeoutMs 等会被丢掉。
 *
 * 「文件备份」区组（v14，docs/06 §11.8）是本页唯一**不在** `agent.tools` 下的配置：
 * 快照是"写盘行为的兜底"而不是"注册哪些工具"，因此它既不跟总开关门控，
 * 保存也走独立的 `saveSnapshots()`（照 `save()` 的同一套回执口径）。
 *
 * 为什么 workspaceDir 不是沙箱（这条与页内安全文案同源，改文案别只改一处）：
 * 它只是工具的**默认**工作目录（缺省起点走 docs/06 §5.1 的 `effectiveWorkspaceDir` 三级回落：
 * 当前项目根 > workspaceDir > 用户主目录，配置了当前项目时以项目根优先），
 * 模型仍可显式传入任意绝对路径。
 * 安全边界是「权限档位 + 输出上限 + 总开关」，不是路径限制。
 *
 * `COMPUTER_TOOL_NAMES` 必须从 `@aurora/shared/browser` 取：主入口 `@aurora/shared`
 * 依赖 `node:fs`，一旦被拉进渲染层 bundle，Electron 构建会直接失败（AGENTS.md 架构硬约束 4）。
 */
import { computed, ref } from 'vue'
import { ChevronRight } from '@aurora/shared/browser'
import type {
  AgentSettings,
  AgentToolsConfig,
  ComputerToolName,
  PermissionMode,
} from '@aurora/shared/browser'
import {
  COMPUTER_TOOL_NAMES,
  DEFAULT_AGENT_TOOLS,
  DEFAULT_TOOLCHAIN_CONFIG,
  resolvePermissionMode,
} from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import SnapshotList from '../../shared/components/SnapshotList.vue'
import McpSection from '../components/McpSection.vue'
import SkillsSection from '../components/SkillsSection.vue'
import { useSettingsStore } from '../../shared/stores.js'

type ToastTone = 'info' | 'warn' | 'error' | 'ok'
type NotifyPayload = { tone: ToastTone; text: string }

const settingsStore = useSettingsStore()
/** 页级唯一 Toast：本页保存回执与技能 / MCP 区组上抛的 notify 都渲染在这里 */
const toast = ref<NotifyPayload | null>(null)
/** 「打开工作目录」成功回执里的真实路径（主进程解析后的绝对路径） */
const openedWorkspace = ref('')

/** 区组折叠状态：工具组默认展开（主配置面，探针字段常在 DOM）；技能 / MCP 默认收起 */
const openTools = ref(true)

function showToast(tone: ToastTone, text: string): void {
  toast.value = { tone, text }
}

/** 子区组上抛的回执统一进页级 Toast（docs/07 §2.5 的 Toast 归一口径） */
function onNotify(payload: NotifyPayload): void {
  toast.value = payload
}

/**
 * 当前工具配置。settings 未加载完时为 `null`，这里回落到 Schema 默认值 ——
 * 只是让控件有个初值（探针要求字段常显），保存时仍会再确认配置已就绪。
 */
const tools = computed<AgentToolsConfig>(
  () => settingsStore.settings?.agent.tools ?? DEFAULT_AGENT_TOOLS,
)

/**
 * 写前快照配置（`agent.snapshots`，v14，docs/06 §11.8）。
 *
 * 它**不在** `agent.tools` 里 —— 那是"注册哪些工具"的开关，而快照是"写盘行为的兜底"，
 * 与注册集合无关：所以本区组不跟总开关门控，保存也走独立的 `saveSnapshots()`。
 *
 * 配置未水合时回落到 Schema 默认值：直接取 `DEFAULT_TOOLCHAIN_CONFIG.agent.snapshots`
 * （与 `packages/shared/src/config/defaults.ts` 是同一份对象），不在这里抄第二遍常量。
 * 与 `tools` 同一口径 —— 只是让控件有初值，保存时仍会再确认配置已就绪。
 */
const snapshots = computed<AgentSettings['snapshots']>(
  () => settingsStore.settings?.agent.snapshots ?? DEFAULT_TOOLCHAIN_CONFIG.agent.snapshots,
)

/**
 * 每个工具名的门控，与主进程 `registerComputerTools()` 的注册条件一一对应：
 * 总开关关 → 一个都不注册；否则看各自的子开关。
 * v13 起还多一层**权限档位**：`readonly` 档下写入与命令类工具一律不注册（见 `activeToolNames`）。
 */
const TOOL_GATES: Record<ComputerToolName, (t: AgentToolsConfig) => boolean> = {
  run_command: (t) => t.terminal.enabled,
  read_file: (t) => t.files.enabled,
  write_file: (t) => t.files.enabled,
  edit_file: (t) => t.files.enabled,
  office_read: (t) => t.files.enabled,
  office_create: (t) => t.files.enabled,
  office_edit: (t) => t.files.enabled,
  list_dir: (t) => t.files.enabled,
  open_path: (t) => t.open.enabled,
  // 文件检索（grep / glob）归 v12 新增的 `agent.tools.search` 开关，与 files 分开
  grep: (t) => t.search.enabled,
  glob: (t) => t.search.enabled,
}

/**
 * 当前**生效**权限档位（三档，v13）：走 `resolvePermissionMode`，老开关
 * `advanced.confirmSensitiveTools === false` 会在这里被承接成 `auto` ——
 * 本页摘要必须按**生效档位**写，不能按 `agent.permissionMode` 的字面值写，
 * 否则老配置下会出现「摘要说还能写、实际模型看不到写工具」这类错位。
 */
const permissionMode = computed<PermissionMode>(() => {
  const settings = settingsStore.settings
  return settings === null ? 'confirm' : resolvePermissionMode(settings)
})

/** 是否处于只读档 */
const permissionReadonly = computed(() => permissionMode.value === 'readonly')

/**
 * 只读档下**仍会注册**的电脑操控工具（四个只读项）：
 * `run_command`（执行命令）/ `write_file` / `edit_file`（写入）/ `open_path`（用系统程序打开）
 * 在只读档一律不注册，因此本表是 `TOOL_GATES` 之外的第二层过滤。
 */
const READONLY_COMPUTER_TOOL_NAMES: readonly ComputerToolName[] = [
  'read_file',
  'office_read',
  'list_dir',
  'grep',
  'glob',
]

/**
 * 当前档位 + 配置下**会注册**的工具名，顺序照 `COMPUTER_TOOL_NAMES`（即注册顺序，便于比对）。
 *
 * 这里覆盖 `COMPUTER_TOOL_NAMES` 里的全部电脑操控工具。只读档另有三类**不在本表**的名字
 * 仍会注册（因此只读档的小结不能只看这个数组）：`todo_read`（写入口 `todo_write` 在只读档不注册）
 * 由内核工具装配器注册、`use_skill` 由技能装配器注册、`set_setting` 由配置工具装配器注册，
 * 外加按服务器动态注册的 MCP 工具与扩展工具七件套 —— 它们都不受 `agent.tools.enabled` 门控，
 * 在模板「当前生效工具」的只读分支里逐个列出。
 */
const activeToolNames = computed<ComputerToolName[]>(() => {
  const current = tools.value
  if (!current.enabled) return []
  return COMPUTER_TOOL_NAMES.filter(
    (name) =>
      TOOL_GATES[name](current) &&
      (!permissionReadonly.value || READONLY_COMPUTER_TOOL_NAMES.includes(name)),
  )
})

/**
 * 区组头部摘要：收起时也能看出工具的启停状态。
 *
 * 只读档用的是 capture 探针断言的**原文**（一个字都别改）：这一档下「几个 / 共几个」没有意义
 * —— 注册集合已经被权限档位整体改写，报数量反而会让人以为只是少了一部分。
 */
const toolsSummary = computed(() => {
  if (permissionReadonly.value) return '只读模式：仅注册只读工具（不含写入与命令）'
  return tools.value.enabled
    ? `${activeToolNames.value.length} / ${COMPUTER_TOOL_NAMES.length} 个工具生效`
    : '已停用'
})

/**
 * 保存工具配置：失败时的回执口径全页统一（Toast 展示 `settingsStore.error`）。
 * 返回是否写盘成功 —— 只给「免确认命令模式」的输入框用（失败时把原文留在框里便于改）。
 */
async function save(patch: Partial<AgentToolsConfig>): Promise<boolean> {
  const current = settingsStore.settings?.agent.tools
  // 未加载完就写等于用兜底默认值把已保存的配置整棵覆盖掉，宁可先不写
  if (!current) return false
  const ok = await settingsStore.update({ agent: { tools: { ...current, ...patch } } })
  if (!ok) {
    if (settingsStore.error) showToast('error', settingsStore.error)
  } else {
    showToast('ok', '已保存')
  }
  return ok
}

/** 改终端子对象：patch 里带完整 terminal 子树，避免丢掉 timeoutMs / maxOutputChars */
async function saveTerminal(patch: Partial<AgentToolsConfig['terminal']>): Promise<boolean> {
  return save({ terminal: { ...tools.value.terminal, ...patch } })
}

/** 改文件子对象：同上，带完整 files 子树 */
async function saveFiles(patch: Partial<AgentToolsConfig['files']>): Promise<boolean> {
  return save({ files: { ...tools.value.files, ...patch } })
}

/** 改文件检索子对象：同上，带完整 search 子树（否则 maxResults 与 enabled 会互相丢） */
async function saveSearch(patch: Partial<AgentToolsConfig['search']>): Promise<boolean> {
  return save({ search: { ...tools.value.search, ...patch } })
}

/** 改打开子对象：完整子树回写，避免只改开关时把 urlMode 丢掉 */
async function saveOpen(patch: Partial<AgentToolsConfig['open']>): Promise<boolean> {
  return save({ open: { ...tools.value.open, ...patch } })
}

const OPEN_URL_MODES = [
  { value: 'internal', label: '内置浏览器' },
  { value: 'external', label: '外部浏览器' },
] as const

/**
 * 保存写前快照配置（v14）：与工具区组同一套回执口径（失败时 Toast 展示 `settingsStore.error`）。
 *
 * `settings:update` 只有顶层浅合并 —— `agent` 整棵都要带上（只传 `{ snapshots }` 会把
 * `tools` / `permissionMode` 整块替换掉），patch 里带完整的 `snapshots` 子树
 * （否则同级的 keepPerFile / maxSnapshotBytes 会被一并丢掉）。
 */
async function saveSnapshots(patch: Partial<AgentSettings['snapshots']>): Promise<boolean> {
  const current = settingsStore.settings?.agent
  // 未加载完就写等于用兜底默认值把已保存的配置整棵覆盖掉，宁可先不写（与 save 同口径）
  if (!current) return false
  const ok = await settingsStore.update({
    agent: { ...current, snapshots: { ...current.snapshots, ...patch } },
  })
  if (!ok) {
    if (settingsStore.error) showToast('error', settingsStore.error)
  } else {
    showToast('ok', '已保存')
  }
  return ok
}

/**
 * 切换文件备份总开关。
 *
 * 关掉是**不可逆方向**（此后的写文件不再留底），所以回执换成 warn 口径、把
 * "改动将不可回滚"再说一次 —— 只回一句「已保存」在这条路径上没有信息量。
 */
async function setSnapshotsEnabled(enabled: boolean): Promise<void> {
  const ok = await saveSnapshots({ enabled })
  if (ok && !enabled) showToast('warn', '已关闭文件备份：此后的写文件改动将不可回滚')
}

/**
 * Agent 循环配置（`agent.loop`，v15，docs/06 §4.1）。
 *
 * 第三个**不在** `agent.tools` 下的配置：轮次 / token 预算 / 自动续轮描述的是
 * 「一次请求怎么跑完」，与「注册哪些工具」无关，因此同样不跟总开关门控，
 * 保存也走独立的 `saveLoop()`。
 *
 * 配置未水合时回落到 Schema 默认值（`DEFAULT_TOOLCHAIN_CONFIG` 与 `defaults.ts` 是同一份对象，
 * 见 `snapshots` 的同一处理）：只是让控件有初值，保存时仍会再确认配置已就绪。
 */
const loop = computed<AgentSettings['loop']>(
  () => settingsStore.settings?.agent.loop ?? DEFAULT_TOOLCHAIN_CONFIG.agent.loop,
)

/**
 * 保存循环配置：与工具区组同一套回执口径（失败时 Toast 展示 `settingsStore.error`）。
 *
 * `settings:update` 只有顶层浅合并 —— `agent` 整棵都要带上（只传 `{ loop }` 会把
 * `tools` / `permissionMode` / `snapshots` 整块替换掉），patch 里带完整的 `loop` 子树
 * （否则同级的另外两个字段会被一并丢掉）。
 */
async function saveLoop(patch: Partial<AgentSettings['loop']>): Promise<boolean> {
  const current = settingsStore.settings?.agent
  // 未加载完就写等于用兜底默认值把已保存的配置整棵覆盖掉，宁可先不写（与 save 同口径）
  if (!current) return false
  const ok = await settingsStore.update({
    agent: { ...current, loop: { ...current.loop, ...patch } },
  })
  if (!ok) {
    if (settingsStore.error) showToast('error', settingsStore.error)
  } else {
    showToast('ok', '已保存')
  }
  return ok
}

/**
 * `loop.maxTotalTokens` 的取值上限：Schema 里**只有下限**（≥ 0）、没有上限，
 * 这里按 JS 安全整数收口 —— 拦的是 `Infinity` / `1e30` 这类会被原样存进配置、
 * 之后所有预算比较都恒真的脏值。
 */
const MAX_LOOP_TOKENS = Number.MAX_SAFE_INTEGER

/**
 * `totalBudgetBytes` 的取值上限：Schema 里**只有下限**（≥ 1 MiB）、没有上限，
 * 这里按 JS 安全整数收口 —— 拦的是 `Infinity` / `1e30` 这类会被 `Math.round` 原样带下去、
 * 存进配置后所有容量比较都恒真的脏值。
 */
const MAX_TOTAL_BUDGET_BYTES = Number.MAX_SAFE_INTEGER

/**
 * 「免确认命令模式」的输入草稿与即时提示（docs/06 §11.7、docs/08 §6）。
 *
 * 即时只判「非空」：**「必须含具体字符 / 不支持花括号」这类规则不在渲染层重复实现** ——
 * 它由 Schema 的 `allowPatterns` refine 兜底，保存失败时 `save()` 会把
 * `settings:update` 返回的「配置校验失败：…」原样送进 Toast。两处各写一份规则迟早会漂移，
 * 而漂移的后果是「界面说合法、存下去却永不生效」或反过来。
 */
const newAllowPattern = ref('')
const allowPatternHint = ref('')

/** 添加一条：去空白后为空只提示不添加；否则整表回写（完整 terminal 子树见 saveTerminal） */
async function addAllowPattern(): Promise<void> {
  const pattern = newAllowPattern.value.trim()
  if (pattern === '') {
    allowPatternHint.value = '模式不能为空，未添加。'
    return
  }
  allowPatternHint.value = ''
  const ok = await saveTerminal({
    allowPatterns: [...tools.value.terminal.allowPatterns, pattern],
  })
  // 写盘成功才清空输入框：被 Schema 拒掉时把原文留着，用户照着 Toast 的提示改就行
  if (ok) newAllowPattern.value = ''
}

/** 删除第 index 条：越界直接忽略，避免拿陈旧下标删掉相邻的一条 */
async function removeAllowPattern(index: number): Promise<void> {
  const patterns = tools.value.terminal.allowPatterns
  if (index < 0 || index >= patterns.length) return
  await saveTerminal({ allowPatterns: patterns.filter((_, i) => i !== index) })
}

/** 数字输入解析：非数字回落原值，越界夹到 Schema 的 min/max（主进程还会再校验一次） */
function clampNumber(event: Event, min: number, max: number, fallback: number): number {
  const raw = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.round(raw)))
}

/** 打开工作目录：主进程按生效工作目录（三级回落：当前项目根 > workspaceDir > 用户主目录）解析出真实路径 */
async function openWorkspace(): Promise<void> {
  const result = await window.aurora.app.openPath({ kind: 'workspace' })
  if (result.ok) {
    openedWorkspace.value = result.value
    showToast('info', `工作目录：${result.value}`)
  } else if (result.message) {
    showToast('error', result.message)
  }
}
</script>

<template>
  <!-- page-agent：样式钩子，本页把 collapse 动画的高度上限抬高（见 settings.css） -->
  <section class="page page-agent">
    <header>
      <h1 class="page-title">Agent 设置</h1>
      <p class="page-sub">电脑操控工具、技能与 MCP 服务器。</p>
    </header>

    <!-- 页级唯一 Toast（技能 / MCP 区组的回执经 notify 上抛到这里） -->
    <AppToast v-if="toast" :tone="toast.tone">{{ toast.text }}</AppToast>

    <!-- ───────── 区组一：电脑操控工具 ───────── -->
    <section class="group section-card">
      <button
        class="group-head"
        type="button"
        :aria-expanded="openTools"
        @click="openTools = !openTools"
      >
        <ChevronRight
          class="chevron"
          :class="{ open: openTools }"
          :size="14"
          :stroke-width="1.8"
          aria-hidden="true"
        />
        <span class="section-title">电脑操控工具</span>
        <span class="group-summary tiny muted grow">{{ toolsSummary }}</span>
      </button>

      <Transition name="collapse">
        <div v-if="openTools" class="group-body">
          <!--
            安全告诫全页唯一一处完整表述（docs/07 §2.5 文案收敛）：
            直接影响真实系统 + 敏感工具越界确认 + 工作目录不是沙箱，都在这里说清。
          -->
          <p class="section-desc">
            让模型执行命令、读写文件与打开路径。变更前确认项目根内直接执行、越界弹卡；完全权限不再弹卡；
            档位在输入框权限钮或「系统」页切换。工作目录<strong>不是沙箱</strong>。
          </p>

          <!-- 总开关 -->
          <div class="sub">
            <h3 class="sub-title">总开关</h3>
            <!--
              本段刻意不复述工具数量与名字：区组下方的「当前生效工具」一栏有实时清单，
              加工具时也不会留下「文案说 5 个、实际注册 8 个」这类偏差。
            -->
            <p class="section-desc">
              关闭后模型<strong>完全看不到</strong>这些工具：系统提示词与工具表里都不再出现，保存后立即生效。
            </p>

            <SettingField
              data-field="agent.tools.enabled"
              label="启用电脑操控"
              hint="默认开启；关闭后工具完全不注册，模型无从请求"
            >
              <label class="row tiny">
                <input
                  type="checkbox"
                  :checked="tools.enabled"
                  @change="save({ enabled: ($event.target as HTMLInputElement).checked })"
                />
                <span>允许模型使用终端、文件与打开路径工具</span>
              </label>
            </SettingField>
          </div>

          <!-- 工作目录 -->
          <div class="sub">
            <h3 class="sub-title">工作目录</h3>
            <p class="section-desc">
              <strong>命令</strong>不传路径时的缺省工作目录，有当前项目时以项目根优先；
              文件类工具的相对路径不按它解析。
            </p>

            <SettingField
              data-field="agent.tools.workspaceDir"
              label="默认工作目录"
              hint="留空 = 用户主目录，有当前项目时以项目根优先；作用于命令缺省 cwd 与检索缺省根"
            >
              <input
                class="input"
                type="text"
                spellcheck="false"
                placeholder="例如 D:\Projects"
                :value="tools.workspaceDir"
                @change="save({ workspaceDir: ($event.target as HTMLInputElement).value })"
              />
            </SettingField>

            <div class="row wrap">
              <AppButton size="sm" @click="openWorkspace">打开工作目录</AppButton>
              <span v-if="openedWorkspace" class="tiny muted mono">{{ openedWorkspace }}</span>
            </div>
          </div>

          <!-- 终端 -->
          <div class="sub">
            <h3 class="sub-title">终端</h3>
            <p class="section-desc">
              执行命令（<code class="mono">run_command</code>）：敏感工具；超时即杀进程。
            </p>

            <template v-if="tools.enabled">
              <SettingField
                data-field="agent.tools.terminal.enabled"
                label="启用终端工具"
                hint="关闭后模型看不到 run_command，其余工具不受影响"
              >
                <label class="row tiny">
                  <input
                    type="checkbox"
                    :checked="tools.terminal.enabled"
                    @change="saveTerminal({ enabled: ($event.target as HTMLInputElement).checked })"
                  />
                  <span>允许模型执行命令（默认开启）</span>
                </label>
              </SettingField>

              <SettingField
                data-field="agent.tools.terminal.timeoutMs"
                label="命令超时"
                hint="单位毫秒，1000 ～ 300000，默认 60000；超时强制结束进程并回传已捕获输出"
              >
                <input
                  class="input input-num"
                  type="number"
                  min="1000"
                  max="300000"
                  step="1000"
                  :value="tools.terminal.timeoutMs"
                  @change="
                    saveTerminal({
                      timeoutMs: clampNumber($event, 1000, 300000, tools.terminal.timeoutMs),
                    })
                  "
                />
              </SettingField>

              <SettingField
                data-field="agent.tools.terminal.maxOutputChars"
                label="输出上限"
                hint="单位字符，500 ～ 100000，默认 8000；超出部分截断"
              >
                <input
                  class="input input-num"
                  type="number"
                  min="500"
                  max="100000"
                  step="500"
                  :value="tools.terminal.maxOutputChars"
                  @change="
                    saveTerminal({
                      maxOutputChars: clampNumber(
                        $event,
                        500,
                        100000,
                        tools.terminal.maxOutputChars,
                      ),
                    })
                  "
                />
              </SettingField>
            </template>

            <p v-else class="tiny muted" data-empty="agent.tools.terminal">
              关闭总开关后终端工具不会注册：模型看不到 run_command。
            </p>
          </div>

          <!--
            免确认命令模式（v12，docs/06 §11.7）：只作用于 run_command，所以紧跟在终端之后。
            它是「减少打扰」而不是「安全加固」—— 口径文案就在下面这一段，改文案别只改一处。
          -->
          <div class="sub">
            <h3 class="sub-title">免确认命令模式</h3>
            <p class="section-desc">
              <code class="mono">run_command</code> 的命令串按 glob
              <strong>全串</strong>匹配，不区分大小写； 命中即跳过确认卡，未命中的按权限档位判定。
            </p>
            <!--
              `*` 跨命令分隔符的披露（docs/06 §11.7）：模式是纯文本匹配，`*` 编译成 .*，
              所以 `;` / `&&` / `|` 对它没有特殊含义 —— 不写清楚，用户会以为 `git status*`
              只放行 `git status` 这一条命令。
            -->
            <p class="tiny muted">
              <code class="mono">*</code> 也匹配 <code class="mono">;</code>、
              <code class="mono">&amp;&amp;</code>、<code class="mono">|</code> 等分隔符：填
              <code class="mono">git status*</code> 会连
              <code class="mono">git status; 任意命令</code> 一起放行；要收窄就写完整命令
              <code class="mono">git status</code>。
            </p>
            <!-- 口径说明（docs/06 §11.7）：这段是本页唯一一处表述，且必须成句完整出现 -->
            <p class="tiny">
              命中即跳过确认卡，属减少打扰而非安全加固；该列表只能在这里改，AI 改不动。
            </p>

            <template v-if="tools.enabled">
              <!--
                容器**恰好一个**挂 data-field（值为 agent.tools.terminal.allowPatterns）：
                capture 的 SETTINGS_AGENT_FIELDS_SCRIPT 按数量断言（=== 1），列表行与输入框
                都放在这个容器**内部**，不要再各自挂同前缀的 data-field（多一个就破坏计数）。
              -->
              <div class="allow-patterns" data-field="agent.tools.terminal.allowPatterns">
                <!-- 空状态用普通文案元素：本页多出一个空状态锚点会被 capture 判成回归 -->
                <p v-if="tools.terminal.allowPatterns.length === 0" class="tiny muted">
                  暂未添加，当前没有可跳过确认卡的命令模式。
                </p>

                <ul v-else class="pattern-list">
                  <li
                    v-for="(pattern, index) in tools.terminal.allowPatterns"
                    :key="`${index}:${pattern}`"
                    class="row tiny"
                  >
                    <code class="mono grow">{{ pattern }}</code>
                    <AppButton
                      size="sm"
                      variant="ghost"
                      :data-action="`agent.tools.terminal.allowPatterns.remove.${index}`"
                      @click="removeAllowPattern(index)"
                    >
                      删除
                    </AppButton>
                  </li>
                </ul>

                <div class="row wrap">
                  <input
                    v-model="newAllowPattern"
                    class="input"
                    type="text"
                    spellcheck="false"
                    placeholder="例如 git status*"
                    @input="allowPatternHint = ''"
                    @keydown.enter="addAllowPattern"
                  />
                  <AppButton size="sm" @click="addAllowPattern">添加</AppButton>
                </div>
                <!-- 即时校验只报「非空」；其余非法形态由保存时的 Schema 校验经 Toast 回显 -->
                <p v-if="allowPatternHint" class="tiny muted">{{ allowPatternHint }}</p>
              </div>
            </template>

            <p v-else class="tiny muted">
              总开关已关闭：这一栏不生效，命令仍按权限档位判定，已填内容保留。
            </p>
          </div>

          <!-- 文件 -->
          <div class="sub">
            <h3 class="sub-title">文件</h3>
            <p class="section-desc">读取、写入、精确替换与列目录：写入与替换是敏感工具。</p>

            <template v-if="tools.enabled">
              <SettingField
                data-field="agent.tools.files.enabled"
                label="启用文件工具"
                hint="关闭后模型看不到这 4 个文件工具，其余工具不受影响"
              >
                <label class="row tiny">
                  <input
                    type="checkbox"
                    :checked="tools.files.enabled"
                    @change="saveFiles({ enabled: ($event.target as HTMLInputElement).checked })"
                  />
                  <span>允许模型读写文件与列目录（默认开启）</span>
                </label>
              </SettingField>

              <SettingField
                data-field="agent.tools.files.maxReadBytes"
                label="单次读取上限"
                hint="单位字节，1024 ～ 4194304，默认 262144；超出即拒绝并提示分段读取"
              >
                <input
                  class="input input-num"
                  type="number"
                  min="1024"
                  max="4194304"
                  step="1024"
                  :value="tools.files.maxReadBytes"
                  @change="
                    saveFiles({
                      maxReadBytes: clampNumber($event, 1024, 4194304, tools.files.maxReadBytes),
                    })
                  "
                />
              </SettingField>
            </template>

            <p v-else class="tiny muted" data-empty="agent.tools.files">
              关闭总开关后文件工具不会注册：模型看不到 read_file / write_file / edit_file /
              list_dir。
            </p>
          </div>

          <!--
            文件备份（v14，docs/06 §11.8）：紧跟在「文件」之后 —— 它兜的正是
            write_file / edit_file 的底。刻意**不**放进 `tools.enabled` 的门控：
            快照是"写盘行为的兜底"，与注册哪些工具无关（工具关着时它自然不生效，
            但配置项本身照常可改）。
            2026-09 起回滚列表（SnapshotList）也从主界面右栏迁到这里：
            回滚属于「排查 / 补救」动作，主界面右栏只留上下文卡片。
          -->
          <div class="sub">
            <h3 class="sub-title">文件备份</h3>
            <p class="section-desc">
              写文件 / 改文件落盘前，先把磁盘上的<strong>原内容</strong>存一份到本机，改错可回滚；
              回滚也会先留一份快照，备份只存本机、不上传。
            </p>

            <SettingField
              data-field="agent.snapshots.enabled"
              label="启用文件备份"
              hint="默认开启；关闭后写文件不再留底，改动将不可回滚"
            >
              <label class="row tiny">
                <input
                  type="checkbox"
                  :checked="snapshots.enabled"
                  @change="setSnapshotsEnabled(($event.target as HTMLInputElement).checked)"
                />
                <span>写文件 / 改文件前自动留底（默认开启）</span>
              </label>
            </SettingField>

            <template v-if="snapshots.enabled">
              <SettingField
                data-field="agent.snapshots.keepPerFile"
                label="每文件保留份数"
                hint="1 ～ 200，默认 20；每个文件最多留几份，超出删最旧的"
              >
                <input
                  class="input input-num"
                  type="number"
                  min="1"
                  max="200"
                  step="1"
                  :value="snapshots.keepPerFile"
                  @change="
                    saveSnapshots({
                      keepPerFile: clampNumber($event, 1, 200, snapshots.keepPerFile),
                    })
                  "
                />
              </SettingField>

              <SettingField
                data-field="agent.snapshots.maxSnapshotBytes"
                label="单份快照上限"
                hint="单位字节，1024 ～ 67108864，默认 524288；超过此大小的文件不留底"
              >
                <input
                  class="input input-num"
                  type="number"
                  min="1024"
                  max="67108864"
                  step="1024"
                  :value="snapshots.maxSnapshotBytes"
                  @change="
                    saveSnapshots({
                      maxSnapshotBytes: clampNumber(
                        $event,
                        1024,
                        67108864,
                        snapshots.maxSnapshotBytes,
                      ),
                    })
                  "
                />
              </SettingField>

              <SettingField
                data-field="agent.snapshots.totalBudgetBytes"
                label="备份总容量上限"
                hint="单位字节，≥ 1048576，默认 209715200；超出总容量上限时从最旧的开始删"
              >
                <input
                  class="input input-num"
                  type="number"
                  min="1048576"
                  :max="MAX_TOTAL_BUDGET_BYTES"
                  step="1048576"
                  :value="snapshots.totalBudgetBytes"
                  @change="
                    saveSnapshots({
                      totalBudgetBytes: clampNumber(
                        $event,
                        1048576,
                        MAX_TOTAL_BUDGET_BYTES,
                        snapshots.totalBudgetBytes,
                      ),
                    })
                  "
                />
              </SettingField>
            </template>

            <!-- 关闭态的说明：整块替换三个数字字段（照本页既有门控口径，控件不在 DOM） -->
            <p v-else class="tiny muted" data-empty="agent.snapshots">
              已关闭文件备份：写文件前不再留底，<strong>改动将不可回滚</strong>。保留份数与容量上限维持原值，重新开启后生效。
            </p>

            <!--
              备份列表 + 「立即清理」（2026-09 自主界面右栏迁入）：列表展示全部会话的最近
              5 条、逐条两段式回滚（锚点 `agent.snapshot-*`，capture 探针同步）。
              设置窗口拿不到"当前会话"（会话 id 是 chat 窗 `useChat()` 内部的 ref），
              所以 `prune` 走 composable 的**全部会话**语义：先列全量快照、按 sessionId
              去重后逐个淘汰，主进程的 `snapshots:prune` 契约（按会话粒度）不变。
              列表挂在门控之外：关掉开关后历史备份仍可查看 / 回滚 / 清理。
            -->
            <SnapshotList :limit="5" />
          </div>

          <!-- 文件检索 -->
          <div class="sub">
            <h3 class="sub-title">文件检索</h3>
            <p class="section-desc">
              按文件名模式或正则内容检索（<code class="mono">grep</code>、<code class="mono"
                >glob</code
              >）： 只读工具，但会递归扫描整个搜索目录。
            </p>

            <template v-if="tools.enabled">
              <SettingField
                data-field="agent.tools.search.enabled"
                label="启用文件检索工具"
                hint="关闭后模型看不到 grep / glob，其余工具不受影响"
              >
                <label class="row tiny">
                  <input
                    type="checkbox"
                    :checked="tools.search.enabled"
                    @change="saveSearch({ enabled: ($event.target as HTMLInputElement).checked })"
                  />
                  <span>允许模型按文件名模式或正则内容检索（默认开启）</span>
                </label>
              </SettingField>

              <SettingField
                data-field="agent.tools.search.maxResults"
                label="结果条数上限"
                hint="1 ～ 1000，默认 200；grep 按命中行、glob 按文件计，超出即截断"
              >
                <input
                  class="input input-num"
                  type="number"
                  min="1"
                  max="1000"
                  step="10"
                  :value="tools.search.maxResults"
                  @change="
                    saveSearch({
                      maxResults: clampNumber($event, 1, 1000, tools.search.maxResults),
                    })
                  "
                />
              </SettingField>
            </template>

            <p v-else class="tiny muted">关闭总开关后检索工具不会注册：模型看不到 grep / glob。</p>
          </div>

          <!-- 打开 -->
          <div class="sub">
            <h3 class="sub-title">打开</h3>
            <p class="section-desc">
              模型打开文件、目录或链接（<code class="mono">open_path</code>）：敏感工具。
            </p>

            <template v-if="tools.enabled">
              <SettingField
                data-field="agent.tools.open.enabled"
                label="启用打开工具"
                hint="关闭后模型看不到 open_path，其余工具不受影响"
              >
                <label class="row tiny">
                  <input
                    type="checkbox"
                    :checked="tools.open.enabled"
                    @change="saveOpen({ enabled: ($event.target as HTMLInputElement).checked })"
                  />
                  <span>允许模型打开文件、目录或链接（默认开启）</span>
                </label>
              </SettingField>

              <SettingField
                data-field="agent.tools.open.urlMode"
                label="网页打开方式"
                hint="只影响模型打开 http(s) 网址；本地文件始终进入右栏"
              >
                <div class="segmented" role="group" aria-label="网页打开方式">
                  <button
                    v-for="option in OPEN_URL_MODES"
                    :key="option.value"
                    type="button"
                    :class="{ active: tools.open.urlMode === option.value }"
                    :aria-pressed="tools.open.urlMode === option.value"
                    @click="saveOpen({ urlMode: option.value })"
                  >
                    {{ option.label }}
                  </button>
                </div>
              </SettingField>
            </template>

            <p v-else class="tiny muted" data-empty="agent.tools.open">
              关闭总开关后打开工具不会注册：模型看不到 open_path。
            </p>
          </div>

          <!-- 当前生效工具 -->
          <div class="sub">
            <h3 class="sub-title">当前生效工具</h3>
            <!--
              只读档（v13）：这里是探针断言的原文，一个字都别改。
              下面列出的名字必须与主进程在只读档**实际注册**的集合一致 ——
              写入 / 命令 / 打开 / 待办写入都不在其中，只读项与非门控工具照常在。
            -->
            <p v-if="permissionReadonly" class="section-desc">
              只读模式：仅注册只读工具（不含写入与命令）—— 下一次请求的工具表里只有下面这
              {{ activeToolNames.length }} 个电脑操控工具。
            </p>
            <p v-else class="section-desc">
              按当前配置实时计算：模型下一次请求的工具表就是这些（共
              {{ activeToolNames.length }} / {{ COMPUTER_TOOL_NAMES.length }} 个）。
            </p>

            <div v-if="activeToolNames.length > 0" class="row wrap">
              <code v-for="name in activeToolNames" :key="name" class="mono">{{ name }}</code>
            </div>
            <p v-else-if="permissionReadonly" class="tiny muted">
              总开关已关闭：只读档下 {{ COMPUTER_TOOL_NAMES.length }} 个电脑操控工具一个都不会注册。
            </p>
            <p v-else class="tiny muted">
              总开关已关闭：{{ COMPUTER_TOOL_NAMES.length }} 个电脑操控工具一个都不会注册。
            </p>

            <!--
              只读档的补集：这些名字不在 `COMPUTER_TOOL_NAMES` 里，因此上面的门控算不到它们，
              但它们在只读档**照常注册**（不受总开关与权限档位门控）—— 摘要少了这一段，
              就成了「说只读、又没说还剩什么」的半句口径。
            -->
            <p v-if="permissionReadonly" class="section-desc">
              另外仍然注册：<code class="mono">todo_read</code>、<code class="mono">use_skill</code
              >、<code class="mono">set_setting</code>，以及 MCP 与扩展工具（<code class="mono"
                >web_fetch</code
              >、<code class="mono">clipboard_read</code>、<code class="mono">clipboard_write</code
              >、<code class="mono">notify_user</code>、<code class="mono">generate_image</code
              >、<code class="mono">show_preview</code>、<code class="mono">show_image</code>）——
              它们不受总开关与档位门控，敏感的仍逐次确认。
            </p>
          </div>

          <!--
            Agent 循环（v15，docs/06 §4.1）：与「文件备份」同一处境的非 `agent.tools` 配置 ——
            它管的是「一次请求怎么停下来」，不是「注册哪些工具」，所以同样不跟总开关门控。
            放在本组最后：前面都是具体工具的能力开关，这里是循环本身的刹车与油门。
          -->
          <div class="sub">
            <h3 class="sub-title">Agent 循环</h3>
            <p class="section-desc">一次请求里「思考 → 调用工具 → 再思考」的循环上限。</p>
            <p class="section-desc">
              触顶时任务<strong>不会静默结束</strong>：它会停成「已暂停」，可在主界面右栏的任务面板继续。
            </p>

            <SettingField
              data-field="agent.loop.maxRounds"
              label="轮次上限"
              hint="1 ～ 128，默认 32；一次请求最多几轮工具调用，用完即暂停等续跑"
            >
              <input
                class="input input-num"
                type="number"
                min="1"
                max="128"
                step="1"
                :value="loop.maxRounds"
                @change="saveLoop({ maxRounds: clampNumber($event, 1, 128, loop.maxRounds) })"
              />
            </SettingField>

            <SettingField
              data-field="agent.loop.maxTotalTokens"
              label="token 预算"
              hint="0 = 不限（默认）；本请求累计消耗达到预算即暂停"
            >
              <input
                class="input input-num"
                type="number"
                min="0"
                :max="MAX_LOOP_TOKENS"
                step="1000"
                :value="loop.maxTotalTokens"
                @change="
                  saveLoop({
                    maxTotalTokens: clampNumber($event, 0, MAX_LOOP_TOKENS, loop.maxTotalTokens),
                  })
                "
              />
            </SettingField>

            <SettingField
              data-field="agent.loop.autoContinueRounds"
              label="自动续轮"
              hint="0 ～ 8，默认 8；轮次用完后自动再续几轮，0 = 暂停等用户点「继续」"
            >
              <input
                class="input input-num"
                type="number"
                min="0"
                max="8"
                step="1"
                :value="loop.autoContinueRounds"
                @change="
                  saveLoop({
                    autoContinueRounds: clampNumber($event, 0, 8, loop.autoContinueRounds),
                  })
                "
              />
            </SettingField>
          </div>
        </div>
      </Transition>
    </section>

    <!-- ───────── 区组二 / 三：技能、MCP（原 SkillsPage / McpPage 迁入） ───────── -->
    <SkillsSection @notify="onNotify" />
    <McpSection @notify="onNotify" />
  </section>
</template>

<style scoped>
/* 区组内的小节：细标题 + 分隔线，代替原来的嵌套 section-card（避免卡中卡） */
.sub {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sub + .sub {
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--space-3);
}

.sub-title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
}

.wrap {
  flex-wrap: wrap;
}

.segmented {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--fill-1);
}

.segmented button {
  min-height: 28px;
  padding: 0 var(--space-3);
  border-radius: calc(var(--radius-sm) - 2px);
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--text-sm);
}

.segmented button:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.segmented button.active {
  background: var(--bg-overlay);
  color: var(--text-primary);
  box-shadow: var(--shadow-hairline);
}

/* 「免确认命令模式」：列表 + 输入行竖排；容器本身挂 data-field，探针按数量断言（见 capture.ts） */
.allow-patterns {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 去列表默认的符号与缩进：每行是「模式串 + 删除」，行距比 gap 更紧一点 */
.pattern-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>
