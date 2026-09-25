<script setup lang="ts">
/**
 * 技能区组（docs/08 §6）：展示内置 / 用户技能、启用状态与扫描结果。
 * 由原 `SkillsPage.vue` 整体迁入（BetaV2 8 → 6 页，spec §9），锚点与行为原样保留。
 *
 * 2026-09 信息架构收拢（docs/07 §2.5）：默认**收起**（组锚点 `data-group="skills"`，
 * capture 探针先展开再计数）；组头摘要「已启用 x / 共 y」承载状态（收起也能看清）；
 * 技能表 4 列（名称 + 来源徽章 / 适用场景 / 脚本 / 启用），「状态」列与表头双徽章删除
 * （启用 checkbox 即状态）。操作回执不再本地渲染 Toast，统一经 `notify` 事件上抛给
 * 页级 AppToast（本区组默认收起，常驻 Toast 也不可见，更没有本地渲染的理由）。
 */
import { computed, onMounted, ref } from 'vue'
import type { SkillSummary, SkillsStatus } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

type NotifyPayload = { tone: 'info' | 'warn' | 'error' | 'ok'; text: string }

const emit = defineEmits<{
  (event: 'notify', payload: NotifyPayload): void
}>()

const settingsStore = useSettingsStore()
const skills = ref<SkillSummary[]>([])
const status = ref<SkillsStatus | null>(null)
const rescanning = ref(false)

const userDirInput = ref('')

/** 区组折叠状态：默认收起（组头摘要承载状态，docs/07 §2.5） */
const open = ref(false)

const enabledCount = computed(() => skills.value.filter((skill) => skill.enabled).length)

function notify(tone: NotifyPayload['tone'], text: string): void {
  emit('notify', { tone, text })
}

/**
 * 拉取技能清单与扫描状态。`announceWarnings = false` 时不播报解析警告
 * （toggle / 重新扫描后的重拉不必重复提醒，首次进入与目录变更后的提醒已足够；
 * 「已重新扫描」的回执里也带失败计数）。
 */
async function load(announceWarnings = true): Promise<void> {
  const result = await window.aurora.skills.list()
  if (result.ok) skills.value = result.value
  else notify('error', result.message)
  const current = await window.aurora.skills.status()
  if (current.ok) {
    status.value = current.value
    if (userDirInput.value === '') userDirInput.value = settingsStore.settings?.skills.userDir ?? ''
    if (announceWarnings && current.value.warnings.length > 0) {
      notify(
        'warn',
        `有 ${current.value.warnings.length} 个技能解析失败，已跳过：${current.value.warnings
          .slice(0, 3)
          .join('；')}`,
      )
    }
  }
}

/** 重新扫描（真实重扫磁盘，而不是重新拉一次内存清单） */
async function rescan(): Promise<void> {
  rescanning.value = true
  try {
    const result = await window.aurora.skills.rescan()
    if (!result.ok) {
      notify('error', result.message)
      return
    }
    status.value = result.value
    await load(false)
    notify(
      'ok',
      `已重新扫描：发现 ${result.value.total} 个技能${
        result.value.failed > 0 ? `，${result.value.failed} 个解析失败` : ''
      }`,
    )
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
    if (settingsStore.error) notify('error', settingsStore.error)
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
    if (settingsStore.error) notify('error', settingsStore.error)
    return
  }
  await load(false)
}

async function openDir(): Promise<void> {
  const result = await window.aurora.app.openPath({ kind: 'config' })
  if (!result.ok) notify('error', result.message)
  else notify('info', '已打开用户数据目录：把技能包放到 skills/ 子目录即可')
}

onMounted(() => {
  void load()
})
</script>

<template>
  <!-- data-group：capture 探针的组锚点（SETTINGS_AGENT_FIELDS_SCRIPT 据此先展开再计数） -->
  <section class="group section-card" data-group="skills">
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

        <!-- 空状态：没有技能就没有可启停的对象（skills.disabled 不出现） -->
        <p v-if="skills.length === 0" class="empty-inline" data-empty="skills.disabled">
          未发现技能：请确认仓库根目录存在
          <code class="mono">skills/&lt;name&gt;/SKILL.md</code
          >，或在上方配置用户技能目录后重新扫描。
        </p>

        <template v-else>
          <h3 class="block-title">已发现的技能</h3>

          <!-- 4 列（docs/07 §2.5）：来源并入名称列徽章，状态由启用 checkbox + 组头摘要承载 -->
          <table class="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>适用场景</th>
                <th>脚本</th>
                <th>启用</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="skill in skills" :key="skill.name">
                <td>
                  <span class="name-row">
                    <strong>{{ skill.name }}</strong>
                    <span class="badge">{{ skill.source === 'builtin' ? '内置' : '用户' }}</span>
                  </span>
                  <p class="tiny muted">{{ skill.description }}</p>
                </td>
                <td class="tiny muted">{{ skill.whenToUse ?? '—' }}</td>
                <td class="tiny muted">{{ skill.hasScripts ? 'scripts/' : '—' }}</td>
                <td>
                  <label class="row tiny enable-cell" :data-field="`skills.disabled.${skill.name}`">
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

/* 名称列：名称 + 来源徽章同行 */
.name-row {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

/* 启用列：checkbox + 状态词不换行（列窄时会被压成一字一行） */
.enable-cell {
  flex: none;
  white-space: nowrap;
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
  white-space: nowrap;
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
