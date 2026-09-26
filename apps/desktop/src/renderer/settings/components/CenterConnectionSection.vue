<script setup lang="ts">
/**
 * Aurora Center 连接设置区组（docs/12 §6/§7）：总开关 / 服务器地址 / 展示名 /
 * 配对令牌 / clientId 只读展示。折叠卡风格与 `TtsSection.vue` / `SttSection.vue` 一致。
 *
 * 保存链路分工（与 TTS provider 同一套口径）：
 * - 本卡字段走 `settings:update`（`center.*` 整组在 `SETTINGS_READONLY_PREFIXES` 黑名单里
 *   —— AI 的 set_setting 改不动；设置页走 settings:update，不受该黑名单影响）；
 * - 配对令牌是**凭据**，永不进 settings:update，只走 `settings:setSecrets`
 *   （路径 `center.token` ⇄ `center.tokenEnc`，与 apiKey 同链路，主进程加密落盘）；
 *   「已配置 / 未配置」标记用 `settings:hasSecret` 查询，页面永不回显明文与密文。
 *
 * ⚠️ 已知缺口（报告项，不在本文件修）：`SettingsPatch`（shared/ipc/types.ts）尚未登记
 * `center` 分组，主进程 `mergeSettingsPatch`（main/settings-patch.ts）也没有对应分支
 * —— 接线之前 `settings:update` 会**静默忽略** center 子树（返回成功但不落盘）。
 * 因此保存后用「回传 settings 与提交值比对」检测这一点，未生效时明确报错
 * （宁可信其无，不给用户一个假成功）；主进程补上分支后本页无需任何改动。
 */
import { ref, watch } from 'vue'
import { ChevronRight } from '../../shared/icons.js'
import type { CenterSettings, SettingsPatch } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

/**
 * 带尚未接线的 `center` 分组的补丁形状：与 `SettingsPatch` 结构相容（交集类型可赋给它），
 * 无需类型断言。主进程补登记后可直接收窄为 `SettingsPatch` 自身。
 */
type CenterSettingsPatch = SettingsPatch & { center: Partial<CenterSettings> }

const settingsStore = useSettingsStore()

/** 区组折叠状态（默认展开：字段与探针锚点常在 DOM 里） */
const open = ref(true)

const message = ref<string | null>(null)
const error = ref<string | null>(null)
const saving = ref(false)
const savingToken = ref(false)

// 表单草稿：settings 是唯一水合来源；保存成功后主进程回传新 settings，草稿随之刷新。
// `center` 组 AI 改不动，广播重灌的实际来源只有保存回传与远端配置下发。
const enabled = ref(false)
const serverUrl = ref('')
const displayName = ref('')

// 配对令牌：write-only 输入（与 TTS/STT 的 API Key 同款），已配置标记走 hasSecret
const token = ref('')
const tokenSet = ref(false)

// clientId 只读展示（首次启用时由主进程生成并持久化；空 = 尚未生成）
const clientId = ref('')

function hydrate(): void {
  const center = settingsStore.settings?.center
  if (!center) return
  enabled.value = center.enabled
  serverUrl.value = center.serverUrl
  displayName.value = center.displayName
  clientId.value = center.clientId
}

watch(() => settingsStore.settings, hydrate, { immediate: true })

async function refreshTokenSet(): Promise<void> {
  const result = await window.aurora.settings.hasSecret('center.token')
  tokenSet.value = result.ok ? result.value : false
}

void refreshTokenSet()

/**
 * 整卡保存：patch 只带本卡草稿值。
 * **不带** `tokenEnc`（密文，由 setSecret 管）与 `clientId`（主进程生成，页面不可覆写）
 * —— 顶层浅合并下缺项 = 保留原值，二者不会被这次保存碰到。
 */
async function save(): Promise<void> {
  const patch: CenterSettingsPatch = {
    center: {
      enabled: enabled.value,
      serverUrl: serverUrl.value.trim(),
      displayName: displayName.value.trim(),
    },
  }
  message.value = null
  error.value = null
  saving.value = true
  const ok = await settingsStore.update(patch)
  saving.value = false
  if (!ok) {
    error.value = settingsStore.error
    return
  }
  if (!tookEffect(patch.center)) {
    error.value = '保存未生效：主进程还没有接入 Center 配置的保存链路，本次改动不会持久化'
    return
  }
  message.value = '已保存'
}

/** 保存是否真的落了盘：逐字段比对回传 settings 与本次提交值（见文件头「已知缺口」） */
function tookEffect(sent: Partial<CenterSettings>): boolean {
  const saved = settingsStore.settings?.center
  if (!saved) return false
  return Object.entries(sent).every(([key, value]) => saved[key as keyof CenterSettings] === value)
}

/** 「保存令牌」：明文只走 settings:setSecrets；落库成功后清输入框并刷新已配置标记 */
async function saveToken(): Promise<void> {
  const value = token.value.trim()
  message.value = null
  error.value = null
  if (value === '') {
    error.value = '请先粘贴 Center 颁发的配对令牌'
    return
  }
  savingToken.value = true
  const result = await window.aurora.settings.setSecrets({ 'center.token': value })
  savingToken.value = false
  if (!result.ok) {
    error.value = result.message
    return
  }
  token.value = ''
  await refreshTokenSet()
  if (!result.value.persisted) {
    error.value = '安全存储不可用：令牌只保留在本次运行的内存中'
    return
  }
  message.value = '配对令牌已保存'
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
          连接到 Aurora Center：桌面端作为客户端连上它之后，Center 可以查看本机状态、远程发起会话
          （许可见下一卡）。连接目标与配对令牌只保存在本机，这里的任何配置 AI 都改不动。
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
          hint="ws(s):// 或 http(s)://（连接时统一换成 ws 协议）；填写与否和上面的开关无关，都可编辑"
        >
          <input
            v-model="serverUrl"
            class="input"
            type="text"
            spellcheck="false"
            placeholder="wss://center.example.com"
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

        <SettingField
          data-field="center.token"
          label="配对令牌"
          :hint="
            tokenSet
              ? '已保存（重新粘贴并保存可更换；页面不回显）'
              : '由 Center 颁发；明文只写入系统安全存储，页面不回显'
          "
        >
          <div class="row wrap token-row">
            <input
              v-model="token"
              class="input grow"
              type="password"
              spellcheck="false"
              placeholder="粘贴配对令牌"
            />
            <AppButton size="sm" :disabled="savingToken" @click="saveToken">保存令牌</AppButton>
            <span class="badge" :class="tokenSet ? 'ok' : 'warn'">
              {{ tokenSet ? '已配置' : '未配置' }}
            </span>
          </div>
        </SettingField>

        <SettingField
          data-field="center.clientId"
          label="客户端 ID"
          hint="首次启用后由本机生成并持久化；仅用于在 Center 侧标识本机，不可编辑"
        >
          <span class="tiny muted mono">{{ clientId === '' ? '尚未生成' : clientId }}</span>
        </SettingField>

        <footer class="row wrap card-actions">
          <AppButton variant="primary" size="sm" :disabled="saving" @click="save">保存</AppButton>
          <span class="tiny muted">改动在点「保存」后落盘</span>
        </footer>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.wrap {
  flex-wrap: wrap;
}

/* 令牌行：输入框吃满剩余宽度，按钮与已配置徽章贴在右边 */
.token-row .input {
  min-width: 200px;
}

.card-actions {
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}
</style>
