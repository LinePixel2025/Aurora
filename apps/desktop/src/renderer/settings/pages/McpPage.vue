<script setup lang="ts">
/**
 * MCP 管理页（docs/06 §7、docs/08 §6）。
 *
 * P1 范围：服务器配置的增删改与状态灯占位（连接能力在 P3 接入 McpClientHub）。
 * env 凭据通过 settings:setSecrets 加密存储，列表只显示已配置的变量名。
 */
import { computed, reactive, ref } from 'vue'
import type { McpServerConfig } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const error = ref<string | null>(null)
const message = ref<string | null>(null)

const form = reactive({
  name: '',
  transport: 'stdio' as 'stdio' | 'http',
  command: 'npx',
  args: '-y @modelcontextprotocol/server-filesystem D:\\',
  url: '',
  envText: '',
})

const servers = computed<McpServerConfig[]>(() => settingsStore.settings?.mcp.servers ?? [])

async function saveServers(
  next: McpServerConfig[],
  secrets: Record<string, string> = {},
): Promise<boolean> {
  const ok = await settingsStore.update({ mcp: { servers: next } })
  if (!ok) {
    error.value = settingsStore.error
    return false
  }
  if (Object.keys(secrets).length > 0) {
    const result = await window.aurora.settings.setSecrets(secrets)
    if (!result.ok) {
      error.value = result.message
      return false
    }
  }
  return true
}

async function add(): Promise<void> {
  error.value = null
  message.value = null
  const name = form.name.trim()
  if (name === '') {
    error.value = '请填写服务器名称'
    return
  }
  if (servers.value.some((server) => server.name === name)) {
    error.value = `服务器「${name}」已存在`
    return
  }

  const env: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  for (const line of form.envText.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key === '' || value === '') continue
    env[key] = ''
    secrets[`mcp.servers.${name}.env.${key}`] = value
  }

  const server: McpServerConfig = {
    name,
    transport: form.transport,
    ...(form.transport === 'stdio'
      ? { command: form.command.trim(), args: form.args.split(/\s+/).filter((item) => item !== '') }
      : { url: form.url.trim() }),
    envEnc: env,
    enabled: true,
  }

  const saved = await saveServers([...servers.value, server], secrets)
  if (!saved) return
  message.value = `已添加 ${name}（连接能力将在 P3 接入）`
  form.name = ''
  form.envText = ''
}

async function remove(name: string): Promise<void> {
  const next = servers.value.filter((server) => server.name !== name)
  const saved = await saveServers(next)
  if (saved) message.value = `已删除 ${name}`
}

async function toggleEnabled(server: McpServerConfig): Promise<void> {
  const next = servers.value.map((item) =>
    item.name === server.name ? { ...item, enabled: !item.enabled } : item,
  )
  await saveServers(next)
}
</script>

<template>
  <section class="page">
    <header>
      <h2>MCP</h2>
      <p class="tiny muted">
        连接外部工具服务（Model Context Protocol）。工具会以
        <code class="mono">mcp.&lt;server&gt;.&lt;tool&gt;</code> 注册进 Agent 工具表； 与 Skill
        重名时 MCP 优先。P1 仅保存配置与状态灯，真实连接与工具注册在 P3 落地。
      </p>
    </header>

    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>

    <div class="list">
      <article v-for="server in servers" :key="server.name" class="server">
        <header class="server-head">
          <span class="dot" :class="server.enabled ? 'on' : 'off'" />
          <strong class="mono">{{ server.name }}</strong>
          <span class="badge">{{ server.transport }}</span>
          <span class="badge warn">未连接（P3）</span>
          <span class="grow" />
          <AppButton size="sm" variant="ghost" @click="toggleEnabled(server)">
            {{ server.enabled ? '停用' : '启用' }}
          </AppButton>
          <AppButton size="sm" variant="danger" @click="remove(server.name)">删除</AppButton>
        </header>
        <p class="tiny muted mono">
          {{
            server.transport === 'stdio'
              ? `${server.command ?? ''} ${(server.args ?? []).join(' ')}`
              : (server.url ?? '')
          }}
        </p>
        <p v-if="Object.keys(server.envEnc).length > 0" class="tiny muted">
          环境变量：{{ Object.keys(server.envEnc).join('、') }}（值已加密存储）
        </p>
      </article>
      <p v-if="servers.length === 0" class="muted">尚未配置 MCP 服务器。</p>
    </div>

    <div class="divider" />
    <h3>添加服务器</h3>

    <SettingField label="名称" required hint="用于工具命名前缀与状态展示">
      <input v-model="form.name" type="text" spellcheck="false" placeholder="filesystem" />
    </SettingField>
    <SettingField label="传输方式">
      <select v-model="form.transport">
        <option value="stdio">stdio（本地进程）</option>
        <option value="http">streamable-http（远程）</option>
      </select>
    </SettingField>
    <template v-if="form.transport === 'stdio'">
      <SettingField label="命令" required>
        <input v-model="form.command" type="text" spellcheck="false" placeholder="npx" />
      </SettingField>
      <SettingField label="参数" hint="空格分隔">
        <input v-model="form.args" type="text" spellcheck="false" />
      </SettingField>
    </template>
    <SettingField v-else label="URL" required>
      <input
        v-model="form.url"
        type="text"
        spellcheck="false"
        placeholder="https://example.com/mcp"
      />
    </SettingField>
    <SettingField label="环境变量" hint="每行 KEY=VALUE；值会加密存储，不回显">
      <textarea v-model="form.envText" spellcheck="false" placeholder="TOKEN=xxxx" />
    </SettingField>

    <footer class="row">
      <AppButton variant="primary" @click="add">添加</AppButton>
    </footer>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 860px;
}

header h2 {
  margin: 0;
  font-size: 16px;
}

header p {
  margin: 4px 0 0;
  line-height: 1.7;
}

h3 {
  margin: 0;
  font-size: 14px;
}

code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.07);
}

.list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.server {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.03);
}

.server-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.server p {
  margin: 4px 0 0;
  word-break: break-all;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--status-idle);
}

.dot.on {
  background: var(--aurora-green);
}

.dot.off {
  background: var(--status-idle);
}

footer {
  margin-top: var(--space-3);
}
</style>
