<script setup lang="ts">
/**
 * 智能与工具设置页（docs/06 §11、docs/08 §1，BetaV2 六页 IA）：
 * 「电脑操控工具」「技能」「MCP 服务器」三个可折叠区组同页（spec §9）。
 *
 * 2026-09 信息架构收拢（docs/07 §2.5）：工具组默认展开、技能 / MCP 默认收起
 * （组头摘要承载状态，capture 探针先展开再计数）；安全告诫只在本组说明里完整表述一次；
 * 技能 / MCP 区组的操作回执经 `notify` 事件上抛，由本页唯一的 AppToast 统一渲染。
 *
 * 「电脑操控」是给模型装上"手"的一组工具（`COMPUTER_TOOL_NAMES` 里那 8 个：run_command /
 * read_file / write_file / edit_file / list_dir / open_path / grep / glob）：默认全开，
 * 但命令执行与文件写入（含 edit_file）是敏感工具，逐次确认后才执行。
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
 * 为什么 workspaceDir 不是沙箱（这条与页内安全文案同源，改文案别只改一处）：
 * 它只是工具的**默认**工作目录（空串 = 用户主目录），模型仍可显式传入任意绝对路径。
 * 安全边界是「逐次确认 + 输出上限 + 总开关」，不是路径限制。
 *
 * `COMPUTER_TOOL_NAMES` 必须从 `@aurora/shared/browser` 取：主入口 `@aurora/shared`
 * 依赖 `node:fs`，一旦被拉进渲染层 bundle，Electron 构建会直接失败（AGENTS.md 架构硬约束 4）。
 */
import { computed, ref } from 'vue'
import { ChevronRight } from '../../shared/icons.js'
import type { AgentToolsConfig, ComputerToolName } from '@aurora/shared/browser'
import { COMPUTER_TOOL_NAMES, DEFAULT_AGENT_TOOLS } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
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
 * 每个工具名的门控，与主进程 `registerComputerTools()` 的注册条件一一对应：
 * 总开关关 → 一个都不注册；否则看各自的子开关。
 */
const TOOL_GATES: Record<ComputerToolName, (t: AgentToolsConfig) => boolean> = {
  run_command: (t) => t.terminal.enabled,
  read_file: (t) => t.files.enabled,
  write_file: (t) => t.files.enabled,
  edit_file: (t) => t.files.enabled,
  list_dir: (t) => t.files.enabled,
  open_path: (t) => t.open.enabled,
  // 文件检索（grep / glob）归 v12 新增的 `agent.tools.search` 开关，与 files 分开
  grep: (t) => t.search.enabled,
  glob: (t) => t.search.enabled,
}

/** 当前配置下**会注册**的工具名，顺序照 `COMPUTER_TOOL_NAMES`（即注册顺序，便于比对） */
const activeToolNames = computed<ComputerToolName[]>(() => {
  const current = tools.value
  if (!current.enabled) return []
  return COMPUTER_TOOL_NAMES.filter((name) => TOOL_GATES[name](current))
})

/** 区组头部摘要：收起时也能看出工具的启停状态 */
const toolsSummary = computed(() =>
  tools.value.enabled
    ? `${activeToolNames.value.length} / ${COMPUTER_TOOL_NAMES.length} 个工具生效`
    : '已停用',
)

async function save(patch: Partial<AgentToolsConfig>): Promise<void> {
  const current = settingsStore.settings?.agent.tools
  // 未加载完就写等于用兜底默认值把已保存的配置整棵覆盖掉，宁可先不写
  if (!current) return
  const ok = await settingsStore.update({ agent: { tools: { ...current, ...patch } } })
  if (!ok) {
    if (settingsStore.error) showToast('error', settingsStore.error)
  } else {
    showToast('ok', '已保存')
  }
}

/** 改终端子对象：patch 里带完整 terminal 子树，避免丢掉 timeoutMs / maxOutputChars */
async function saveTerminal(patch: Partial<AgentToolsConfig['terminal']>): Promise<void> {
  await save({ terminal: { ...tools.value.terminal, ...patch } })
}

/** 改文件子对象：同上，带完整 files 子树 */
async function saveFiles(patch: Partial<AgentToolsConfig['files']>): Promise<void> {
  await save({ files: { ...tools.value.files, ...patch } })
}

/** 改文件检索子对象：同上，带完整 search 子树（否则 maxResults 与 enabled 会互相丢） */
async function saveSearch(patch: Partial<AgentToolsConfig['search']>): Promise<void> {
  await save({ search: { ...tools.value.search, ...patch } })
}

/** 数字输入解析：非数字回落原值，越界夹到 Schema 的 min/max（主进程还会再校验一次） */
function clampNumber(event: Event, min: number, max: number, fallback: number): number {
  const raw = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.round(raw)))
}

/** 打开工作目录：主进程按当前 `workspaceDir`（空串回落用户主目录）解析出真实路径 */
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
      <h1 class="page-title">智能与工具</h1>
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
            直接影响真实系统 + 敏感工具逐次确认 + 工作目录不是沙箱，都在这里说清。
          -->
          <p class="section-desc">
            让模型能执行命令、读写文件与打开路径（docs/06 §11）。
            <strong>本页操作直接影响真实系统</strong
            >：命令执行与文件写入是敏感工具，逐次确认后才执行
            （确认开关在「系统」页，关闭后将不经确认直接执行）；工作目录<strong>不是沙箱</strong>
            —— 模型仍可显式传入其它路径，安全边界是「逐次确认 + 输出上限 + 总开关」。
          </p>

          <!-- 总开关 -->
          <div class="sub">
            <h3 class="sub-title">总开关</h3>
            <!--
              数量与名字都从 `COMPUTER_TOOL_NAMES` 派生（不写死）：加工具时自动跟上，
              否则会出现「文案说 5 个、实际注册 8 个」这类只在下次加工具时才暴露的偏差。
            -->
            <p class="section-desc">
              关闭后模型<strong>完全看不到</strong>这 {{ COMPUTER_TOOL_NAMES.length }} 个工具（<code
                class="mono"
                >{{ COMPUTER_TOOL_NAMES.join('、') }}</code
              >）—— 系统提示词与工具表里都不再出现，保存后立即生效，无需重启。
            </p>

            <SettingField
              data-field="agent.tools.enabled"
              label="启用电脑操控"
              hint="关掉是最彻底的「刹车」：工具根本不注册，模型无从请求（默认开启）"
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
              <strong>命令</strong
              >的缺省工作目录：执行命令时若未显式指定路径，就在它下面运行。文件类工具（读 / 写 /
              列目录）不读此项，它们的相对路径按应用自身目录解析，因此只适合用绝对路径。
            </p>

            <SettingField
              data-field="agent.tools.workspaceDir"
              label="默认工作目录"
              hint="留空 = 用户主目录（如 C:\Users\you）；只作用于命令的缺省 cwd"
            >
              <input
                class="input"
                type="text"
                spellcheck="false"
                placeholder="留空 = 用户主目录，例如 D:\Projects"
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
              执行命令（<code class="mono">run_command</code
              >）：敏感工具，执行前需要确认；超时到点即杀进程。
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
                hint="单位毫秒，1000 ～ 300000；超时后强制结束进程并回传已捕获的输出（默认 60000）"
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
                hint="单位字符，500 ～ 100000；超出部分截断，避免一次命令灌爆上下文（默认 8000）"
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

          <!-- 文件 -->
          <div class="sub">
            <h3 class="sub-title">文件</h3>
            <p class="section-desc">
              读取 / 写入 / 精确替换 / 列目录（<code class="mono">read_file</code>、<code
                class="mono"
                >write_file</code
              >、<code class="mono">edit_file</code>、<code class="mono">list_dir</code>）：
              写入与替换是敏感工具，执行前需要确认。
            </p>

            <template v-if="tools.enabled">
              <SettingField
                data-field="agent.tools.files.enabled"
                label="启用文件工具"
                hint="关闭后模型看不到 read_file / write_file / edit_file / list_dir，其余工具不受影响"
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
                hint="单位字节，1024 ～ 4194304；超出即拒绝并提示用分段读取（默认 262144 = 256 KiB）"
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

          <!-- 文件检索 -->
          <div class="sub">
            <h3 class="sub-title">文件检索</h3>
            <p class="section-desc">
              按文件名模式或正则内容检索（<code class="mono">grep</code>、<code class="mono"
                >glob</code
              >）：<strong>只读</strong>工具（不弹确认），但它们会递归扫描整个搜索目录（自动跳过
              <code class="mono">node_modules</code> / <code class="mono">.git</code> 等）——
              只读不等于无开销。搜索根缺省用上面的「工作目录」（留空 = 用户主目录）。
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
                hint="1 ～ 1000；单次检索的结果上限（grep 按命中行、glob 按文件计），超出即截断并标注（默认 200）"
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
              用系统默认程序打开路径（<code class="mono">open_path</code
              >）：敏感工具，执行前需要确认。
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
                    @change="
                      save({ open: { enabled: ($event.target as HTMLInputElement).checked } })
                    "
                  />
                  <span>允许模型打开文件、目录或链接（默认开启）</span>
                </label>
              </SettingField>
            </template>

            <p v-else class="tiny muted" data-empty="agent.tools.open">
              关闭总开关后打开工具不会注册：模型看不到 open_path。
            </p>
          </div>

          <!-- 当前生效工具 -->
          <div class="sub">
            <h3 class="sub-title">当前生效工具</h3>
            <p class="section-desc">
              按当前配置实时计算：模型下一次请求的工具表就是这些（共
              {{ activeToolNames.length }} / {{ COMPUTER_TOOL_NAMES.length }} 个）。
            </p>

            <div v-if="activeToolNames.length > 0" class="row wrap">
              <code v-for="name in activeToolNames" :key="name" class="mono">{{ name }}</code>
            </div>
            <p v-else class="tiny muted">
              总开关已关闭：{{ COMPUTER_TOOL_NAMES.length }} 个电脑操控工具一个都不会注册。
            </p>
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
</style>
