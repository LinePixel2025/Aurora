<script setup lang="ts">
/**
 * Aurora Center 连接设置区组（docs/12 §3/§4.3/§7）：总开关 / 服务器地址 / 展示名 /
 * 登录账户（设备授权，主按钮）/ 密码登录（回落表单）/ clientId 只读展示。
 * 折叠卡风格与 `TtsSection.vue` / `SttSection.vue` 一致。
 *
 * 保存链路分工（与 TTS provider 同一套口径）：
 * - 本卡字段走 `settings:update`（`center.*` 整组在 `SETTINGS_READONLY_PREFIXES` 黑名单里
 *   —— AI 的 set_setting 改不动；设置页走 settings:update，不受该黑名单影响）；
 * - **主路径是设备授权登录（v0.2.2）**：点「登录账户」走 `center:deviceLogin` IPC，
 *   主进程 `POST /api/client/device/start` 拿确认页地址并打开浏览器，随后后台轮询；
 *   网页确认后主进程拿到令牌落库（凭据链路 `center.token` ⇄ `center.tokenEnc`，
 *   与 apiKey 同链路）并推送 `center:deviceLoginResult`，本页据此回到正常态。
 * - **回落是密码直登（v0.2.1）**：填服务器地址 + Center 账号密码 → 「密码登录」
 *   走 `center:login` IPC，主进程调 `/api/client/login` 换客户端令牌。密码只在
 *   登录请求里使用，页面不保存、不回显；「已登录 / 未登录」标记用
 *   `settings:hasSecret` 查询。旧的手填配对令牌入口已移除（手动令牌功能面已整体删除）。
 */
import { onUnmounted, ref, watch } from 'vue'
import { ChevronRight } from '@aurora/shared/browser'
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
const loggingIn = ref(false)
/** 设备授权登录在途（已打开浏览器等网页确认；最终结果推送到达后回正常态） */
const deviceLoginPending = ref(false)

// 表单草稿：settings 是唯一水合来源；保存成功后主进程回传新 settings，草稿随之刷新。
// `center` 组 AI 改不动，广播重灌的实际来源只有保存回传与远端配置下发。
const enabled = ref(false)
const serverUrl = ref('')
const displayName = ref('')
const account = ref('')

// 登录密码：write-only（只在点「密码登录」时随请求发给主进程），登录成功即清空
const password = ref('')

// 已登录标记 = 令牌已在凭据链路（hasSecret('center.token')）
const tokenSet = ref(false)

// clientId 只读展示（首次登录时由主进程生成并持久化；空 = 尚未生成）
const clientId = ref('')

function hydrate(): void {
  const center = settingsStore.settings?.center
  if (!center) return
  enabled.value = center.enabled
  serverUrl.value = center.serverUrl
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
 * 已落库令牌、记住账号并启用连接（连接器自动重连，状态区有展示），这里只刷新
 * 标记、清空回落表单并给一句提示。
 */
const offDeviceLoginResult = window.aurora.center.onDeviceLoginResult((result) => {
  deviceLoginPending.value = false
  if (result.status === 'approved') {
    void refreshTokenSet()
    password.value = ''
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
 * 「登录账户」（设备授权登录，docs/12 §4.3）：把服务器地址交给主进程，
 * 主进程打开 Center 网页确认页并后台轮询。触发成功后按钮停在等待态，
 * 直到结果推送（登录成功 / 过期 / 拒绝 / 出错）把它带回正常态。
 */
async function deviceLogin(): Promise<void> {
  if (deviceLoginPending.value) return
  message.value = null
  error.value = null
  const trimmedUrl = serverUrl.value.trim()
  if (trimmedUrl === '') {
    error.value = '请先填写服务器地址'
    return
  }
  deviceLoginPending.value = true
  const result = await window.aurora.center.deviceLogin({
    serverUrl: trimmedUrl,
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
 * 整卡保存：patch 只带本卡草稿值。
 * **不带** `tokenEnc`（密文，由登录链路管）与 `clientId`（主进程生成，页面不可覆写）
 * —— 顶层浅合并下缺项 = 保留原值，二者不会被这次保存碰到。
 */
async function save(): Promise<void> {
  const center: Partial<CenterSettings> = {
    enabled: enabled.value,
    serverUrl: serverUrl.value.trim(),
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

/**
 * 「密码登录」（回落表单，docs/12 §3）：账号密码经 `center:login` 发给主进程，
 * 由主进程调 Center 的 `/api/client/login` 换令牌。成功后主进程已写入令牌、
 * 记住账号并启用连接（连接器自动重连），这里只刷新展示并清空密码框。
 */
async function login(): Promise<void> {
  // 重入守卫：Enter 与按钮共用本函数；并发登录会互相吊销令牌（每次登录重发并吊销
  // 同 clientId 旧令牌），乱序回包会把已吊销的令牌写进凭据链路 —— 必须串行化。
  if (loggingIn.value) return
  message.value = null
  error.value = null
  const trimmedUrl = serverUrl.value.trim()
  const trimmedAccount = account.value.trim()
  if (trimmedUrl === '' || trimmedAccount === '' || password.value === '') {
    error.value = '请先填写服务器地址、账号与密码'
    return
  }
  loggingIn.value = true
  const result = await window.aurora.center.login({
    serverUrl: trimmedUrl,
    username: trimmedAccount,
    password: password.value,
  })
  loggingIn.value = false
  if (!result.ok) {
    error.value = result.message
    return
  }
  password.value = ''
  await refreshTokenSet()
  if (!result.value.tokenPersisted) {
    error.value = '安全存储不可用：本次运行内已连接，重启后需要重新登录'
    return
  }
  message.value = `已登录 ${result.value.account}，正在连接 Aurora Center`
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
        {{ enabled ? '已启用' : '已停用' }} ·
        {{ serverUrl.trim() === '' ? '未配置服务器地址' : serverUrl }}
      </span>
    </button>

    <Transition name="collapse">
      <div v-if="open" class="group-body">
        <p class="section-desc">
          用 Center 账号登录后自动连接并归属该账号，可在网页端远程查看本机状态、发起会话。
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

        <SettingField
          data-field="center.serverUrl"
          label="服务器地址"
          hint="ws(s):// 或 http(s)://，连接时统一换成 ws；与上面的开关无关，都可编辑"
        >
          <input
            v-model="serverUrl"
            class="input"
            type="text"
            spellcheck="false"
            placeholder="http://center.example.com:8787"
          />
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
          hint="点击后打开浏览器，在 Center 网页登录并一键确认，桌面端自动拿到凭据"
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
        </SettingField>

        <SettingField
          data-field="center.account"
          label="Center 账号"
          :hint="
            tokenSet
              ? '已登录（重新登录可更换账号 / 刷新凭据）'
              : '由 Center 管理员创建的账号，仅密码登录时使用；改动不随「保存」提交'
          "
        >
          <input
            v-model="account"
            class="input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="Center 账号名"
          />
        </SettingField>

        <!-- 回落表单：不想切浏览器的场景用账号密码直登（docs/12 §3） -->
        <SettingField
          data-field="center.password"
          label="登录密码"
          hint="只在点「密码登录」时使用一次，不保存在本机，页面不回显"
        >
          <div class="row wrap token-row">
            <input
              v-model="password"
              class="input grow"
              type="password"
              spellcheck="false"
              autocomplete="off"
              placeholder="Center 账号密码"
              @keydown.enter="login"
            />
            <AppButton size="sm" :disabled="loggingIn" @click="login">密码登录</AppButton>
          </div>
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
          <span class="tiny muted">开关 / 地址 / 展示名在点「保存」后落盘</span>
        </footer>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.wrap {
  flex-wrap: wrap;
}

/* 密码行：输入框吃满剩余宽度，按钮与已登录徽章贴在右边 */
.token-row .input {
  min-width: 200px;
}

.card-actions {
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}
</style>
