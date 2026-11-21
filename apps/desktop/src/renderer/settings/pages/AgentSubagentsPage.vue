<script setup lang="ts">
/**
 * Agent → 子代理页（v46，docs/06 §19.6、docs/07 §2.5、docs/08 §6）。
 *
 * 2026-11 Agent 独立栏目：原「Agent 设置」页里的子代理区组单独成页。
 * 列表 / 字段 / 保存链路都在 `SubagentsSection`（`agent.subagents` 整数组权威），
 * 本页只提供页头、区组卡与页面级 Toast —— 回执由子组件经 `notify` 上抛。
 */
import { computed, ref } from 'vue'
import AppToast from '../../shared/components/AppToast.vue'
import SubagentsSection from '../components/SubagentsSection.vue'
import { useSettingsStore } from '../../shared/stores.js'

type ToastTone = 'info' | 'warn' | 'error' | 'ok'
type NotifyPayload = { tone: ToastTone; text: string }

const settingsStore = useSettingsStore()
const toast = ref<NotifyPayload | null>(null)

/** 区组摘要：启用数 / 总数（扫一眼就知道配了几条） */
const subagentsSummary = computed(() => {
  const list = settingsStore.settings?.agent.subagents ?? []
  const enabled = list.filter((item) => item.enabled).length
  return `${enabled} / ${list.length} 个启用`
})

function onNotify(payload: NotifyPayload): void {
  toast.value = payload
}
</script>

<template>
  <section class="page page-agent-subagents">
    <header>
      <h1 class="page-title">子代理</h1>
      <p class="page-sub">把任务派给带独立模型与工具权限的子代理。</p>
    </header>

    <AppToast v-if="toast" :tone="toast.tone">{{ toast.text }}</AppToast>

    <section class="group section-card">
      <div class="group-head static">
        <span class="section-title">子代理列表</span>
        <span class="group-summary tiny muted grow">{{ subagentsSummary }}</span>
      </div>
      <div class="group-body">
        <SubagentsSection @notify="onNotify" />
      </div>
    </section>
  </section>
</template>
