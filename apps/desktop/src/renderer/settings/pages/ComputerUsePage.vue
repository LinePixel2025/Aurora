<script setup lang="ts">
/**
 * Computer Use 设置页（v39，docs/06 §28、docs/08 §1）。
 *
 * 整组在 `SETTINGS_READONLY_PREFIXES`：只能由用户在这里开启 / 放宽，AI 的 `set_setting`
 * 改不动。真正的会话授权在对话窗输入框（每会话一次性），本页只管默认配置。
 */
import { computed, ref } from 'vue'
import { MousePointer2 } from '@aurora/shared/browser'
import type { ComputerUseSettings } from '@aurora/shared/browser'
import {
  DEFAULT_TOOLCHAIN_CONFIG,
  resolveModelParams,
  resolvePermissionMode,
} from '@aurora/shared/browser'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

type ToastTone = 'info' | 'warn' | 'error' | 'ok'

const settingsStore = useSettingsStore()
const toast = ref<{ tone: ToastTone; text: string } | null>(null)

const config = computed<ComputerUseSettings>(
  () => settingsStore.settings?.computerUse ?? DEFAULT_TOOLCHAIN_CONFIG.computerUse,
)

const vision = computed(() => {
  const settings = settingsStore.settings
  if (settings === null) return false
  const provider = settings.llm.providers[settings.llm.active]
  return provider === undefined ? false : resolveModelParams(provider).vision === true
})

const permissionMode = computed(() =>
  settingsStore.settings === null ? 'confirm' : resolvePermissionMode(settingsStore.settings),
)

const readiness = computed(() => {
  if (!config.value.enabled) return '未启用'
  if (!vision.value) return '当前模型不支持图片输入'
  if (permissionMode.value === 'readonly') return '只读档下不可用'
  return '可用（在对话输入框输入 /computer 授权后使用）'
})

async function save(patch: Partial<ComputerUseSettings>): Promise<boolean> {
  const current = settingsStore.settings?.computerUse
  if (!current) return false
  const ok = await settingsStore.update({ computerUse: { ...current, ...patch } })
  toast.value = ok
    ? { tone: 'ok', text: '已保存' }
    : { tone: 'error', text: settingsStore.error ?? '保存失败' }
  return ok
}

function numberValue(event: Event, min: number, max: number, fallback: number): number {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function appList(event: Event): string[] {
  return (event.target as HTMLTextAreaElement).value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 100)
}

function onAppsChange(field: 'allowedApps' | 'deniedApps', event: Event): void {
  void save({ [field]: appList(event) } as Partial<ComputerUseSettings>)
}
</script>

<template>
  <section class="page page-computer-use">
    <header>
      <h1 class="page-title">Computer Use</h1>
      <p class="page-sub">让 Agent 像人一样操作电脑（仅 Windows，需多模态模型）。</p>
    </header>

    <AppToast v-if="toast" :tone="toast.tone">{{ toast.text }}</AppToast>

    <section class="group section-card">
      <div class="group-head static">
        <MousePointer2 :size="15" :stroke-width="1.6" aria-hidden="true" />
        <span class="section-title">总开关与前提</span>
        <span class="group-summary tiny muted grow">{{ readiness }}</span>
      </div>
      <div class="group-body">
        <p class="section-desc">
          Agent 会截取屏幕并合成鼠标、键盘、窗口操作。只有你在对话输入框输入 /computer
          授权后才会执行。
        </p>

        <SettingField
          data-field="computer-use.enabled"
          label="启用 Computer Use"
          hint="默认关闭；开启后仍需在对话输入框输入 /computer 逐会话授权"
        >
          <label class="row tiny">
            <input
              type="checkbox"
              :checked="config.enabled"
              @change="save({ enabled: ($event.target as HTMLInputElement).checked })"
            />
            <span>允许 Agent 使用桌面操控能力</span>
          </label>
        </SettingField>

        <p v-if="!vision" class="hint warn">
          当前模型未开启图片输入。请到「AI
          模型」页为当前模型勾选「支持图片输入」，否则工具不会注册。
        </p>
        <p v-if="permissionMode === 'readonly'" class="hint warn">
          当前是只读档，Computer Use 不可用；切到「变更前确认」或「完全权限」后再试。
        </p>
      </div>
    </section>

    <section class="group section-card">
      <div class="group-head static">
        <span class="section-title">视觉与实时提示</span>
      </div>
      <div class="group-body">
        <SettingField
          data-field="computer-use.showVirtualCursor"
          label="虚拟光标"
          hint="Agent 自己的光环与拖尾，不跟你的鼠标；原生指针仍保留"
        >
          <label class="row tiny">
            <input
              type="checkbox"
              :checked="config.showVirtualCursor"
              @change="save({ showVirtualCursor: ($event.target as HTMLInputElement).checked })"
            />
            <span>显示虚拟光标</span>
          </label>
        </SettingField>

        <SettingField
          data-field="computer-use.glow"
          label="屏幕流光"
          hint="操作期间屏幕顶端的光谱流光，表示 Agent 正在动手"
        >
          <label class="row tiny">
            <input
              type="checkbox"
              :checked="config.glow"
              @change="save({ glow: ($event.target as HTMLInputElement).checked })"
            />
            <span>显示屏幕流光</span>
          </label>
        </SettingField>

        <SettingField
          data-field="computer-use.showHud"
          label="操作过程面板"
          hint="屏幕顶部显示这一步在干什么与下一步计划；不显示坐标与输入内容"
        >
          <label class="row tiny">
            <input
              type="checkbox"
              :checked="config.showHud"
              @change="save({ showHud: ($event.target as HTMLInputElement).checked })"
            />
            <span>显示顶部过程面板</span>
          </label>
        </SettingField>
      </div>
    </section>

    <section class="group section-card">
      <div class="group-head static">
        <span class="section-title">操作节奏</span>
      </div>
      <div class="group-body">
        <SettingField
          data-field="computer-use.moveDurationMs"
          label="鼠标移动时长"
          hint="毫秒，0 ～ 1000；0 = 瞬移；点击前光标也按此时长先滑到落点"
        >
          <input
            class="input input-num"
            type="number"
            min="0"
            max="1000"
            step="10"
            :value="config.moveDurationMs"
            @change="
              save({
                moveDurationMs: numberValue($event, 0, 1000, config.moveDurationMs),
              })
            "
          />
        </SettingField>

        <SettingField
          data-field="computer-use.typingDelayMs"
          label="输入间隔"
          hint="毫秒，0 ～ 200，默认 10；逐字符延迟"
        >
          <input
            class="input input-num"
            type="number"
            min="0"
            max="200"
            step="1"
            :value="config.typingDelayMs"
            @change="
              save({
                typingDelayMs: numberValue($event, 0, 200, config.typingDelayMs),
              })
            "
          />
        </SettingField>

        <SettingField
          data-field="computer-use.screenshotMaxWidth"
          label="截图最长边"
          hint="像素，640 ～ 2560，默认 1280；越小越省 token"
        >
          <input
            class="input input-num"
            type="number"
            min="640"
            max="2560"
            step="80"
            :value="config.screenshotMaxWidth"
            @change="
              save({
                screenshotMaxWidth: numberValue($event, 640, 2560, config.screenshotMaxWidth),
              })
            "
          />
        </SettingField>
      </div>
    </section>

    <section class="group section-card">
      <div class="group-head static">
        <span class="section-title">安全与限额</span>
      </div>
      <div class="group-body">
        <SettingField
          data-field="computer-use.maxActions"
          label="单会话动作上限"
          hint="10 ～ 2000，默认 300；超出自动停止"
        >
          <input
            class="input input-num"
            type="number"
            min="10"
            max="2000"
            step="10"
            :value="config.maxActions"
            @change="save({ maxActions: numberValue($event, 10, 2000, config.maxActions) })"
          />
        </SettingField>

        <SettingField
          data-field="computer-use.idleStopMinutes"
          label="闲置自动结束"
          hint="分钟，1 ～ 60，默认 10；无 Computer Use 调用即计时"
        >
          <input
            class="input input-num"
            type="number"
            min="1"
            max="60"
            step="1"
            :value="config.idleStopMinutes"
            @change="
              save({
                idleStopMinutes: numberValue($event, 1, 60, config.idleStopMinutes),
              })
            "
          />
        </SettingField>

        <SettingField
          data-field="computer-use.allowedApps"
          label="允许的应用"
          hint="可执行文件名，一行一个，如 notepad.exe；留空 = 除禁止项外全部允许"
        >
          <textarea
            class="input app-list"
            rows="4"
            spellcheck="false"
            placeholder="notepad.exe&#10;chrome.exe"
            :value="config.allowedApps.join('\n')"
            @change="onAppsChange('allowedApps', $event)"
          />
        </SettingField>

        <SettingField
          data-field="computer-use.deniedApps"
          label="禁止的应用"
          hint="一行一个；优先于允许名单，受保护应用始终不可操作"
        >
          <textarea
            class="input app-list"
            rows="4"
            spellcheck="false"
            placeholder="bitwarden.exe&#10;keepass.exe"
            :value="config.deniedApps.join('\n')"
            @change="onAppsChange('deniedApps', $event)"
          />
        </SettingField>

        <p class="section-desc">
          终端、任务管理器、UAC / 锁屏与 Aurora
          自身始终不可操作；用户手动移动鼠标或键盘不会中断任务。
        </p>
      </div>
    </section>

    <section class="group section-card">
      <div class="group-head static">
        <span class="section-title">使用方式</span>
      </div>
      <div class="group-body">
        <p class="section-desc">
          在对话输入框输入 /computer 授权（也可写 /computer
          任务），再描述任务。同一时间只允许一个会话；停止可用对话状态条、托盘或
          <code class="mono">Ctrl+Alt+Shift+Esc</code>。
        </p>
        <p class="section-desc">
          截图会作为模型输入发送，可能包含屏幕上的密码、私信等内容；请在任务开始前关闭敏感窗口。
        </p>
      </div>
    </section>
  </section>
</template>

<style scoped>
.app-list {
  min-height: 88px;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}

.hint {
  margin: 0;
  font-size: var(--text-sm);
}

.hint.warn {
  color: var(--status-unread);
}

.group-head.static {
  cursor: default;
}
</style>
