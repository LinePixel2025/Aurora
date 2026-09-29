<script setup lang="ts">
/**
 * Aurora Center 远程控制许可区组（docs/12 §6/§7）：Center 远程操作本机的**最终闸门**。
 * 三项许可 + 单文件上限，折叠卡风格与 `TtsSection.vue` / `SttSection.vue` 一致。
 *
 * 保存走 `settings:update`（`center.*` 整组 AI 改不动，见 `CenterConnectionSection.vue`
 * 文件头的「已知缺口」——保存后同样做「回传 vs 提交」比对，未生效时明确报错）。
 * 这些许可与 `agent.permissionMode` 等本机闸门**相互独立**：Center 是另一条控制通道，
 * 关掉这里的开关后，Center 侧的对应操作会被客户端直接拒绝（`E_REMOTE_DISABLED`）。
 */
import { ref, watch } from 'vue'
import { ChevronRight } from '../../shared/icons.js'
import type { CenterSettings, SettingsPatch } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

type CenterSettingsPatch = SettingsPatch & { center: Partial<CenterSettings> }

/** 单文件上限的夹取范围，与 `CenterSchema.maxFileMb` 的 min/max 一致 */
const MIN_MAX_FILE_MB = 1
const MAX_MAX_FILE_MB = 512

const settingsStore = useSettingsStore()

/** 区组折叠状态（默认展开：字段与探针锚点常在 DOM 里） */
const open = ref(true)

const message = ref<string | null>(null)
const error = ref<string | null>(null)
const saving = ref(false)

// 表单草稿：settings 是唯一水合来源（同连接卡）
const allowRemoteSession = ref(true)
const allowRemoteConfig = ref(true)
const allowFileTransfer = ref(true)
const maxFileMb = ref(64)

function hydrate(): void {
  const center = settingsStore.settings?.center
  if (!center) return
  allowRemoteSession.value = center.allowRemoteSession
  allowRemoteConfig.value = center.allowRemoteConfig
  allowFileTransfer.value = center.allowFileTransfer
  maxFileMb.value = center.maxFileMb
}

watch(() => settingsStore.settings, hydrate, { immediate: true })

/** `maxFileMb` 夹到 1 ～ 512（Schema 的同名约束）；非有限数回落当前值，免得一次手滑让整次保存被 Zod 打回 */
function clampMaxFileMb(): number {
  const raw = Number(maxFileMb.value)
  if (!Number.isFinite(raw)) return maxFileMb.value
  return Math.min(MAX_MAX_FILE_MB, Math.max(MIN_MAX_FILE_MB, Math.round(raw)))
}

/** 整卡保存：patch 只带本卡草稿值（不带 tokenEnc / clientId，见连接卡注释） */
async function save(): Promise<void> {
  const patch: CenterSettingsPatch = {
    center: {
      allowRemoteSession: allowRemoteSession.value,
      allowRemoteConfig: allowRemoteConfig.value,
      allowFileTransfer: allowFileTransfer.value,
      maxFileMb: clampMaxFileMb(),
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

/** 保存是否真的落了盘：逐字段比对回传 settings 与本次提交值（见连接卡「已知缺口」） */
function tookEffect(sent: Partial<CenterSettings>): boolean {
  const saved = settingsStore.settings?.center
  if (!saved) return false
  for (const [key, value] of Object.entries(sent)) {
    if (saved[key as keyof CenterSettings] !== value) return false
  }
  return true
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
      <span class="section-title">远程控制许可</span>
      <span class="group-summary tiny muted grow">
        {{
          [allowRemoteSession && '会话', allowRemoteConfig && '配置', allowFileTransfer && '传文件']
            .filter(Boolean)
            .join(' / ') || '全部拒绝'
        }}
      </span>
    </button>

    <Transition name="collapse">
      <div v-if="open" class="group-body">
        <p class="section-desc">
          Center 远程操作本机的<strong>最终闸门</strong>：关掉的许可一律被本机拒绝；三项相互独立。
        </p>

        <AppToast v-if="message" tone="ok">{{ message }}</AppToast>
        <AppToast v-if="error" tone="error">{{ error }}</AppToast>

        <SettingField
          data-field="center.allowRemoteSession"
          label="允许远程会话"
          hint="允许 Center 发起对话，命令类工具仍受本机权限档位约束"
        >
          <label class="row tiny">
            <input v-model="allowRemoteSession" type="checkbox" />
            <span>允许 Center 远程发起会话</span>
          </label>
        </SettingField>

        <SettingField
          data-field="center.allowRemoteConfig"
          label="允许远程配置"
          hint="允许 Center 下发配置改动；仍受远端配置白名单约束，超出白名单一律拒绝"
        >
          <label class="row tiny">
            <input v-model="allowRemoteConfig" type="checkbox" />
            <span>允许 Center 远程修改配置</span>
          </label>
        </SettingField>

        <SettingField
          data-field="center.allowFileTransfer"
          label="允许文件上传"
          hint="允许 Center 通过 center_send_file 把本机文件发到 Center"
        >
          <label class="row tiny">
            <input v-model="allowFileTransfer" type="checkbox" />
            <span>允许 Center 上传本机文件</span>
          </label>
        </SettingField>

        <SettingField
          data-field="center.maxFileMb"
          label="单文件上限"
          hint="单个上传文件的体积上限，1 ～ 512 MB；超出上限的文件不上传"
        >
          <input
            v-model.number="maxFileMb"
            class="input"
            type="number"
            min="1"
            max="512"
            step="1"
          />
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

.card-actions {
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}
</style>
