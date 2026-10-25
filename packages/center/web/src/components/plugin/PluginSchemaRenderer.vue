<script setup lang="ts">
/**
 * 声明式面板渲染器（docs/14 §3.4、docs/15 §6）—— Center 侧副本。
 *
 * ⚠️ 与 `apps/desktop/src/renderer/plugins/PluginSchemaRenderer.vue` **双端同构**：
 * 节点分支、`data-*` 口径与样式令牌必须一致，改动需同步两端；唯一差异是图片 URL
 * 由父级经 `assetUrl` 注入（桌面 `aurora-plugin://`，Center `/p/<id>/<version>/…`）。
 *
 * - **没有 v-html**：所有文本走 `{{ }}`；
 * - 未知节点类型在 schema 校验阶段就被拒（整份不渲染），这里不做「尽量渲染」；
 * - 输入控件把值 emit 给父级（`values[bind]`），按钮把动作 emit 给父级（确认 / 调用由它管）。
 */
import type { PluginUiNode } from '@aurora/shared/browser'
import { cellText, nodeKey } from './pluginSchema'

const props = defineProps<{
  nodes: PluginUiNode[]
  values: Record<string, unknown>
  pluginId: string
  disabled?: boolean
  /** 图片相对路径 → 可加载 URL（Center 从市场包 `/p/` 取） */
  assetUrl: (src: string) => string
}>()

const emit = defineEmits<{
  (event: 'action', node: PluginUiNode): void
  (event: 'update-value', payload: { bind: string; value: unknown }): void
}>()

function childrenOf(node: PluginUiNode): PluginUiNode[] {
  return Array.isArray(node.children) ? node.children : []
}

function valueOf(node: PluginUiNode): unknown {
  const bind = node.bind
  if (bind !== undefined && props.values[bind] !== undefined) return props.values[bind]
  return node.value
}

function textValue(node: PluginUiNode): string {
  const value = valueOf(node)
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function numberValue(node: PluginUiNode): number | undefined {
  const value = valueOf(node)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanValue(node: PluginUiNode): boolean {
  return valueOf(node) === true
}

function selectValue(node: PluginUiNode): string {
  const value = valueOf(node)
  return typeof value === 'string' ? value : ''
}

function pushValue(node: PluginUiNode, value: unknown): void {
  if (node.bind === undefined) return
  emit('update-value', { bind: node.bind, value })
}

function onTextInput(node: PluginUiNode, event: Event): void {
  pushValue(node, (event.target as HTMLInputElement | HTMLTextAreaElement).value)
}

function onNumberInput(node: PluginUiNode, event: Event): void {
  const raw = (event.target as HTMLInputElement).value
  if (raw === '') return
  const parsed = Number(raw)
  if (Number.isFinite(parsed)) pushValue(node, parsed)
}

function onToggle(node: PluginUiNode, event: Event): void {
  pushValue(node, (event.target as HTMLInputElement).checked)
}

function onSelect(node: PluginUiNode, event: Event): void {
  pushValue(node, (event.target as HTMLSelectElement).value)
}

function onButton(node: PluginUiNode): void {
  if (props.disabled === true || node.disabled === true) return
  emit('action', node)
}

function percentOf(node: PluginUiNode): number {
  const value = typeof node.percent === 'number' ? node.percent : 0
  return Math.min(100, Math.max(0, value))
}

function gridStyle(node: PluginUiNode): Record<string, string> {
  const columns = Math.min(4, Math.max(1, node.columnsCount ?? 2))
  return { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
}
</script>

<template>
  <div class="plugin-schema">
    <template v-for="(node, index) in nodes" :key="nodeKey(node, index)">
      <div v-if="node.type === 'stack'" class="node-stack">
        <PluginSchemaRenderer
          :nodes="childrenOf(node)"
          :values="values"
          :plugin-id="pluginId"
          :disabled="disabled"
          :asset-url="assetUrl"
          @action="(child) => emit('action', child)"
          @update-value="(payload) => emit('update-value', payload)"
        />
      </div>

      <div v-else-if="node.type === 'row'" class="node-row">
        <PluginSchemaRenderer
          :nodes="childrenOf(node)"
          :values="values"
          :plugin-id="pluginId"
          :disabled="disabled"
          :asset-url="assetUrl"
          @action="(child) => emit('action', child)"
          @update-value="(payload) => emit('update-value', payload)"
        />
      </div>

      <div v-else-if="node.type === 'grid'" class="node-grid" :style="gridStyle(node)">
        <PluginSchemaRenderer
          :nodes="childrenOf(node)"
          :values="values"
          :plugin-id="pluginId"
          :disabled="disabled"
          :asset-url="assetUrl"
          @action="(child) => emit('action', child)"
          @update-value="(payload) => emit('update-value', payload)"
        />
      </div>

      <section v-else-if="node.type === 'card'" class="node-card">
        <h4 v-if="node.title" class="card-title">{{ node.title }}</h4>
        <PluginSchemaRenderer
          :nodes="childrenOf(node)"
          :values="values"
          :plugin-id="pluginId"
          :disabled="disabled"
          :asset-url="assetUrl"
          @action="(child) => emit('action', child)"
          @update-value="(payload) => emit('update-value', payload)"
        />
      </section>

      <hr v-else-if="node.type === 'divider'" class="node-divider" />

      <h3
        v-else-if="node.type === 'heading'"
        class="node-heading"
        :class="`tone-${node.tone ?? 'default'}`"
      >
        {{ node.text ?? '' }}
      </h3>

      <p
        v-else-if="node.type === 'text'"
        class="node-text"
        :class="`tone-${node.tone ?? 'default'}`"
      >
        {{ node.text ?? '' }}
      </p>

      <span
        v-else-if="node.type === 'badge'"
        class="node-badge"
        :class="`tone-${node.tone ?? 'default'}`"
      >
        {{ node.text ?? '' }}
      </span>

      <div v-else-if="node.type === 'progress'" class="node-progress">
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: `${percentOf(node)}%` }"></div>
        </div>
        <span class="progress-label tiny">{{ Math.round(percentOf(node)) }}%</span>
      </div>

      <img
        v-else-if="node.type === 'image' && (node.src ?? '') !== ''"
        class="node-image"
        :src="assetUrl(node.src ?? '')"
        :alt="node.alt ?? ''"
        loading="lazy"
      />

      <ul v-else-if="node.type === 'list'" class="node-list">
        <li v-for="(item, itemIndex) in node.items ?? []" :key="itemIndex">
          <span :class="`tone-${item.tone ?? 'default'}`">{{ item.label }}</span>
          <span v-if="item.value !== undefined" class="list-value">{{ item.value }}</span>
        </li>
      </ul>

      <div v-else-if="node.type === 'keyValue'" class="node-kv">
        <template v-for="(item, itemIndex) in node.items ?? []" :key="itemIndex">
          <span class="kv-label">{{ item.label }}</span>
          <span class="kv-value" :class="`tone-${item.tone ?? 'default'}`">
            {{ item.value ?? '' }}
          </span>
        </template>
      </div>

      <div v-else-if="node.type === 'table'" class="node-table-wrap">
        <table class="node-table">
          <thead>
            <tr>
              <th v-for="column in node.columns ?? []" :key="column.key">{{ column.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in node.rows ?? []" :key="rowIndex">
              <td v-for="column in node.columns ?? []" :key="column.key">
                {{ cellText(row, column.key) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <button
        v-else-if="node.type === 'button'"
        type="button"
        class="node-button"
        :disabled="disabled === true || node.disabled === true"
        @click="onButton(node)"
      >
        {{ node.text ?? '执行' }}
      </button>

      <label v-else-if="node.type === 'input'" class="node-field">
        <span v-if="node.text" class="field-label">{{ node.text }}</span>
        <input
          type="text"
          :value="textValue(node)"
          :placeholder="node.placeholder ?? ''"
          :disabled="disabled === true || node.disabled === true"
          @input="onTextInput(node, $event)"
        />
      </label>

      <label v-else-if="node.type === 'textarea'" class="node-field">
        <span v-if="node.text" class="field-label">{{ node.text }}</span>
        <textarea
          rows="4"
          :value="textValue(node)"
          :placeholder="node.placeholder ?? ''"
          :disabled="disabled === true || node.disabled === true"
          @input="onTextInput(node, $event)"
        ></textarea>
      </label>

      <label v-else-if="node.type === 'select'" class="node-field">
        <span v-if="node.text" class="field-label">{{ node.text }}</span>
        <select
          :value="selectValue(node)"
          :disabled="disabled === true || node.disabled === true"
          @change="onSelect(node, $event)"
        >
          <option v-for="option in node.options ?? []" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>

      <label v-else-if="node.type === 'toggle'" class="node-toggle">
        <input
          type="checkbox"
          :checked="booleanValue(node)"
          :disabled="disabled === true || node.disabled === true"
          @change="onToggle(node, $event)"
        />
        <span>{{ node.text ?? '' }}</span>
      </label>

      <label v-else-if="node.type === 'number'" class="node-field">
        <span v-if="node.text" class="field-label">{{ node.text }}</span>
        <input
          type="number"
          :value="numberValue(node)"
          :min="node.min"
          :max="node.max"
          :step="node.step"
          :disabled="disabled === true || node.disabled === true"
          @input="onNumberInput(node, $event)"
        />
      </label>

      <label v-else-if="node.type === 'slider'" class="node-field">
        <span v-if="node.text" class="field-label">{{ node.text }}</span>
        <input
          type="range"
          :value="numberValue(node) ?? node.min ?? 0"
          :min="node.min ?? 0"
          :max="node.max ?? 100"
          :step="node.step ?? 1"
          :disabled="disabled === true || node.disabled === true"
          @input="onNumberInput(node, $event)"
        />
      </label>
    </template>
  </div>
</template>

<style scoped>
.plugin-schema {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
}

.node-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.node-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.node-grid {
  display: grid;
  gap: var(--space-2);
}

.node-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
}

.card-title {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.node-divider {
  width: 100%;
  height: 1px;
  border: 0;
  margin: var(--space-1) 0;
  background: var(--border-subtle);
}

.node-heading {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
}

.node-text {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
}

.node-badge {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  font-size: var(--text-xs);
}

.tone-default {
  color: var(--text-primary);
}

.tone-muted {
  color: var(--text-muted);
}

.tone-ok {
  color: var(--ok-text);
}

.tone-warn {
  color: var(--warn-text, var(--text-primary));
}

.tone-error {
  color: var(--error-text);
}

.node-progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.progress-track {
  flex: 1;
  height: 6px;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
}

.progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--aurora-blue);
}

.progress-label {
  color: var(--text-muted);
}

.node-image {
  max-width: 100%;
  border-radius: var(--radius-sm);
}

.node-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-sm);
}

.node-list li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
}

.list-value {
  color: var(--text-secondary);
}

.node-kv {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px var(--space-3);
  font-size: var(--text-sm);
}

.kv-label {
  color: var(--text-muted);
}

.kv-value {
  word-break: break-word;
}

.node-table-wrap {
  overflow-x: auto;
}

.node-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.node-table th,
.node-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-subtle);
  text-align: left;
}

.node-table th {
  color: var(--text-muted);
  font-weight: 500;
}

.node-button {
  align-self: flex-start;
  padding: 5px 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--fill-2);
  color: var(--text-primary);
  font-size: var(--text-sm);
  transition: background var(--transition-fast);
}

.node-button:hover:not(:disabled) {
  background: var(--fill-3);
}

.node-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.node-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.node-field input,
.node-field textarea,
.node-field select {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--text-sm);
}

.node-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.node-toggle input {
  accent-color: var(--aurora-blue);
}
</style>
