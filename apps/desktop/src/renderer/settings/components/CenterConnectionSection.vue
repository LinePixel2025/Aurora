<script setup lang="ts">
/**
 * Aurora Center 连接设置区组（docs/12 §3/§4.3/§7）：
 * 总开关 / **固定服务器地址（只读）** / 展示名 / 登录账户（设备授权主按钮）/ clientId 只读展示。
 *
 * 2026-11 前端重构：桌面端只连官方 Center，设置页不再提供服务器地址、Center 账号与密码输入；
 * 登录只保留「登录账户」按钮 —— 点开浏览器在 Center 网页完成登录与确认，主进程后台轮询拿令牌。
 * 密码直登的 `center:login` IPC 仍保留在主进程（兼容 / 测试），但设置页不再调用。
 *
 * 保存链路：本卡字段走 `settings:update`（`center.*` 整组在 `SETTINGS_READONLY_PREFIXES`
 * 黑名单里，AI 的 set_setting 改不动；设置页走 settings:update，不受该黑名单影响）。
 * 登录成功后主进程落库令牌（凭据链路 `center.token` ⇄ `center.tokenEnc`）并推送
 * `center:deviceLoginResult`，本页据此回到正常态。
 */
import { onUnmounted, ref, watch } from 'vue'
import { CENTER_SERVER_URL, ChevronRight } from '@aurora/shared/browser'
import type { CenterSettings, SettingsPatch } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

/** 本卡可保存的字段即 `SettingsPatch.center`（主进程已登记该分组并运行期剥 `tokenEnc`） */
type CenterSettingsPatch = SettingsPatch

const settingsStore = useSettingsStore()

/** 区组折叠状态（默认展开：字段与探针锚点常在 DOM 里） */
const open = ref(true)

const message = ref<string | null>(null)
const error = ref<string | null>(null)
const saving = ref(false)
/** 设备授权登录在途（已打开浏览器等网页确认；最终结果推送到达后回正常态） */
const deviceLoginPending = ref(false)

// 表单草稿：settings 是唯一水合来源；保存成功后主进程回传新 settings，草稿随之刷新。
const enabled = ref(false)
const displayName = ref('')

// 已登录标记 = 令牌已在凭据链路（hasSecret('center.token')）
const tokenSet = ref(false)
/** 登录成功后主进程记住的账号名（只读展示，不是输入框） */
const account = ref('')

// clientId 只读展示（首次登录时由主进程生成并持久化；空 = 尚未生成）
const clientId = ref('')

function hydrate(): void {
  const center = settingsStore.settings?.center
  if (!center) return
  enabled.value = center.enabled
  displayName.value = center.displayName
  account.value = center.account
  clientId.value = center.clientId
}

watch(() => settingsStore.settings, hydrate, { immediate: true })

async function refreshTokenSet(): Promise<void> {
  const result = await window.aurora.settings.hasSecret('center.token')
  tokenSet.value = result.ok ? result.value : false
}

void refreshTokenSet()

/**
 * 设备授权登录的最终结果（`center:deviceLoginResult` 推送）：approved 时主进程
 * 已落库令牌、记住账号并启用连接（连接器自动重连，状态区有展示），这里只刷新标记并给一句提示。
 */
const offDeviceLoginResult = window.aurora.center.onDeviceLoginResult((result) => {
  deviceLoginPending.value = false
  if (result.status === 'approved') {
    void refreshTokenSet()
    message.value = '登录成功，正在连接 Aurora Center'
    return
  }
  if (result.status === 'expired') {
    error.value = '设备授权确认已过期，请重新发起登录'
    return
  }
  if (result.status === 'denied') {
    error.value = '登录请求已在 Center 网页被拒绝'
    return
  }
  error.value = result.message
})

onUnmounted(() => {
  offDeviceLoginResult()
  // 页面关闭即取消在途轮询（重复点击的取消由主进程 start 内部兜底）
  void window.aurora.center.deviceLoginCancel()
})

/**
 * 「登录账户」（设备授权登录，docs/12 §4.3）：把固定服务器地址交给主进程，
 * 主进程打开 Center 网页确认页并后台轮询。触发成功后按钮停在等待态，
 * 直到结果推送（登录成功 / 过期 / 拒绝 / 出错）把它带回正常态。
 */
async function deviceLogin(): Promise<void> {
  if (deviceLoginPending.value) return
  message.value = null
  error.value = null
  if (settingsStore.settings === null) {
    error.value = '配置尚未加载完成，请稍后再试'
    return
  }
  deviceLoginPending.value = true
  const result = await window.aurora.center.deviceLogin({
    serverUrl: CENTER_SERVER_URL,
    // 主进程以持久化的 clientId 为准；这里带上只做展示一致性（可能尚未生成）
    ...(clientId.value === '' ? {} : { clientId: clientId.value }),
  })
  if (!result.ok) {
    deviceLoginPending.value = false
    error.value = result.message
    return
  }
  message.value = '已打开浏览器，请在 Center 网页确认登录…'
}

/**
 * 整卡保存：patch 只带本卡草稿值，并把服务器地址固定为官方 Center。
 * **不带** `tokenEnc`（密文，由登录链路管）与 `clientId`（主进程生成，页面不可覆写）
 * —— 顶层浅合并下缺项 = 保留原值，二者不会被这次保存碰到。
 */
async function save(): Promise<void> {
  const center: Partial<CenterSettings> = {
    enabled: enabled.value,
    serverUrl: CENTER_SERVER_URL,
    displayName: displayName.value.trim(),
  }
  const patch: CenterSettingsPatch = { center }
  message.value = null
  error.value = null
  saving.value = true
  const ok = await settingsStore.update(patch)
  saving.value = false
  if (!ok) {
    error.value = settingsStore.error
    return
  }
  if (!tookEffect(center)) {
    error.value = '保存未生效：主进程还没有接入 Center 配置的保存链路，本次改动不会持久化'
    return
  }
  message.value = '已保存'
}

/** 保存是否真的落了盘：逐字段比对回传 settings 与本次提交值 */
function tookEffect(sent: Partial<CenterSettings>): boolean {
  const saved = settingsStore.settings?.center
  if (!saved) return false
  return Object.entries(sent).every(([key, value]) => saved[key as keyof CenterSettings] === value)
}
</script>

<template>
  <section class="group section-card">
    <button class="group-head" type="button" :aria-expanded="open" @click="open = !open">
      <ChevronRight
        class="chevron"
        :class="{ open }"
        :size="14"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <span class="section-title">连接设置</span>
      <span class="group-summary tiny muted grow">
        {{ enabled ? '已启用' : '已停用' }} · 官方 Center
      </span>
    </button>

    <Transition name="collapse">
      <div v-if="open" class="group-body">
        <p class="section-desc">
          登录后自动连接官方 Center，可在网页端远程查看本机状态、发起会话。
        </p>

        <AppToast v-if="message" tone="ok">{{ message }}</AppToast>
        <AppToast v-if="error" tone="error">{{ error }}</AppToast>

        <SettingField
          data-field="center.enabled"
          label="启用 Aurora Center"
          hint="关闭后不再连接 Center，远程会话 / 远程配置 / 文件上传全部停用"
        >
          <label class="row tiny">
            <input v-model="enabled" type="checkbox" />
            <span>连接 Aurora Center 服务器</span>
          </label>
        </SettingField>

        <!-- 固定地址：只读展示。设置页不再允许改向，避免把本机数据发往任意服务器。 -->
        <SettingField
          as="div"
          data-field="center.serverUrl"
          label="服务器地址"
          hint="固定为官方 Center 地址，不可修改"
        >
          <span class="tiny mono fixed-url">{{ CENTER_SERVER_URL }}</span>
        </SettingField>

        <SettingField
          data-field="center.displayName"
          label="展示名称"
          hint="在 Center 的设备列表里显示的名字；留空 = 使用本机主机名"
        >
          <input
            v-model="displayName"
            class="input"
            type="text"
            spellcheck="false"
            placeholder="留空显示主机名"
          />
        </SettingField>

        <!--
          主按钮：设备授权登录（docs/12 §4.3）。点击后主进程打开 Center 网页确认页
          并后台轮询；按钮停在等待态直到结果推送（成功 / 过期 / 拒绝 / 出错）。
        -->
        <SettingField
          as="div"
          data-field="center.deviceLogin"
          label="登录账户"
          hint="点击后在浏览器打开 Center 网页，登录并确认后自动拿到凭据"
        >
          <div class="row wrap token-row">
            <AppButton
              variant="primary"
              size="sm"
              :disabled="deviceLoginPending"
              @click="deviceLogin"
            >
              {{ deviceLoginPending ? '已打开浏览器，请在 Center 网页确认…' : '登录账户' }}
            </AppButton>
            <span class="badge" :class="tokenSet ? 'ok' : 'warn'">
              {{ tokenSet ? '已登录' : '未登录' }}
            </span>
          </div>
          <p v-if="tokenSet && account.trim() !== ''" class="tiny muted account-line">
            当前账号：<span class="mono">{{ account }}</span>
          </p>
        </SettingField>

        <SettingField
          data-field="center.clientId"
          label="客户端 ID"
          hint="首次登录时由本机生成；仅用于在 Center 侧标识本机，不可编辑"
        >
          <span class="tiny muted mono">{{ clientId === '' ? '尚未生成' : clientId }}</span>
        </SettingField>

        <footer class="row wrap card-actions">
          <AppButton variant="primary" size="sm" :disabled="saving" @click="save">保存</AppButton>
          <span class="tiny muted">开关 / 展示名在点「保存」后落盘</span>
        </footer>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.wrap {
  flex-wrap: wrap;
}

.fixed-url {
  word-break: break-all;
}

.account-line {
  margin: var(--space-1) 0 0;
  flex-basis: 100%;
}

.token-row .input {
  min-width: 200px;
}

.card-actions {
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}
</style>
