<script setup lang="ts">
/**
 * Agent → 技能页（docs/06 §11、docs/08 §6）。
 *
 * 2026-11 Agent 独立栏目：原「Agent 设置」页里的技能区组单独成页。
 * 清单 / 启用开关 / 用户技能目录都在 `SkillsSection`；本页只提供页头与页面级 Toast，
 * 操作回执由子组件经 `notify` 上抛。
 */
import { ref } from 'vue'
import AppToast from '../../shared/components/AppToast.vue'
import SkillsSection from '../components/SkillsSection.vue'

type ToastTone = 'info' | 'warn' | 'error' | 'ok'
type NotifyPayload = { tone: ToastTone; text: string }

const toast = ref<NotifyPayload | null>(null)

function onNotify(payload: NotifyPayload): void {
  toast.value = payload
}
</script>

<template>
  <section class="page page-agent-skills">
    <header>
      <h1 class="page-title">技能</h1>
      <p class="page-sub">以 SKILL.md 描述的能力包，按描述匹配或显式调用。</p>
    </header>

    <AppToast v-if="toast" :tone="toast.tone">{{ toast.text }}</AppToast>

    <SkillsSection @notify="onNotify" />
  </section>
</template>
