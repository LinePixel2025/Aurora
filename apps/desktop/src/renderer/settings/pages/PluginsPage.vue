<script setup lang="ts">
/**
 * 插件设置页（docs/14 §5，v36）：已安装 / 市场 / 开发 三个视图。
 *
 * 口径：
 * - **安装即信任**：插件进程持有当前用户权限，安装前把权限、工具与校验和摊开给用户看；
 *   页面文案不宣称沙箱（docs/14 §6.4）。
 * - 启停 / 信任 / 重启 / 卸载都走 `PluginManager`，本页只发 IPC 并重拉快照；
 *   `plugins:changed` 到达时同样重拉（插件崩溃、开发目录重载都会推）。
 * - 开发目录插件不复制、原地加载，启用与否由 `plugins.devDirs` 决定，因此不给单个启停按钮。
 * - 市场在 P4 接入 Center；未接入时如实显示空态，不放假数据。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type {
  PluginInstallPreview,
  PluginMarketplaceListResult,
  PluginPackageRef,
  PluginSummary,
  PluginWidgetInfo,
  PluginWidgetLayout,
} from '@aurora/shared'
import {
  Blocks,
  FolderOpen,
  ListChecks,
  Play,
  RotateCw,
  Trash2,
  Puzzle,
} from '@aurora/shared/browser'
import { PLUGIN_PERMISSION_LABELS } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import AppTooltip from '../../shared/components/AppTooltip.vue'
import SettingField from '../../shared/components/SettingField.vue'
import StatusDot from '../../shared/components/StatusDot.vue'
import PluginConfigForm from './PluginConfigForm.vue'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()

const pluginsSettings = computed(() => settingsStore.settings?.plugins ?? null)
const masterEnabled = computed(() => pluginsSettings.value?.enabled ?? true)
const devDirs = computed(() => pluginsSettings.value?.devDirs ?? [])

const installed = ref<PluginSummary[]>([])
const widgetLayout = ref<PluginWidgetLayout | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const tab = ref<'installed' | 'market' | 'dev'>('installed')

/** 安装同意数据：选包后先 `inspect`，用户确认才真正 `install` */
const preview = ref<PluginInstallPreview | null>(null)
const previewing = ref(false)
const installing = ref(false)
const confirmingUninstall = ref<string | null>(null)
const deleteData = ref(false)
/** 正在执行动作的插件 id（按钮禁用，避免连点产生并发安装/重启） */
const busy = ref<string | null>(null)
const market = ref<PluginMarketplaceListResult | null>(null)
/** 展开了配置表单的插件 id（同一时间只展开一个，避免页面无限变长） */
const expandedConfig = ref<string | null>(null)

let offChanged: (() => void) | null = null

const STATUS_TEXT: Record<PluginSummary['status'], string> = {
  disabled: '已停用',
  stopped: '待启动',
  starting: '启动中',
  ready: '运行中',
  crashed: '已崩溃',
  error: '启动失败',
}

const SOURCE_TEXT: Record<PluginSummary['source'], string> = {
  local: '本地安装',
  marketplace: '市场安装',
  dev: '开发目录',
}

function statusTone(plugin: PluginSummary): 'idle' | 'running' | 'unread' | 'error' {
  if (plugin.status === 'ready' || plugin.status === 'starting') return 'running'
  if (plugin.status === 'crashed' || plugin.status === 'error') return 'error'
  return 'idle'
}

function fail(message: string): void {
  error.value = message
  notice.value = null
}

function succeed(message: string): void {
  notice.value = message
  error.value = null
}

async function refresh(): Promise<void> {
  const result = await window.aurora.plugins.list()
  if (result.ok) installed.value = result.value
  else fail(result.message)
  const layout = await window.aurora.plugins.widgetLayout()
  if (layout.ok) widgetLayout.value = layout.value
  loading.value = false
}

/** 桌面小组件是否显示（布局文件缺失时按默认可见处理）。 */
function widgetVisible(widget: PluginWidgetInfo): boolean {
  const entry = widgetLayout.value?.widgets[`${widget.pluginId}/${widget.id}`]
  return entry?.visible ?? true
}

async function toggleWidgetVisible(plugin: PluginSummary, widget: PluginWidgetInfo): Promise<void> {
  busy.value = plugin.id
  try {
    const result = await window.aurora.plugins.setWidgetVisible({
      pluginId: widget.pluginId,
      widgetId: widget.id,
      visible: !widgetVisible(widget),
    })
    if (!result.ok) fail(result.message)
    await refresh()
  } finally {
    busy.value = null
  }
}

async function loadMarket(): Promise<void> {
  const result = await window.aurora.plugins.marketplaceList()
  market.value = result.ok ? result.value : { serverUrl: '', entries: [], error: result.message }
}

/** 从市场安装 / 更新（主进程下载并校验 sha256 后才交给安装器） */
async function installFromMarket(entry: {
  id: string
  name: string
  latestVersion: string
}): Promise<void> {
  busy.value = entry.id
  error.value = null
  notice.value = null
  try {
    const result = await window.aurora.plugins.marketplaceInstall({ pluginId: entry.id })
    if (!result.ok) {
      fail(result.message)
      return
    }
    succeed(`已${result.value.version === entry.latestVersion ? '安装' : '更新'} ${entry.name}`)
    await Promise.all([refresh(), loadMarket()])
  } finally {
    busy.value = null
  }
}

async function pickPackage(): Promise<void> {
  previewing.value = true
  error.value = null
  notice.value = null
  try {
    const picked = await window.aurora.plugins.choosePackage()
    if (!picked.ok) {
      fail(picked.message)
      return
    }
    if (picked.value === null) return
    const inspected = await window.aurora.plugins.inspect({ kind: 'file', path: picked.value })
    if (!inspected.ok) {
      fail(inspected.message)
      return
    }
    preview.value = inspected.value
  } finally {
    previewing.value = false
  }
}

async function installPreview(): Promise<void> {
  const current = preview.value
  if (current === null) return
  installing.value = true
  error.value = null
  try {
    const ref: PluginPackageRef = { kind: 'file', path: current.sourcePath }
    const result = await window.aurora.plugins.install(ref)
    if (!result.ok) {
      fail(result.message)
      return
    }
    preview.value = null
    succeed(`已安装 ${result.value.name} ${result.value.version}`)
    await refresh()
  } finally {
    installing.value = false
  }
}

async function setMasterEnabled(enabled: boolean): Promise<void> {
  const current = pluginsSettings.value
  if (current === null) return
  const ok = await settingsStore.update({ plugins: { ...current, enabled } })
  if (!ok) fail(settingsStore.error ?? '保存失败')
}

async function toggleEnabled(plugin: PluginSummary): Promise<void> {
  busy.value = plugin.id
  try {
    const result = await window.aurora.plugins.setEnabled({
      pluginId: plugin.id,
      enabled: !plugin.enabled,
    })
    if (!result.ok) fail(result.message)
    await refresh()
  } finally {
    busy.value = null
  }
}

async function toggleTrusted(plugin: PluginSummary): Promise<void> {
  busy.value = plugin.id
  try {
    const result = await window.aurora.plugins.setTrusted({
      pluginId: plugin.id,
      trusted: !plugin.trusted,
    })
    if (!result.ok) fail(result.message)
    await refresh()
  } finally {
    busy.value = null
  }
}

async function restart(plugin: PluginSummary): Promise<void> {
  busy.value = plugin.id
  try {
    const result = await window.aurora.plugins.restart({ pluginId: plugin.id })
    if (!result.ok) fail(result.message)
    await refresh()
  } finally {
    busy.value = null
  }
}

async function rollback(plugin: PluginSummary): Promise<void> {
  busy.value = plugin.id
  try {
    const result = await window.aurora.plugins.rollback({ pluginId: plugin.id })
    if (!result.ok) fail(result.message)
    else succeed(`已回滚到 ${result.value.version}`)
    await refresh()
  } finally {
    busy.value = null
  }
}

/** 可选的插件主题（只统计启用中的插件；禁用后主题自动从候选里消失） */
const pluginThemes = computed(() =>
  installed.value
    .filter((plugin) => plugin.enabled && plugin.status !== 'disabled')
    .flatMap((plugin) =>
      plugin.themes.map((theme) => ({
        ...theme,
        key: `${theme.pluginId}:${theme.id}`,
        label: `${plugin.name} · ${theme.name}`,
      })),
    ),
)

const activeThemeKey = computed(() => {
  const active = pluginsSettings.value?.activeTheme
  if (active === undefined || active.pluginId === '') return ''
  return `${active.pluginId}:${active.themeId}`
})

async function setTheme(key: string): Promise<void> {
  const current = pluginsSettings.value
  if (current === null) return
  const [pluginId = '', themeId = ''] = key.split(':')
  const ok = await settingsStore.update({
    plugins: { ...current, activeTheme: { pluginId, themeId } },
  })
  if (!ok) fail(settingsStore.error ?? '保存失败')
}

function toggleConfig(plugin: PluginSummary): void {
  expandedConfig.value = expandedConfig.value === plugin.id ? null : plugin.id
}

function askUninstall(plugin: PluginSummary): void {
  confirmingUninstall.value = plugin.id
  deleteData.value = false
}

async function uninstall(plugin: PluginSummary): Promise<void> {
  busy.value = plugin.id
  try {
    const result = await window.aurora.plugins.uninstall({
      pluginId: plugin.id,
      deleteData: deleteData.value,
    })
    if (!result.ok) {
      fail(result.message)
      return
    }
    confirmingUninstall.value = null
    succeed(`已卸载 ${plugin.name}`)
    await refresh()
  } finally {
    busy.value = null
  }
}

async function openFolder(plugin: PluginSummary): Promise<void> {
  const result = await window.aurora.plugins.openFolder({ pluginId: plugin.id })
  if (!result.ok) fail(result.message)
}

async function openLog(plugin: PluginSummary): Promise<void> {
  const result = await window.aurora.plugins.openLog({ pluginId: plugin.id })
  if (!result.ok) fail(result.message)
}

async function addDevDir(): Promise<void> {
  const current = pluginsSettings.value
  if (current === null) return
  if (current.devDirs.length >= 8) {
    fail('开发目录最多 8 个，请先移除不用的目录')
    return
  }
  const picked = await window.aurora.plugins.chooseDir()
  if (!picked.ok) {
    fail(picked.message)
    return
  }
  if (picked.value === null) return
  const dir = picked.value
  if (current.devDirs.includes(dir)) {
    fail('该目录已在开发目录列表中')
    return
  }
  const ok = await settingsStore.update({
    plugins: { ...current, devDirs: [...current.devDirs, dir] },
  })
  if (ok) succeed('已添加开发目录，插件将在加载成功后出现')
  else fail(settingsStore.error ?? '保存失败')
}

async function removeDevDir(dir: string): Promise<void> {
  const current = pluginsSettings.value
  if (current === null) return
  const ok = await settingsStore.update({
    plugins: { ...current, devDirs: current.devDirs.filter((item) => item !== dir) },
  })
  if (ok) succeed('已移除开发目录')
  else fail(settingsStore.error ?? '保存失败')
}

onMounted(() => {
  loading.value = true
  void refresh()
  void loadMarket()
  offChanged = window.aurora.plugins.onChanged(() => void refresh())})

onUnmounted(() => {
  offChanged?.()
  offChanged = null
})
</script>

<template>
  <section class="page page-plugins">
    <header>
      <h1 class="page-title">插件</h1>
      <p class="page-sub">扩展 Agent 能力与界面；插件以你的用户权限运行。</p>
    </header>

    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-else-if="notice" tone="ok">{{ notice }}</AppToast>

    <div class="tabs" role="tablist" aria-label="插件视图">
      <button
        type="button"
        role="tab"
        class="tab"
        data-field="plugins.tab-installed"
        :class="{ active: tab === 'installed' }"
        :aria-selected="tab === 'installed'"
        @click="tab = 'installed'"
      >
        已安装
        <span v-if="installed.length > 0" class="tab-count">{{ installed.length }}</span>
      </button>
      <button
        type="button"
        role="tab"
        class="tab"
        data-field="plugins.tab-market"
        :class="{ active: tab === 'market' }"
        :aria-selected="tab === 'market'"
        @click="tab = 'market'"
      >
        市场
      </button>
      <button
        type="button"
        role="tab"
        class="tab"
        data-field="plugins.tab-dev"
        :class="{ active: tab === 'dev' }"
        :aria-selected="tab === 'dev'"
        @click="tab = 'dev'"
      >
        开发
      </button>
    </div>

    <!-- ───────── 已安装 ───────── -->
    <template v-if="tab === 'installed'">
      <section class="section-card">
        <SettingField
          data-field="plugins.enabled"
          label="启用插件"
          hint="关闭后所有插件进程停止，工具、命令与面板都不再加载"
        >
          <label class="check-row">
            <input
              type="checkbox"
              :checked="masterEnabled"
              @change="setMasterEnabled(($event.target as HTMLInputElement).checked)"
            />
            <span>允许插件运行（安装与信任状态会保留）</span>
          </label>
        </SettingField>
      </section>

      <section v-if="pluginThemes.length > 0" class="section-card">
        <SettingField
          data-field="plugins.activeTheme"
          label="插件主题"
          hint="只覆盖表面、文字、边框与圆角，强调色与毛玻璃仍由外观设置决定"
        >
          <select
            :value="activeThemeKey"
            @change="setTheme(($event.target as HTMLSelectElement).value)"
          >
            <option value="">默认（跟随外观）</option>
            <option v-for="theme in pluginThemes" :key="theme.key" :value="theme.key">
              {{ theme.label }}
            </option>
          </select>
        </SettingField>
      </section>

      <!-- 安装同意：选包后的 inspect 结果，确认前不落盘 -->
      <section v-if="preview" class="section-card accent">
        <h2 class="section-title">安装确认</h2>
        <p class="section-desc">
          插件代码将以你的用户权限运行，可读写本机文件与网络；只安装你信任来源的插件。
        </p>
        <dl class="kv">
          <dt>名称</dt>
          <dd>
            {{ preview.name }} <span class="muted">{{ preview.version }}</span>
          </dd>
          <dt>标识</dt>
          <dd class="mono">{{ preview.id }}</dd>
          <dt>作者</dt>
          <dd>{{ preview.author }}</dd>
          <dt>大小</dt>
          <dd>{{ Math.ceil(preview.sizeBytes / 1024) }} KB</dd>
          <dt>SHA-256</dt>
          <dd class="mono checksum">{{ preview.checksum }}</dd>
          <template v-if="preview.replaces">
            <dt>替换版本</dt>
            <dd>{{ preview.replaces.version }}</dd>
          </template>
        </dl>

        <div v-if="preview.permissions.length > 0" class="perm-block">
          <p class="block-label">申请权限</p>
          <ul class="perm-list">
            <li v-for="permission in preview.permissions" :key="permission">
              <AppTooltip :text="PLUGIN_PERMISSION_LABELS[permission]">
                <span class="perm-chip mono">{{ permission }}</span>
              </AppTooltip>
              <span class="perm-desc">{{ PLUGIN_PERMISSION_LABELS[permission] }}</span>
            </li>
          </ul>
        </div>

        <div v-if="preview.tools.length > 0" class="perm-block">
          <p class="block-label">提供的工具</p>
          <ul class="plain-list">
            <li v-for="tool in preview.tools" :key="tool.name">
              <span class="mono">{{ tool.fullName }}</span>
              <span class="muted">
                · {{ tool.sensitivity === 'safe' ? '可免确认（信任后）' : '每次调用需确认' }}
              </span>
            </li>
          </ul>
        </div>

        <div v-if="preview.warnings.length > 0" class="perm-block">
          <p class="block-label">提醒</p>
          <ul class="plain-list warning">
            <li v-for="(warning, index) in preview.warnings" :key="index">{{ warning }}</li>
          </ul>
        </div>

        <div v-if="preview.conflicts.length > 0" class="perm-block">
          <p class="block-label">冲突（需先处理）</p>
          <ul class="plain-list warning">
            <li v-for="(conflict, index) in preview.conflicts" :key="index">{{ conflict }}</li>
          </ul>
        </div>

        <div class="row actions">
          <AppButton
            variant="primary"
            size="sm"
            :disabled="installing || preview.conflicts.length > 0"
            @click="installPreview"
          >
            {{ installing ? '安装中…' : '安装' }}
          </AppButton>
          <AppButton variant="ghost" size="sm" :disabled="installing" @click="preview = null">
            取消
          </AppButton>
        </div>
      </section>

      <section class="section-card">
        <div class="row list-head">
          <h2 class="section-title">已安装插件</h2>
          <div class="row">
            <AppButton size="sm" :disabled="previewing" @click="pickPackage">
              {{ previewing ? '读取中…' : '安装插件包' }}
            </AppButton>
          </div>
        </div>

        <div v-if="loading" class="empty-state">
          <p class="muted">正在读取插件列表…</p>
        </div>

        <div v-else-if="installed.length === 0" class="empty-state">
          <Blocks :size="22" :stroke-width="1.5" aria-hidden="true" />
          <p class="muted">
            尚未安装插件。可安装本地 .zip / .aurora-plugin 包，或在「开发」页加载目录。
          </p>
        </div>

        <template v-else>
          <article v-for="plugin in installed" :key="plugin.id" class="plugin-item">
            <div class="plugin-head">
              <div class="plugin-title">
                <h3>{{ plugin.name }}</h3>
                <span class="mono muted">{{ plugin.version }}</span>
                <span class="badge">{{ SOURCE_TEXT[plugin.source] }}</span>
                <StatusDot :tone="statusTone(plugin)" :title="STATUS_TEXT[plugin.status]" />
                <span class="tiny muted">{{ STATUS_TEXT[plugin.status] }}</span>
              </div>
              <div class="row plugin-actions">
                <AppButton
                  v-if="!plugin.isDev"
                  size="sm"
                  variant="ghost"
                  :disabled="busy === plugin.id"
                  @click="toggleEnabled(plugin)"
                >
                  {{ plugin.enabled ? '停用' : '启用' }}
                </AppButton>
                <AppButton
                  size="sm"
                  variant="ghost"
                  :disabled="busy === plugin.id || (plugin.isDev ? false : !plugin.enabled)"
                  @click="restart(plugin)"
                >
                  <RotateCw :size="13" :stroke-width="1.8" aria-hidden="true" />
                  重启
                </AppButton>
                <AppButton
                  v-if="plugin.previousVersion !== undefined"
                  size="sm"
                  variant="ghost"
                  :disabled="busy === plugin.id"
                  @click="rollback(plugin)"
                >
                  回滚到 {{ plugin.previousVersion }}
                </AppButton>
                <AppTooltip text="打开插件目录">
                  <button type="button" class="icon-btn" @click="openFolder(plugin)">
                    <FolderOpen :size="14" :stroke-width="1.7" aria-hidden="true" />
                  </button>
                </AppTooltip>
                <AppTooltip text="打开插件日志">
                  <button type="button" class="icon-btn" @click="openLog(plugin)">
                    <ListChecks :size="14" :stroke-width="1.7" aria-hidden="true" />
                  </button>
                </AppTooltip>
                <AppButton
                  v-if="!plugin.isDev"
                  size="sm"
                  variant="danger"
                  :disabled="busy === plugin.id"
                  @click="askUninstall(plugin)"
                >
                  <Trash2 :size="13" :stroke-width="1.8" aria-hidden="true" />
                  卸载
                </AppButton>
              </div>
            </div>

            <p v-if="plugin.description" class="plugin-desc">{{ plugin.description }}</p>
            <p v-if="plugin.lastError" class="plugin-error">{{ plugin.lastError }}</p>

            <div class="meta-grid">
              <p class="meta">
                <span class="block-label">作者</span>
                <span>{{ plugin.author }}</span>
              </p>
              <p class="meta">
                <span class="block-label">工具</span>
                <span>{{ plugin.tools.length }} 个</span>
              </p>
              <p class="meta">
                <span class="block-label">命令</span>
                <span>{{ plugin.commands.length }} 个</span>
              </p>
              <p class="meta">
                <span class="block-label">面板</span>
                <span>{{ plugin.panels.length }} 个</span>
              </p>
              <p class="meta">
                <span class="block-label">小组件</span>
                <span>{{ plugin.widgets.length }} 个</span>
              </p>
            </div>

            <div v-if="plugin.permissions.length > 0" class="perm-chips">
              <AppTooltip
                v-for="permission in plugin.permissions"
                :key="permission"
                :text="PLUGIN_PERMISSION_LABELS[permission]"
              >
                <span class="perm-chip mono">{{ permission }}</span>
              </AppTooltip>
            </div>

            <div
              v-if="
                plugin.panels.length > 0 ||
                plugin.commands.length > 0 ||
                plugin.widgets.length > 0
              "
              class="contrib-block"
            >
              <p class="block-label">扩展点</p>
              <ul class="plain-list">
                <li v-for="panel in plugin.panels" :key="`panel-${panel.id}`">
                  面板 · {{ panel.title }}
                  <span class="muted">（{{ panel.kind === 'page' ? '页面' : '声明式' }}）</span>
                </li>
                <li v-for="command in plugin.commands" :key="`cmd-${command.name}`">
                  命令 · <span class="mono">/{{ command.name }}</span>
                  <span class="muted">{{ command.title }}</span>
                </li>
                <li v-for="widget in plugin.widgets" :key="`widget-${widget.id}`">
                  小组件 · {{ widget.title }}
                  <span class="muted">
                    （{{ widget.slot === 'desktop' ? '桌面' : '提示条' }} ·
                    {{ widget.kind === 'page' ? '页面' : '声明式' }}）
                  </span>
                </li>
              </ul>
            </div>

            <div
              v-if="plugin.widgets.some((widget) => widget.slot === 'desktop')"
              class="contrib-block"
            >
              <p class="block-label">桌面小组件</p>
              <label
                v-for="widget in plugin.widgets.filter((item) => item.slot === 'desktop')"
                :key="`widget-visible-${widget.id}`"
                class="check-row"
                :data-field="`plugins.widget-visible.${widget.id}`"
              >
                <input
                  type="checkbox"
                  :checked="widgetVisible(widget)"
                  :disabled="busy === plugin.id || !plugin.enabled"
                  @change="toggleWidgetVisible(plugin, widget)"
                />
                <span>显示在桌面 · {{ widget.title }}</span>
              </label>
            </div>

            <div v-if="plugin.configFields.length > 0" class="config-block">
              <div class="row list-head">
                <p class="block-label">插件配置</p>
                <AppButton size="sm" variant="ghost" @click="toggleConfig(plugin)">
                  {{ expandedConfig === plugin.id ? '收起' : '编辑配置' }}
                </AppButton>
              </div>
              <PluginConfigForm
                v-if="expandedConfig === plugin.id"
                :plugin-id="plugin.id"
                :fields="plugin.configFields"
              />
            </div>

            <label v-if="!plugin.isDev" class="check-row trust-row">
              <input
                type="checkbox"
                :checked="plugin.trusted"
                :disabled="busy === plugin.id"
                @change="toggleTrusted(plugin)"
              />
              <span> 信任此插件：清单声明为安全的工具将免确认，其余工具仍需每次确认 </span>
            </label>

            <div v-if="confirmingUninstall === plugin.id" class="uninstall-confirm">
              <p class="tiny">卸载后插件目录会被删除，插件数据默认保留。</p>
              <label class="check-row">
                <input v-model="deleteData" type="checkbox" />
                <span>同时删除插件数据与配置</span>
              </label>
              <div class="row">
                <AppButton
                  variant="danger"
                  size="sm"
                  :disabled="busy === plugin.id"
                  @click="uninstall(plugin)"
                >
                  确认卸载
                </AppButton>
                <AppButton size="sm" variant="ghost" @click="confirmingUninstall = null">
                  取消
                </AppButton>
              </div>
            </div>
          </article>
        </template>
      </section>
    </template>

    <!-- ───────── 市场 ───────── -->
    <section v-else-if="tab === 'market'" class="section-card">
      <div class="row list-head">
        <h2 class="section-title">插件市场</h2>
        <AppButton size="sm" variant="ghost" @click="loadMarket">刷新</AppButton>
      </div>
      <div v-if="market?.error" class="empty-state">
        <Puzzle :size="22" :stroke-width="1.5" aria-hidden="true" />
        <p class="muted">{{ market.error }}</p>
        <p v-if="market.serverUrl" class="tiny muted">当前 Center：{{ market.serverUrl }}</p>
      </div>
      <div v-else-if="(market?.entries.length ?? 0) === 0" class="empty-state">
        <Puzzle :size="22" :stroke-width="1.5" aria-hidden="true" />
        <p class="muted">市场暂无插件。</p>
      </div>
      <template v-else>
        <article v-for="entry in market?.entries ?? []" :key="entry.id" class="plugin-item">
          <div class="plugin-head">
            <div class="plugin-title">
              <h3>{{ entry.name }}</h3>
              <span class="mono muted">{{ entry.latestVersion }}</span>
              <span v-if="entry.updateAvailable" class="badge accent-badge">有更新</span>
              <span v-else-if="entry.installedVersion" class="badge">已安装</span>
            </div>
            <div class="row">
              <AppButton
                size="sm"
                :variant="entry.updateAvailable ? 'primary' : 'ghost'"
                :disabled="
                  busy === entry.id ||
                  (entry.installedVersion !== undefined && !entry.updateAvailable)
                "
                @click="installFromMarket(entry)"
              >
                {{
                  entry.installedVersion === undefined
                    ? '安装'
                    : entry.updateAvailable
                      ? '更新'
                      : '已安装'
                }}
              </AppButton>
            </div>
          </div>
          <p class="plugin-desc">{{ entry.summary }}</p>
          <p class="tiny muted">
            作者 {{ entry.author }} · 下载 {{ entry.downloads }}
            <template v-if="entry.installedVersion"> · 本机 {{ entry.installedVersion }}</template>
          </p>
        </article>
      </template>
    </section>

    <!-- ───────── 开发 ───────── -->
    <section v-else class="section-card">
      <div class="row list-head">
        <h2 class="section-title">开发目录</h2>
        <AppButton size="sm" :disabled="devDirs.length >= 8" @click="addDevDir">
          添加目录
        </AppButton>
      </div>
      <p class="section-desc">目录中的插件原地加载，修改文件后自动重启；最多 8 个目录。</p>

      <div v-if="devDirs.length === 0" class="empty-state">
        <Play :size="22" :stroke-width="1.5" aria-hidden="true" />
        <p class="muted">尚未添加开发目录。</p>
      </div>

      <template v-else>
        <div v-for="dir in devDirs" :key="dir" class="dev-row">
          <span class="mono dev-path" :title="dir">{{ dir }}</span>
          <AppButton size="sm" variant="ghost" @click="removeDevDir(dir)">移除</AppButton>
        </div>
      </template>

      <p v-if="installed.some((plugin) => plugin.isDev)" class="section-desc">
        已加载的开发插件：{{
          installed
            .filter((plugin) => plugin.isDev)
            .map((plugin) => plugin.name)
            .join('、')
        }}
      </p>
    </section>
  </section>
</template>

<style scoped>
.page-plugins {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.tabs {
  display: flex;
  gap: var(--space-1);
  padding: 3px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--glass-border-soft);
  background: var(--glass-surface);
  width: fit-content;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.tab:hover {
  color: var(--text-primary);
}

.tab.active {
  background: var(--fill-3);
  color: var(--text-primary);
}

.tab-count {
  min-width: 16px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  font-size: var(--text-xs);
  text-align: center;
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.list-head {
  justify-content: space-between;
}

.check-row {
  display: inline-flex;
  align-items: flex-start;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}

.check-row input {
  margin-top: 2px;
  accent-color: var(--aurora-blue);
}

.empty-state {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-5);
  border: 1px dashed var(--border-subtle);
  border-radius: var(--radius-md);
  color: var(--text-muted);
}

.empty-state p {
  margin: 0;
}

.plugin-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

.plugin-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.plugin-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  min-width: 0;
}

.plugin-title h3 {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
}

.plugin-actions {
  gap: var(--space-1);
}

.plugin-desc {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.plugin-error {
  margin: 0;
  color: var(--error-text);
  font-size: var(--text-sm);
}

.badge {
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.accent-badge {
  border-color: var(--aurora-blue);
  color: var(--aurora-blue);
}

.meta-grid {
  display: flex;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.block-label {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-eyebrow);
  text-transform: uppercase;
}

.perm-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.perm-list,
.plain-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.perm-list li {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.plain-list.warning {
  color: var(--warning-text);
}

.perm-desc {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.perm-chips {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.perm-chip {
  display: inline-block;
  padding: 1px 7px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-subtle);
  background: var(--fill-2);
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.kv {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 4px var(--space-3);
  margin: 0;
  font-size: var(--text-sm);
}

.kv dt {
  color: var(--text-muted);
}

.kv dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.checksum {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.mono {
  font-family: var(--font-mono);
}

.trust-row {
  padding-top: var(--space-1);
  border-top: 1px solid var(--border-subtle);
}

.uninstall-confirm {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--danger-border);
  background: var(--error-fill);
}

.uninstall-confirm p {
  margin: 0;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.icon-btn:hover {
  color: var(--text-primary);
  background: var(--fill-2);
}

.dev-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
}

.dev-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.config-block,
.contrib-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px dashed var(--border-subtle);
}

.section-card select {
  padding: 5px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--text-sm);
}
</style>
