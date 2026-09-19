<script setup lang="ts">
/**
 * 常规设置页（docs/08 §1/§6）：启动、提示条、系统感知、关于与更新。
 *
 * `general.language` 是**没有 i18n 消费方的死字段**（docs/08 §1）：
 * 本页不再提供任何入口，但保存时仍原样回传当前值 —— `settings:update` 是
 * 顶层分组浅合并，`general` 整对象被替换，漏掉 language 会被 Schema 默认值重置。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { HotkeyStatus } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import {
  usePerceptionStore,
  useSettingsStore,
  useUpdateStore,
  useWindowStore,
} from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const windowStore = useWindowStore()
const perception = usePerceptionStore()
const update = useUpdateStore()

let detachUpdate: (() => void) | null = null
onUnmounted(() => {
  detachUpdate?.()
  detachUpdate = null
  detachHotkey?.()
  detachHotkey = null
})

/** 更新状态 → 用户可读文案（docs/09 §5） */
const updateLabel = computed(() => {
  const state = update.state
  if (!state) return '正在读取…'
  switch (state.status) {
    case 'disabled':
      return '当前为开发模式 / 未打包运行，自动更新不可用'
    case 'idle':
      return '尚未检查'
    case 'checking':
      return '正在检查更新…'
    case 'up-to-date':
      return `已是最新版本（v${state.currentVersion}）`
    case 'available':
      return `发现新版本 v${state.availableVersion ?? ''}（当前 v${state.currentVersion}）`
    case 'downloading':
      return `正在下载 v${state.availableVersion ?? ''}（${state.progressPercent ?? 0}%）`
    case 'downloaded':
      return `v${state.availableVersion ?? ''} 已下载，重启后安装`
    case 'error':
      return state.error ?? '检查更新失败'
    default:
      return ''
  }
})

const updateTone = computed<'ok' | 'error' | 'info'>(() => {
  const status = update.state?.status
  if (status === 'error') return 'error'
  if (status === 'available' || status === 'downloaded') return 'ok'
  return 'info'
})

const general = computed(() => settingsStore.settings?.general ?? null)
const launchAtLogin = ref(general.value?.launchAtLogin ?? false)
const hotkey = ref(general.value?.hotkey ?? 'Alt+Space')
const edgeEnabled = ref(general.value?.edgeBar.enabled ?? true)
const edgeOpacity = ref(general.value?.edgeBar.opacity ?? 0.9)
const saved = ref<string | null>(null)
const error = ref<string | null>(null)

/** 全局快捷键的**真实注册状态**（由主进程回传，非配置里的期望值） */
const hotkeyStatus = ref<HotkeyStatus | null>(null)
let detachHotkey: (() => void) | null = null

const edgeQuietStart = computed(() => general.value?.edgeBar.quietHours?.start ?? '')
const edgeQuietEnd = computed(() => general.value?.edgeBar.quietHours?.end ?? '')

/** 提示条勿扰时段：两端都填才生效（只填一端等于没配，存下来只会让人困惑） */
async function saveEdgeQuiet(which: 'start' | 'end', value: string): Promise<void> {
  const current = general.value?.edgeBar.quietHours
  const next = {
    start: which === 'start' ? value.trim() : (current?.start ?? ''),
    end: which === 'end' ? value.trim() : (current?.end ?? ''),
  }
  const ok = await settingsStore.update({
    general: {
      ...general.value!,
      edgeBar: {
        enabled: edgeEnabled.value,
        opacity: Number(edgeOpacity.value),
        quietHours: next.start === '' || next.end === '' ? null : next,
      },
    },
  })
  if (ok) saved.value = '已保存'
  else error.value = settingsStore.error
}

onMounted(async () => {
  detachUpdate = update.bind()
  await update.load()
  // 快捷键状态：先取一次当前值，再订阅变化（改绑 / 冲突时会推送）
  const status = await window.aurora.hotkey.status()
  if (status.ok) hotkeyStatus.value = status.value
  detachHotkey = window.aurora.hotkey.onChanged((next) => {
    hotkeyStatus.value = next
  })
})

watch(
  () => settingsStore.settings,
  (next) => {
    if (!next) return
    launchAtLogin.value = next.general.launchAtLogin
    hotkey.value = next.general.hotkey
    edgeEnabled.value = next.general.edgeBar.enabled
    edgeOpacity.value = next.general.edgeBar.opacity
  },
  { immediate: true },
)

async function save(): Promise<void> {
  error.value = null
  saved.value = null
  const ok = await settingsStore.update({
    general: {
      // 死字段原样回传：UI 不提供入口，但也不该被保存动作重置（docs/08 §1）
      language: general.value?.language ?? 'zh-CN',
      launchAtLogin: launchAtLogin.value,
      hotkey: hotkey.value.trim() === '' ? 'Alt+Space' : hotkey.value.trim(),
      edgeBar: {
        enabled: edgeEnabled.value,
        opacity: Number(edgeOpacity.value),
        quietHours: general.value?.edgeBar.quietHours ?? null,
      },
    },
  })
  if (ok) saved.value = '已保存'
  else error.value = settingsStore.error
}

async function toggleEdgeBar(): Promise<void> {
  await windowStore.toggle('edge-bar')
}
</script>

<template>
  <section class="page">
    <header>
      <h1 class="page-title">常规</h1>
      <p class="page-sub">开机自启、全局快捷键与右侧提示条；系统感知与更新状态也在这里查看。</p>
    </header>

    <section class="section-card">
      <h2 class="section-title">启动</h2>
      <p class="section-desc">登录 Windows 后常驻托盘，并用全局快捷键随时唤出交互窗。</p>

      <SettingField
        data-field="general.launchAtLogin"
        label="开机自启"
        hint="登录 Windows 后自动在托盘常驻"
      >
        <input v-model="launchAtLogin" type="checkbox" />
      </SettingField>

      <SettingField
        data-field="general.hotkey"
        label="唤出快捷键"
        :hint="
          hotkeyStatus === null
            ? '读取注册状态…'
            : hotkeyStatus.registered
              ? `已在系统注册（${hotkeyStatus.hotkey}），按下即可显示 / 收起交互窗`
              : (hotkeyStatus.message ?? '未注册')
        "
      >
        <div class="column grow">
          <input v-model="hotkey" type="text" spellcheck="false" placeholder="Alt+Space" />
          <AppToast v-if="hotkeyStatus !== null && !hotkeyStatus.registered" tone="warn">
            {{ hotkeyStatus.message ?? '该快捷键未注册成功' }}
          </AppToast>
        </div>
      </SettingField>
    </section>

    <section class="section-card">
      <h2 class="section-title">提示条</h2>
      <p class="section-desc">
        桌面右缘常驻的 8px 提示条：悬停展开面板，点击呼出完整交互窗（docs/07 §2.2）。
      </p>

      <SettingField
        data-field="general.edgeBar.enabled"
        label="启用提示条"
        hint="关闭后提示条从屏幕隐藏；透明度与静默时段会一并收起，重新启用即可继续调整"
      >
        <input v-model="edgeEnabled" type="checkbox" />
        <AppButton size="sm" variant="ghost" @click="toggleEdgeBar">立即显隐</AppButton>
      </SettingField>

      <template v-if="edgeEnabled">
        <SettingField
          data-field="general.edgeBar.opacity"
          label="提示条透明度"
          hint="0.2 ～ 1.0；保存后立即应用"
        >
          <input v-model.number="edgeOpacity" type="number" min="0.2" max="1" step="0.05" />
        </SettingField>

        <SettingField
          data-field="general.edgeBar.quietHours.start"
          label="提示条开始隐藏"
          hint="格式 HH:mm；留空表示不限（仅影响提示条本身）"
        >
          <input
            type="text"
            spellcheck="false"
            placeholder="22:30"
            :value="edgeQuietStart"
            @change="saveEdgeQuiet('start', ($event.target as HTMLInputElement).value)"
          />
        </SettingField>

        <SettingField
          data-field="general.edgeBar.quietHours.end"
          label="提示条恢复显示"
          hint="格式 HH:mm；跨午夜时开始时间大于结束时间"
        >
          <input
            type="text"
            spellcheck="false"
            placeholder="07:00"
            :value="edgeQuietEnd"
            @change="saveEdgeQuiet('end', ($event.target as HTMLInputElement).value)"
          />
        </SettingField>
      </template>

      <p v-else class="section-desc" data-empty="general.edgeBar">
        提示条已停用：透明度与静默时段暂不可配，重新启用后即可继续调整。
      </p>
    </section>

    <section class="section-card">
      <h2 class="section-title">系统感知</h2>
      <p class="section-desc">时间 / 电源 / 网络已接入；其余采集项在 P5 补齐（docs/06 §8）。</p>

      <SettingField label="当前感知快照">
        <div class="column grow">
          <AppToast v-if="perception.summary">
            {{ perception.summary.localTime }} {{ perception.summary.weekday }}
            <template v-if="perception.summary.battery">
              · 电量 {{ perception.summary.battery.percent }}%
            </template>
            <template v-if="perception.summary.network">
              · 网络 {{ perception.summary.network.online ? '在线' : '离线' }}
            </template>
            · 未实现：{{ perception.summary.unknown.join('、') || '无' }}
          </AppToast>
          <div class="row">
            <AppButton size="sm" @click="perception.refresh">刷新</AppButton>
          </div>
        </div>
      </SettingField>
    </section>

    <section class="section-card">
      <h2 class="section-title">关于与更新</h2>
      <p class="section-desc">版本信息、更新状态与手动检查入口（docs/09 §5）。</p>

      <SettingField
        label="当前版本"
        :hint="
          update.state?.feed
            ? `更新源：${update.state.feed}`
            : '更新源：打包后内置（公开 releases 仓库）'
        "
      >
        <div class="column grow">
          <span class="mono tiny"
            >v{{ settingsStore.appInfo?.appVersion ?? update.state?.currentVersion ?? '—' }}</span
          >
        </div>
      </SettingField>

      <SettingField label="更新状态">
        <div class="column grow">
          <AppToast :tone="updateTone">{{ updateLabel }}</AppToast>
          <div
            v-if="update.state?.status === 'downloading'"
            class="progress"
            role="progressbar"
            :aria-valuenow="update.state.progressPercent ?? 0"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span :style="{ width: `${update.state.progressPercent ?? 0}%` }" />
          </div>
          <div class="row wrap">
            <AppButton
              size="sm"
              :disabled="
                update.busy || !update.state?.enabled || update.state?.status === 'downloading'
              "
              @click="update.check()"
            >
              检查更新
            </AppButton>
            <AppButton
              v-if="update.state?.status === 'available'"
              size="sm"
              variant="primary"
              :disabled="update.busy"
              @click="update.download()"
            >
              下载更新
            </AppButton>
            <AppButton
              v-if="update.state?.status === 'downloaded'"
              size="sm"
              variant="primary"
              @click="update.install()"
            >
              安装并重启
            </AppButton>
          </div>
          <p v-if="update.state?.enabled === false" class="tiny muted">
            自动更新只在安装版中可用；开发态请用
            <code class="mono">AURORA_UPDATE_FEED</code> 指向本地更新源做验证（docs/09 §6）。
          </p>
        </div>
      </SettingField>
    </section>

    <footer class="row">
      <AppButton variant="primary" @click="save">保存</AppButton>
      <span class="tiny muted">启动与提示条的改动需点击保存后生效</span>
      <AppToast v-if="saved" tone="ok">{{ saved }}</AppToast>
      <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    </footer>
  </section>
</template>

<style scoped>
/* 页面骨架（.page / .page-title / .page-sub / .section-*）走 settings.css 与 theme.css */
.progress {
  position: relative;
  height: 6px;
  border-radius: var(--radius-pill);
  overflow: hidden;
  background: var(--fill-2);
}

.progress span {
  display: block;
  height: 100%;
  background: var(--aurora-gradient);
  transition: width var(--transition-base);
}

.wrap {
  flex-wrap: wrap;
}

footer {
  align-items: center;
  flex-wrap: wrap;
}
</style>
