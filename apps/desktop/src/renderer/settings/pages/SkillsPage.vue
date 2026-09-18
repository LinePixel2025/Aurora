<script setup lang="ts">
/** Skill 管理页（docs/08 §6）：展示内置 / 用户技能与启用状态；执行能力在 P3 接入。 */
import { onMounted, ref } from 'vue'
import type { SkillSummary } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const skills = ref<SkillSummary[]>([])
const error = ref<string | null>(null)
const message = ref<string | null>(null)

async function load(): Promise<void> {
  const result = await window.aurora.skills.list()
  if (result.ok) skills.value = result.value
  else error.value = result.message
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
  <section class="page">
    <header>
      <h2>Skill</h2>
      <p class="tiny muted">
        以 <code class="mono">SKILL.md</code>（YAML frontmatter + 指令正文）描述的可复用能力包，
        存放于内置 <code class="mono">skills/</code> 与用户目录
        <code class="mono">&lt;userData&gt;/skills/</code>。 解析、清单与提示词注入已在 P1
        落地；自动匹配与执行脚本在 P3 接入。
      </p>
    </header>

    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>

    <div class="row">
      <AppButton size="sm" @click="load">重新扫描</AppButton>
      <AppButton size="sm" variant="ghost" @click="openDir">打开用户技能目录</AppButton>
    </div>

    <p v-if="skills.length === 0" class="muted">
      未发现技能。请确认仓库根目录存在 <code class="mono">skills/&lt;name&gt;/SKILL.md</code>。
    </p>

    <table v-else class="table">
      <thead>
        <tr>
          <th>名称</th>
          <th>来源</th>
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
          <td class="tiny muted">{{ skill.whenToUse ?? '—' }}</td>
          <td class="tiny muted">{{ skill.hasScripts ? 'scripts/' : '—' }}</td>
          <td>
            <label class="row tiny">
              <input type="checkbox" :checked="skill.enabled" @change="toggle(skill)" />
              {{ skill.enabled ? '已启用' : '已停用' }}
            </label>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 900px;
}

header h2 {
  margin: 0;
  font-size: 16px;
}

header p {
  margin: 4px 0 0;
  line-height: 1.7;
}

code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.07);
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.table th,
.table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: top;
}

.table th {
  color: var(--text-muted);
  font-weight: 500;
  font-size: 12px;
}

.table p {
  margin: 2px 0 0;
}
</style>
