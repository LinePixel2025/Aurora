<script setup lang="ts">
/**
 * 电脑操控设置页（docs/06 §11、docs/08 §1）：总开关、默认工作目录、
 * 终端 / 文件 / 打开三个子开关与上限、当前生效工具预览。
 *
 * 「电脑操控」是给模型装上"手"的一组工具（run_command / read_file / write_file /
 * list_dir / open_path）：默认全开，但命令执行与文件写入是敏感工具，逐次确认后才执行。
 * 本页是这套工具的**唯一**开关面，保存后由主进程 `onSettingsChanged` →
 * `computerTools.sync()` 立即重注册，无需重启。
 *
 * 为什么每处保存都要回传**完整**的 `agent.tools` 子树：
 * `settings:update` 只做**顶层浅合并**（见 packages/shared/src/ipc/types.ts 的
 * SettingsPatch 注释），`agent` 这一层不递归补全 —— 只传 `{ terminal: {...} }` 会让
 * `files` / `open` 被整块替换掉，等于静默丢配置（capture 里已有同类回归探针，别重犯）。
 * 所以本页所有保存都走 `save(patch)`：先读当前 tree，再 `{ ...currentTools, ...patch }`；
 * 改子对象时（terminal / files）patch 里也要带**完整子对象**，否则同级的 timeoutMs 等会被丢掉。
 *
 * 为什么 workspaceDir 不是沙箱：
 * 它只是工具的**默认**工作目录（空串 = 用户主目录），模型仍可显式传入任意绝对路径。
 * 安全边界是「逐次确认 + 输出上限 + 总开关」，不是路径限制 —— 文案必须说清楚，
 * 别让用户以为填了目录就"锁住了"。
 *
 * `COMPUTER_TOOL_NAMES` 必须从 `@aurora/shared/browser` 取：主入口 `@aurora/shared`
 * 依赖 `node:fs`，一旦被拉进渲染层 bundle，Electron 构建会直接失败（AGENTS.md 架构硬约束 4）。
 */
import { computed, ref } from 'vue'
import type { AgentToolsConfig, ComputerToolName } from '@aurora/shared/browser'
import { COMPUTER_TOOL_NAMES, DEFAULT_AGENT_TOOLS } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const error = ref<string | null>(null)
const message = ref<string | null>(null)
/** 「打开工作目录」成功回执里的真实路径（主进程解析后的绝对路径） */
const openedWorkspace = ref('')

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
  list_dir: (t) => t.files.enabled,
  open_path: (t) => t.open.enabled,
}

/** 当前配置下**会注册**的工具名，顺序照 `COMPUTER_TOOL_NAMES`（即注册顺序，便于比对） */
const activeToolNames = computed<ComputerToolName[]>(() => {
  const current = tools.value
  if (!current.enabled) return []
  return COMPUTER_TOOL_NAMES.filter((name) => TOOL_GATES[name](current))
})

async function save(patch: Partial<AgentToolsConfig>): Promise<void> {
  const current = settingsStore.settings?.agent.tools
  // 未加载完就写等于用兜底默认值把已保存的配置整棵覆盖掉，宁可先不写
  if (!current) return
  const ok = await settingsStore.update({ agent: { tools: { ...current, ...patch } } })
  if (!ok) error.value = settingsStore.error
  else {
    message.value = '已保存'
    error.value = null
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
    message.value = `工作目录：${result.value}`
    error.value = null
  } else {
    error.value = result.message
  }
}
</script>

<template>
  <section class="page">
    <header>
      <h1 class="page-title">电脑操控</h1>
      <p class="page-sub">
        让模型能执行命令、读写文件与打开路径（docs/06 §11）。默认全开，但敏感工具逐次确认后才执行。
      </p>
    </header>

    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>

    <section class="section-card">
      <h2 class="section-title">总开关</h2>
      <p class="section-desc">
        关闭后模型<strong>完全看不到</strong>这 5 个工具：
        <code class="mono">run_command</code>、<code class="mono">read_file</code>、<code
          class="mono"
          >write_file</code
        >、<code class="mono">list_dir</code>、<code class="mono">open_path</code>
        —— 系统提示词与工具表里都不再出现，保存后立即生效，无需重启。
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

      <AppToast tone="warn">
        警示：若在高级页关闭了「敏感工具确认」，命令与文件写入将不经确认直接执行（docs/06 §5）。
      </AppToast>
    </section>

    <section class="section-card">
      <h2 class="section-title">工作目录</h2>
      <p class="section-desc">
        工具的<strong>默认</strong>工作目录：命令在其下执行，相对路径以此为基准。这<strong
          >不是沙箱</strong
        >
        —— 模型仍可显式传入其它路径，安全边界是「逐次确认 + 输出上限 + 总开关」。
      </p>

      <SettingField
        data-field="agent.tools.workspaceDir"
        label="默认工作目录"
        hint="留空 = 用户主目录（如 C:\Users\you）；不是沙箱，模型仍可访问其它路径"
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
    </section>

    <section class="section-card">
      <h2 class="section-title">终端</h2>
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
            class="input"
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
            class="input"
            type="number"
            min="500"
            max="100000"
            step="500"
            :value="tools.terminal.maxOutputChars"
            @change="
              saveTerminal({
                maxOutputChars: clampNumber($event, 500, 100000, tools.terminal.maxOutputChars),
              })
            "
          />
        </SettingField>
      </template>

      <p v-else class="tiny muted" data-empty="agent.tools.terminal">
        关闭总开关后终端工具不会注册：模型看不到 run_command。
      </p>
    </section>

    <section class="section-card">
      <h2 class="section-title">文件</h2>
      <p class="section-desc">
        读取 / 写入 / 列目录（<code class="mono">read_file</code>、<code class="mono"
          >write_file</code
        >、<code class="mono">list_dir</code>）：写入是敏感工具，执行前需要确认。
      </p>

      <template v-if="tools.enabled">
        <SettingField
          data-field="agent.tools.files.enabled"
          label="启用文件工具"
          hint="关闭后模型看不到 read_file / write_file / list_dir，其余工具不受影响"
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
            class="input"
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
        关闭总开关后文件工具不会注册：模型看不到 read_file / write_file / list_dir。
      </p>
    </section>

    <section class="section-card">
      <h2 class="section-title">打开</h2>
      <p class="section-desc">
        用系统默认程序打开路径（<code class="mono">open_path</code>）：敏感工具，执行前需要确认。
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
              @change="save({ open: { enabled: ($event.target as HTMLInputElement).checked } })"
            />
            <span>允许模型打开文件、目录或链接（默认开启）</span>
          </label>
        </SettingField>
      </template>

      <p v-else class="tiny muted" data-empty="agent.tools.open">
        关闭总开关后打开工具不会注册：模型看不到 open_path。
      </p>
    </section>

    <section class="section-card">
      <h2 class="section-title">当前生效工具</h2>
      <p class="section-desc">
        按当前配置实时计算：模型下一次请求的工具表就是这些（共
        {{ activeToolNames.length }} / {{ COMPUTER_TOOL_NAMES.length }} 个）。
      </p>

      <div v-if="activeToolNames.length > 0" class="row wrap">
        <code v-for="name in activeToolNames" :key="name" class="mono">{{ name }}</code>
      </div>
      <p v-else class="tiny muted">总开关已关闭：5 个电脑操控工具一个都不会注册。</p>
    </section>

    <p class="tiny muted">
      安全提示：默认工作目录只影响相对路径的基准，不是沙箱；请务必保留「敏感工具确认」，
      或至少清楚关闭它的后果。
    </p>
  </section>
</template>

<style scoped>
.wrap {
  flex-wrap: wrap;
}
</style>
