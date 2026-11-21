<script setup lang="ts">
/**
 * Agent → 内置浏览器页（v35，docs/06 §27、docs/07 §2.5、docs/08 §6）。
 *
 * 2026-11 Agent 独立栏目：原「Agent 设置」页里的内置浏览器区组单独成页。
 * 与 `agent.tools` 并列、**不跟电脑操控总开关门控**：它是一组独立的网页测试能力。
 * 整组在 `SETTINGS_READONLY_PREFIXES` 里（AI 不可改），但用户在本页可自由调整；
 * 配置未水合时回落到默认值，只为让控件有初值（探针要求字段常显）。
 *
 * 保存只提交 `{ agent: { browser } }`：主进程对 `agent` 是分组浅合并
 * （`Object.assign(draft.agent, patch.agent)`），`tools` / `snapshots` / `loop` /
 * `permissionMode` / `subagents` 原样保留。
 */
import { computed, ref } from 'vue'
import type { AgentSettings } from '@aurora/shared/browser'
import { DEFAULT_TOOLCHAIN_CONFIG, resolvePermissionMode } from '@aurora/shared/browser'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

type ToastTone = 'info' | 'warn' | 'error' | 'ok'

const settingsStore = useSettingsStore()
/** 页级唯一 Toast：本页保存回执统一渲染在这里 */
const toast = ref<{ tone: ToastTone; text: string } | null>(null)

/** 内置浏览器配置：未水合时回落到 Schema 默认值，只为让控件有初值 */
const browser = computed<AgentSettings['browser']>(
  () => settingsStore.settings?.agent.browser ?? DEFAULT_TOOLCHAIN_CONFIG.agent.browser,
)

/** 只读档下浏览器工具不注册：摘要要按**生效档位**写，不按字段字面值写 */
const permissionReadonly = computed(() => {
  const settings = settingsStore.settings
  return settings !== null && resolvePermissionMode(settings) === 'readonly'
})

/** 区组头摘要：收起 / 页内扫一眼就能看出开关与并发上限 */
const browserSummary = computed(() => {
  if (permissionReadonly.value) return '只读模式：浏览器工具不注册'
  const current = browser.value
  if (!current.enabled) return '已停用'
  return `最多 ${current.maxSessions} 个会话 · ${current.idleMinutes} 分钟空闲释放`
})

/** 保存：`agent` 分组浅合并，只带完整的 `browser` 子树 */
async function saveBrowser(patch: Partial<AgentSettings['browser']>): Promise<boolean> {
  const current = settingsStore.settings?.agent.browser
  // 未加载完就写等于用兜底默认值覆盖已保存配置（与其它页同口径）
  if (!current) return false
  const ok = await settingsStore.update({ agent: { browser: { ...current, ...patch } } })
  toast.value = ok
    ? { tone: 'ok', text: '已保存' }
    : { tone: 'error', text: settingsStore.error ?? '保存失败' }
  return ok
}

/** 数字输入解析：非数字回落原值，越界夹到 Schema 的 min/max（主进程还会再校验一次） */
function clampNumber(event: Event, min: number, max: number, fallback: number): number {
  const raw = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.round(raw)))
}
</script>

<template>
  <section class="page page-agent-browser">
    <header>
      <h1 class="page-title">内置浏览器</h1>
      <p class="page-sub">让 Agent 在右栏浏览器里做网页测试：打开、点击、输入、截图。</p>
    </header>

    <AppToast v-if="toast" :tone="toast.tone">{{ toast.text }}</AppToast>

    <section class="group section-card">
      <div class="group-head static">
        <span class="section-title">浏览器能力</span>
        <span class="group-summary tiny muted grow">{{ browserSummary }}</span>
      </div>
      <div class="group-body">
        <p class="section-desc">
          在右栏浏览器里打开页面、点击、输入并截图；页面内容会作为模型输入发送。
        </p>

        <SettingField
          data-field="agent.browser.enabled"
          label="启用内置浏览器"
          hint="关闭后 Agent 看不到浏览器工具，正在进行的会话会被结束"
        >
          <label class="row tiny">
            <input
              type="checkbox"
              :checked="browser.enabled"
              @change="saveBrowser({ enabled: ($event.target as HTMLInputElement).checked })"
            />
            <span>允许 Agent 操作内置浏览器（默认开启）</span>
          </label>
        </SettingField>

        <SettingField
          data-field="agent.browser.maxSessions"
          label="同时最多会话"
          hint="1 ～ 4，默认 2；到上限时 Agent 需先关闭一个会话"
        >
          <input
            class="input input-num"
            type="number"
            min="1"
            max="4"
            step="1"
            :value="browser.maxSessions"
            @change="
              saveBrowser({
                maxSessions: clampNumber($event, 1, 4, browser.maxSessions),
              })
            "
          />
        </SettingField>

        <SettingField
          data-field="agent.browser.idleMinutes"
          label="空闲释放"
          hint="单位分钟，1 ～ 60，默认 10；到点释放页面内存，标签保留"
        >
          <input
            class="input input-num"
            type="number"
            min="1"
            max="60"
            step="1"
            :value="browser.idleMinutes"
            @change="
              saveBrowser({
                idleMinutes: clampNumber($event, 1, 60, browser.idleMinutes),
              })
            "
          />
        </SettingField>

        <SettingField
          data-field="agent.browser.allowPrivateNetwork"
          label="本机与内网地址"
          hint="关闭后只允许公网域名，localhost 与内网 IP 会被拒绝"
        >
          <label class="row tiny">
            <input
              type="checkbox"
              :checked="browser.allowPrivateNetwork"
              @change="
                saveBrowser({
                  allowPrivateNetwork: ($event.target as HTMLInputElement).checked,
                })
              "
            />
            <span>允许访问本机 / 内网地址（默认开启）</span>
          </label>
        </SettingField>

        <SettingField
          data-field="agent.browser.compatUserAgent"
          label="兼容 User-Agent"
          hint="去掉 Electron 标识，减少站点以浏览器不支持为由拒绝"
        >
          <label class="row tiny">
            <input
              type="checkbox"
              :checked="browser.compatUserAgent"
              @change="
                saveBrowser({
                  compatUserAgent: ($event.target as HTMLInputElement).checked,
                })
              "
            />
            <span>对 Agent 标签使用兼容 UA（默认开启）</span>
          </label>
        </SettingField>

        <SettingField
          data-field="agent.browser.allowMedia"
          label="网页媒体权限"
          hint="默认关闭；仅对 Agent 控制的标签生效，测试音视频页面时再开"
        >
          <label class="row tiny">
            <input
              type="checkbox"
              :checked="browser.allowMedia"
              @change="
                saveBrowser({
                  allowMedia: ($event.target as HTMLInputElement).checked,
                })
              "
            />
            <span>允许网页使用摄像头 / 麦克风</span>
          </label>
        </SettingField>
      </div>
    </section>
  </section>
</template>
