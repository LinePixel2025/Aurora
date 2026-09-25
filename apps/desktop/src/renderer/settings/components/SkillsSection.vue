<script setup lang="ts">
/**
 * 技能区组（docs/08 §6）：展示内置 / 用户技能、启用状态与扫描结果。
 * 由原 `SkillsPage.vue` 整体迁入（BetaV2 8 → 6 页，spec §9），锚点与行为原样保留。
 *
 * 信息层次：用户目录 + 扫描操作；技能清单带「已启用 x / 共 y」摘要；
 * `skills.disabled` 列表只在发现技能后才有对象。
 */
import { computed, onMounted, ref } from 'vue'
import type { SkillSummary, SkillsStatus } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const skills = ref<SkillSummary[]>([])
const status = ref<SkillsStatus | null>(null)
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const rescanning = ref(false)

const userDirInput = ref('')

/** 区组折叠状态（默认展开：字段与探针锚点常在 DOM 里） */
const open = ref(true)

const enabledCount = computed(() => skills.value.filter((skill) => skill.enabled).length)

async function load(): Promise<void> {
  const result = await window.aurora.skills.list()
  if (result.ok) skills.value = result.value
  else error.value = result.message
  const current = await window.aurora.skills.status()
  if (current.ok) {
    status.value = current.value
    if (userDirInput.value === '') userDirInput.value = settingsStore.settings?.skills.userDir ?? ''
  }
}

/** 重新扫描（真实重扫磁盘，而不是重新拉一次内存清单） */
async function rescan(): Promise<void> {
  rescanning.value = true
  error.value = null
  message.value = null
  try {
    const result = await window.aurora.skills.rescan()
    if (!result.ok) {
      error.value = result.message
      return
    }
    status.value = result.value
    await load()
    message.value = `已重新扫描：发现 ${result.value.total} 个技能${
      result.value.failed > 0 ? `，${result.value.failed} 个解析失败` : ''
    }`
  } finally {
    rescanning.value = false
  }
}

/** 保存自定义用户技能目录（`skills.userDir`，空串表示用默认目录） */
async function saveUserDir(): Promise<void> {
  const ok = await settingsStore.update({
    skills: {
      userDir: userDirInput.value.trim(),
      disabled: settingsStore.settings?.skills.disabled ?? [],
    },
  })
  if (!ok) {
    error.value = settingsStore.error
    return
  }
  // 目录变更后主进程会重扫；这里再取一次状态把新路径与技能数显示出来
  await rescan()
}

async function toggle(skill: SkillSummary): Promise<void> {
  const disabled = new Set(settingsStore.settings?.skills.disabled ?? [])
  if (skill.enabled) disabled.add(skill.name)
  else disabled.delete(skill.name)
  const ok = await settingsStore.update({
    skills: {
      userDir: settingsStore.settings?.skills.userDir ?? '',
      disabled: [...disabled],
    },
  })
  if (!ok) {
    error.value = settingsStore.error
    return
  }
  await load()
}

async function openDir(): Promise<void> {
  const result = await window.aurora.app.openPath({ kind: 'config' })
  if (!result.ok) error.value = result.message
  else message.value = '已打开用户数据目录：把技能包放到 skills/ 子目录即可'
}

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="group section-card">
    <button class="group-head" type="button" :aria-expanded="open" @click="open = !open">
      <span class="chevron" :class="{ open }" aria-hidden="true">▸</span>
      <span class="section-title">技能（Skill）</span>
      <span class="group-summary tiny muted grow">
        {{ skills.length === 0 ? '未发现' : `已启用 ${enabledCount} / 共 ${skills.length}` }}
      </span>
    </button>

    <Transition name="collapse">
      <div v-if="open" class="group-body">
        <p class="section-desc">
          以 <code class="mono">SKILL.md</code>（YAML frontmatter + 指令正文）描述的可复用能力包，
          存放于内置 <code class="mono">skills/</code> 与用户技能目录。 模型按描述自动匹配并调用
          <code class="mono">use_skill</code> 读取指令；也可在输入框用
          <code class="mono">/技能名</code> 或 <code class="mono">@技能名</code> 显式调用。
        </p>

        <AppToast v-if="error" tone="error">{{ error }}</AppToast>
        <AppToast v-if="message" tone="ok">{{ message }}</AppToast>

        <SettingField
          data-field="skills.userDir"
          label="用户技能目录"
          :hint="
            status
              ? `留空 = 使用默认目录 ｜ 当前生效：${status.userDir}${
                  status.scannedAt
                    ? ` · 上次扫描：${new Date(status.scannedAt).toLocaleString()}`
                    : ''
                }`
              : '留空 = 使用默认目录（用户数据目录 / skills）'
          "
        >
          <div class="row grow">
            <input
              v-model="userDirInput"
              class="input"
              type="text"
              spellcheck="false"
              placeholder="留空使用默认目录"
            />
            <AppButton size="sm" @click="saveUserDir">保存</AppButton>
          </div>
        </SettingField>

        <div class="row">
          <AppButton size="sm" :disabled="rescanning" @click="rescan">
            {{ rescanning ? '扫描中…' : '重新扫描' }}
          </AppButton>
          <AppButton size="sm" variant="ghost" @click="openDir">打开用户技能目录</AppButton>
        </div>

        <AppToast v-if="status && status.warnings.length > 0" tone="warn">
          有 {{ status.warnings.length }} 个技能解析失败，已跳过：
          <span class="tiny muted">{{ status.warnings.slice(0, 3).join('；') }}</span>
        </AppToast>

        <!-- 空状态：没有技能就没有可启停的对象（skills.disabled 不出现） -->
        <p v-if="skills.length === 0" class="empty-inline" data-empty="skills.disabled">
          未发现技能：请确认仓库根目录存在
          <code class="mono">skills/&lt;name&gt;/SKILL.md</code
          >，或在上方配置用户技能目录后重新扫描。
        </p>

        <template v-else>
          <div class="row">
            <h3 class="block-title grow">已发现的技能</h3>
            <span class="badge ok">已启用 {{ enabledCount }}</span>
            <span class="badge">共 {{ skills.length }}</span>
          </div>

          <table class="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>来源</th>
                <th>状态</th>
                <th>适用场景</th>
                <th>脚本</th>
                <th>启用</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="skill in skills" :key="skill.name">
                <td>
                  <strong>{{ skill.name }}</strong>
                  <p class="tiny muted">{{ skill.description }}</p>
                </td>
                <td>
                  <span class="badge">{{ skill.source === 'builtin' ? '内置' : '用户' }}</span>
                </td>
                <td>
                  <span class="badge" :class="skill.enabled ? 'ok' : ''">
                    {{ skill.enabled ? '已启用' : '已停用' }}
                  </span>
                </td>
                <td class="tiny muted">{{ skill.whenToUse ?? '—' }}</td>
                <td class="tiny muted">{{ skill.hasScripts ? 'scripts/' : '—' }}</td>
                <td>
                  <label class="row tiny" :data-field="`skills.disabled.${skill.name}`">
                    <input type="checkbox" :checked="skill.enabled" @change="toggle(skill)" />
                    {{ skill.enabled ? '已启用' : '已停用' }}
                  </label>
                </td>
              </tr>
            </tbody>
          </table>
        </template>
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

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.table th,
.table td {
  padding: var(--space-2) var(--space-3);
  text-align: left;
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: top;
}

.table th {
  color: var(--text-muted);
  font-weight: var(--weight-semibold);
  font-size: var(--text-xs);
  letter-spacing: var(--tracking-eyebrow);
  text-transform: uppercase;
}

.table tbody tr {
  transition: background var(--transition-fast);
}

.table tbody tr:hover {
  background: var(--fill-2);
}

.table :is(.badge, input, code) {
  font-variant-numeric: var(--num-tabular);
}

.table p {
  margin: 2px 0 0;
}

.table tr:last-child td {
  border-bottom: none;
}
</style>
