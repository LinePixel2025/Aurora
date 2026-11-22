<script setup lang="ts">
/**
 * MCP 服务器添加弹窗（2026-11 前端重构）。
 *
 * 把原先挤在 MCP 页底部的内联表单收进独立弹窗：名称 / 传输方式 / 命令或 URL /
 * 环境变量 / 自定义请求头。凭据仍由父级走 `settings:setSecrets`，弹窗只收集表单。
 */
import { computed, reactive, ref } from 'vue'
import { Puzzle, RESOURCE_NAME_PATTERN, RESOURCE_NAME_RULE } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import SettingField from '../../shared/components/SettingField.vue'
import SettingsDialog from './SettingsDialog.vue'

export interface McpServerAddPayload {
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string
  url: string
  envText: string
  headersText: string
}

const props = withDefaults(
  defineProps<{
    existingNames: readonly string[]
    busy?: boolean
    error?: string
  }>(),
  { busy: false, error: '' },
)

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'submit', payload: McpServerAddPayload): void
}>()

const localError = ref('')
const shownError = computed(() => localError.value || props.error)

const form = reactive({
  name: '',
  transport: 'stdio' as 'stdio' | 'http',
  command: 'npx',
  args: '-y @modelcontextprotocol/server-filesystem D:\\',
  url: '',
  envText: '',
  headersText: '',
})

function validate(): string | null {
  const name = form.name.trim()
  if (name === '') return '请填写服务器名称'
  if (!RESOURCE_NAME_PATTERN.test(name)) return `服务器「${name}」${RESOURCE_NAME_RULE}`
  if (props.existingNames.includes(name)) return `服务器「${name}」已存在`
  if (form.transport === 'stdio' && form.command.trim() === '') return '请填写启动命令'
  if (form.transport === 'http' && form.url.trim() === '') return '请填写服务器 URL'
  return null
}

function submit(): void {
  if (props.busy) return
  const problem = validate()
  if (problem !== null) {
    localError.value = problem
    return
  }
  localError.value = ''
  emit('submit', {
    name: form.name.trim(),
    transport: form.transport,
    command: form.command.trim(),
    args: form.args,
    url: form.url.trim(),
    envText: form.envText,
    headersText: form.headersText,
  })
}

function close(): void {
  if (props.busy) return
  emit('close')
}
</script>

<template>
  <SettingsDialog
    title="添加 MCP 服务器"
    subtitle="连接外部工具服务；连接失败只影响该服务器。"
    anchor="settings.add-mcp"
    :busy="props.busy"
    :width="720"
    @close="close"
  >
    <template #icon>
      <Puzzle :size="15" :stroke-width="1.8" />
    </template>
    <p v-if="shownError !== ''" class="form-error" role="alert">{{ shownError }}</p>

    <SettingField
      data-field="settings.add-mcp.name"
      label="名称"
      required
      hint="用于工具命名前缀与状态展示"
    >
      <input
        v-model="form.name"
        class="input"
        type="text"
        spellcheck="false"
        placeholder="filesystem"
      />
    </SettingField>

    <SettingField data-field="settings.add-mcp.transport" label="传输方式">
      <select v-model="form.transport" class="input">
        <option value="stdio">stdio（本地进程）</option>
        <option value="http">streamable-http（远程）</option>
      </select>
    </SettingField>

    <template v-if="form.transport === 'stdio'">
      <SettingField data-field="settings.add-mcp.command" label="命令" required>
        <input
          v-model="form.command"
          class="input"
          type="text"
          spellcheck="false"
          placeholder="npx"
        />
      </SettingField>
      <SettingField data-field="settings.add-mcp.args" label="参数" hint="空格分隔">
        <input v-model="form.args" class="input" type="text" spellcheck="false" />
      </SettingField>
    </template>
    <SettingField v-else data-field="settings.add-mcp.url" label="URL" required>
      <input
        v-model="form.url"
        class="input"
        type="text"
        spellcheck="false"
        placeholder="https://example.com/mcp"
      />
    </SettingField>

    <SettingField
      data-field="settings.add-mcp.env"
      label="环境变量"
      hint="每行 KEY=VALUE；值会加密存储，不回显"
    >
      <textarea v-model="form.envText" class="input" spellcheck="false" placeholder="TOKEN=xxxx" />
    </SettingField>

    <SettingField
      v-if="form.transport === 'http'"
      data-field="settings.add-mcp.headers"
      label="自定义请求头"
      hint="每行 Key: Value；值会加密存储，不回显"
    >
      <textarea
        v-model="form.headersText"
        class="input"
        spellcheck="false"
        placeholder="Authorization: Bearer xxx"
      />
    </SettingField>

    <template #footer>
      <span class="tiny muted">服务器以你填写的 argv 数组启动，不经过 shell</span>
      <span class="grow" />
      <AppButton
        size="sm"
        variant="ghost"
        :disabled="props.busy"
        data-action="cancel-add-mcp"
        @click="close"
      >
        取消
      </AppButton>
      <AppButton
        variant="primary"
        size="sm"
        :disabled="props.busy"
        data-action="submit-add-mcp"
        @click="submit"
      >
        {{ props.busy ? '保存中…' : '添加' }}
      </AppButton>
    </template>
  </SettingsDialog>
</template>

<style scoped>
.form-error {
  margin: 0;
  padding: 6px 9px;
  border-radius: var(--radius-xs);
  background: var(--error-fill);
  color: var(--error-text);
  font-size: var(--text-xs);
}

.grow {
  flex: 1;
}
</style>
