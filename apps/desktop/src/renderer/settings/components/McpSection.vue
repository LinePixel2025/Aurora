<script setup lang="ts">
/**
 * MCP 区组（docs/06 §7、docs/08 §6）：服务器配置增删改 + **真实连接状态灯**。
 * 由原 `McpPage.vue` 整体迁入（BetaV2 8 → 6 页，spec §9），锚点与行为原样保留。
 *
 * env 凭据通过 settings:setSecrets 加密存储，列表只显示已配置的变量名；
 * `lazyConnect` 收进「高级」折叠；新增服务器表单默认收起（空状态时由主按钮展开）。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { McpServerConfig, McpServerStatus } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import StatusDot from '../../shared/components/StatusDot.vue'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const statuses = ref<McpServerStatus[]>([])
const showAdd = ref(false)
const showAdvanced = ref(false)

/** 区组折叠状态（默认展开：字段与探针锚点常在 DOM 里） */
const open = ref(true)

let offStatus: (() => void) | null = null

onMounted(async () => {
  offStatus = window.aurora.mcp.onStatusChanged((next) => {
    statuses.value = next
  })
  const result = await window.aurora.mcp.status()
  if (result.ok) statuses.value = result.value
})

onUnmounted(() => {
  offStatus?.()
  offStatus = null
})

function statusOf(name: string): McpServerStatus | undefined {
  return statuses.value.find((item) => item.name === name)
}

function stateLabel(status: McpServerStatus | undefined): string {
  if (status === undefined) return '未连接'
  switch (status.state) {
    case 'ready':
      return `已连接 · ${status.toolCount} 个工具`
    case 'connecting':
      return '连接中…'
    case 'error':
      return '连接失败'
    default:
      return status.enabled ? '待连接' : '已停用'
  }
}

/**
 * 状态灯走共享 `StatusDot`（docs/07 §1 的语义色）：灰=闲置 / 蓝=连接中 / 红=失败。
 * `ready` 是文档里的「绿=正常」，而 StatusDot 没有绿色 tone —— 它只有
 * `idle|running|unread|error` 四态，正常态就是基色 `--status-idle`。
 * 因此这里用**内联变量改写基色**（不新增组件、不用 `:deep` 覆盖），
 * 保持状态语义与共享组件一致性。
 */
function statusTone(status: McpServerStatus | undefined): 'idle' | 'running' | 'error' {
  if (status === undefined) return 'idle'
  if (status.state === 'error') return 'error'
  if (status.state === 'connecting') return 'running'
  return 'idle'
}

function statusDotStyle(status: McpServerStatus | undefined): Record<string, string> | undefined {
  if (status?.state === 'ready') return { '--status-idle': 'var(--status-ok)' }
  return undefined
}

const form = reactive({
  name: '',
  transport: 'stdio' as 'stdio' | 'http',
  command: 'npx',
  args: '-y @modelcontextprotocol/server-filesystem D:\\',
  url: '',
  envText: '',
})

const servers = computed<McpServerConfig[]>(() => settingsStore.settings?.mcp.servers ?? [])
const lazyConnect = computed(() => settingsStore.settings?.mcp.lazyConnect ?? false)

/**
 * 该服务器已配置的环境变量名。
 *
 * 数据源必须是主进程补的**只读标记** `envSet`（docs/08 §1.1），不能读 `server.envEnc` ——
 * `settings:get` / `settings:changed` 会把 `envEnc` 一律回传成空对象（密文永不进渲染进程），
 * 按它判断会永远显示成「没有环境变量」。
 */
function envNames(server: McpServerConfig): string[] {
  const marked = (server as McpServerConfig & { envSet?: string[] }).envSet
  return Array.isArray(marked) ? marked : []
}

async function setLazyConnect(value: boolean): Promise<void> {
  error.value = null
  if (!(await settingsStore.update({ mcp: { lazyConnect: value } }))) {
    error.value = settingsStore.error
  }
}

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
  message.value = `已添加 ${name}（连接状态见下方状态灯）`
  form.name = ''
  form.envText = ''
  showAdd.value = false
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
  <section class="group section-card">
    <button class="group-head" type="button" :aria-expanded="open" @click="open = !open">
      <span class="chevron" :class="{ open }" aria-hidden="true">▸</span>
      <span class="section-title">MCP 服务器</span>
      <span class="group-summary tiny muted grow">
        {{ servers.length === 0 ? '未配置' : `${servers.length} 个服务器` }}
      </span>
    </button>

    <Transition name="collapse">
      <div v-if="open" class="group-body">
        <p class="section-desc">
          连接外部工具服务（Model Context Protocol）。工具以
          <code class="mono">mcp.&lt;server&gt;.&lt;tool&gt;</code> 注册进 Agent 工具表；与 Skill
          重名时 MCP 优先。连接失败只影响该服务器，不会阻塞对话。
        </p>

        <AppToast v-if="error" tone="error">{{ error }}</AppToast>
        <AppToast v-if="message" tone="ok">{{ message }}</AppToast>

        <!-- 空状态：没有服务器时不显示 lazyConnect 等无对象的配置项 -->
        <template v-if="servers.length === 0">
          <p class="empty-inline" data-empty="mcp.servers">
            尚未配置 MCP 服务器：添加一个 stdio 本地进程或 HTTP
            端点后，它的工具会自动出现在对话可用工具里。
          </p>
          <div class="row">
            <AppButton variant="primary" @click="showAdd = true">添加服务器</AppButton>
          </div>
        </template>

        <template v-else>
          <!-- 服务器列表：区组内的轻量行卡，行容器标 `mcp.servers.<name>` -->
          <div class="server-list">
            <article
              v-for="server in servers"
              :key="server.name"
              class="server-row"
              :data-field="`mcp.servers.${server.name}`"
            >
              <header class="server-head">
                <StatusDot
                  :tone="statusTone(statusOf(server.name))"
                  :style="statusDotStyle(statusOf(server.name))"
                  :title="stateLabel(statusOf(server.name))"
                />
                <strong class="mono">{{ server.name }}</strong>
                <span class="badge">{{ server.transport }}</span>
                <span class="badge" :class="{ warn: statusOf(server.name)?.state === 'error' }">
                  {{ stateLabel(statusOf(server.name)) }}
                </span>
                <span class="grow" />
                <AppButton size="sm" variant="ghost" @click="toggleEnabled(server)">
                  {{ server.enabled ? '停用' : '启用' }}
                </AppButton>
                <AppButton size="sm" variant="danger" @click="remove(server.name)">删除</AppButton>
              </header>
              <p class="tiny muted mono target">
                {{
                  server.transport === 'stdio'
                    ? `${server.command ?? ''} ${(server.args ?? []).join(' ')}`
                    : (server.url ?? '')
                }}
              </p>
              <p v-if="statusOf(server.name)?.lastError" class="tiny err">
                {{ statusOf(server.name)?.lastError }}
              </p>
              <p v-if="envNames(server).length > 0" class="tiny muted">
                环境变量：{{ envNames(server).join('、') }}（值已加密存储）
              </p>
            </article>
          </div>

          <section class="advanced-block">
            <button
              class="more"
              type="button"
              :aria-expanded="showAdvanced"
              @click="showAdvanced = !showAdvanced"
            >
              <span class="chevron" :class="{ open: showAdvanced }" aria-hidden="true">▸</span>
              高级：连接策略
            </button>
            <Transition name="collapse">
              <div v-if="showAdvanced">
                <SettingField
                  data-field="mcp.lazyConnect"
                  label="懒连接"
                  hint="开启后在首次使用某个 MCP 工具时才连接；关闭则启动即连（默认）"
                >
                  <label class="row tiny">
                    <input
                      type="checkbox"
                      :checked="lazyConnect"
                      @change="setLazyConnect(($event.target as HTMLInputElement).checked)"
                    />
                    <span>首次使用时才连接服务器</span>
                  </label>
                </SettingField>
              </div>
            </Transition>
          </section>

          <div v-if="!showAdd" class="row">
            <AppButton size="sm" @click="showAdd = true">添加服务器</AppButton>
          </div>
        </template>

        <Transition name="collapse">
          <section v-if="showAdd" class="form-block">
            <div class="row">
              <h3 class="block-title grow">添加服务器</h3>
              <AppButton size="sm" variant="ghost" @click="showAdd = false">取消</AppButton>
            </div>

            <SettingField label="名称" required hint="用于工具命名前缀与状态展示">
              <input
                v-model="form.name"
                class="input"
                type="text"
                spellcheck="false"
                placeholder="filesystem"
              />
            </SettingField>
            <SettingField label="传输方式">
              <select v-model="form.transport">
                <option value="stdio">stdio（本地进程）</option>
                <option value="http">streamable-http（远程）</option>
              </select>
            </SettingField>
            <template v-if="form.transport === 'stdio'">
              <SettingField label="命令" required>
                <input
                  v-model="form.command"
                  class="input"
                  type="text"
                  spellcheck="false"
                  placeholder="npx"
                />
              </SettingField>
              <SettingField label="参数" hint="空格分隔">
                <input v-model="form.args" class="input" type="text" spellcheck="false" />
              </SettingField>
            </template>
            <SettingField v-else label="URL" required>
              <input
                v-model="form.url"
                class="input"
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
        </Transition>

        <p class="tiny muted">
          提示：MCP 服务器以你填写的 argv 数组启动，<strong>不经过 shell</strong>；HTTP
          传输暂不支持自定义鉴权头。
        </p>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.block-title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
}

/* 服务器列表容器与行卡：区组内的轻量行（同 provider-row 的观感） */
.server-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.server-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  transition: background var(--transition-fast);
}

.server-row:hover {
  background: var(--fill-2);
}

.server-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.server-head .badge {
  font-variant-numeric: var(--num-tabular);
}

.target {
  margin: 0;
  word-break: break-all;
}

/* 「高级：连接策略」折叠块 */
.advanced-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.more {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--control-h-sm);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  transition: color var(--transition-fast);
}

.more:hover {
  color: var(--text-primary);
}

.err {
  margin: 0;
  color: var(--status-error);
}
</style>
