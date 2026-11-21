<script setup lang="ts">
/**
 * Agent → MCP 服务器页（docs/06 §7、docs/08 §6）。
 *
 * 2026-11 Agent 独立栏目：原「Agent 设置」页里的 MCP 区组单独成页。
 * 服务器增删改 / 连接状态灯 / 凭据链路都在 `McpSection`；本页只提供页头与页面级 Toast，
 * 操作回执由子组件经 `notify` 上抛。
 */
import { ref } from 'vue'
import AppToast from '../../shared/components/AppToast.vue'
import McpSection from '../components/McpSection.vue'

type ToastTone = 'info' | 'warn' | 'error' | 'ok'
type NotifyPayload = { tone: ToastTone; text: string }

const toast = ref<NotifyPayload | null>(null)

function onNotify(payload: NotifyPayload): void {
  toast.value = payload
}
</script>

<template>
  <section class="page page-agent-mcp">
    <header>
      <h1 class="page-title">MCP 服务器</h1>
      <p class="page-sub">连接外部 MCP 服务器，把它们的工具接进 Agent。</p>
    </header>

    <AppToast v-if="toast" :tone="toast.tone">{{ toast.text }}</AppToast>

    <McpSection @notify="onNotify" />
  </section>
</template>
