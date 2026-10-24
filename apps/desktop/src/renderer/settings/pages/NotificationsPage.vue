<script setup lang="ts">
/**
 * 提醒设置页（v37，docs/07 §4、docs/08 §6.1）。
 *
 * 只做一件事：选择 Aurora 自己发起的提醒走哪条通道（`notifications.channel`）。
 * 四个取值不是"风格"而是**投递去向**：系统通知（可点击打开文件）/ 流光提醒（屏幕顶端
 * 流光 + 置顶卡片）/ 两者都发 / 不打扰（只记日志）。
 *
 * 边界（写在这里也写进 docs/07 §4）：它只管**默认**方式 —— Agent 的 `notify_banner`、
 * 插件 `ctx.banner` 是显式要求流光，不受本页影响。
 */
import { computed, ref } from 'vue'
import type { NotificationTestResult, ReminderChannel } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const testing = ref(false)

/** 选项顺序：从「最传统」到「最安静」，默认项在最前（与出厂值一致） */
const CHANNELS: ReadonlyArray<{
  value: ReminderChannel
  label: string
  description: string
}> = [
  {
    value: 'system',
    label: '系统通知',
    description: '走 Windows 通知中心，点击可打开对应的文件或文件夹。',
  },
  {
    value: 'banner',
    label: '流光提醒',
    description: '屏幕顶端流光加置顶卡片，支持语音朗读与提示音。',
  },
  {
    value: 'both',
    label: '两者都发',
    description: '系统通知负责可点击的入口，流光提醒负责醒目。',
  },
  {
    value: 'off',
    label: '不打扰',
    description: '只写日志、不弹提醒；可能错过分类失败这类结果。',
  },
]

const channel = computed<ReminderChannel>(
  () => settingsStore.settings?.notifications.channel ?? 'system',
)

async function saveChannel(next: ReminderChannel): Promise<void> {
  if (next === channel.value) return
  const settings = settingsStore.settings
  if (settings === null) return
  const ok = await settingsStore.update({
    notifications: { ...settings.notifications, channel: next },
  })
  if (!ok) {
    error.value = settingsStore.error
    return
  }
  error.value = null
  message.value = '已保存，下一条提醒立即按新方式投递'
}

/** 「试一下」：走主进程同一条提醒路由，因此验证的是真实生效路径 */
async function testChannel(): Promise<void> {
  testing.value = true
  message.value = null
  error.value = null
  try {
    const result = await window.aurora.notifications.test()
    if (!result.ok) {
      error.value = result.message
      return
    }
    message.value = describeTest(result.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    testing.value = false
  }
}

function describeTest(result: NotificationTestResult): string {
  if (result.channel === 'off') return '当前是「不打扰」：没有弹出提醒，只写了日志'
  if (!result.delivered) return '没有投递成功：系统通知可能被系统设置关闭了'
  if (result.channel === 'banner') return '已通过流光提醒投递'
  if (result.channel === 'both') return '已同时通过系统通知与流光提醒投递'
  return '已通过系统通知投递'
}
</script>

<template>
  <section class="page" data-field="notifications.page">
    <header>
      <h1 class="page-title">提醒</h1>
      <p class="page-sub">Aurora 的提醒按这里选定的默认方式投递，改完立即生效。</p>
    </header>

    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>

    <section class="section-card">
      <h2 class="section-title">默认提醒方式</h2>
      <p class="section-desc">
        分类完成、课前提醒、引导与 Agent 的通知都按它投递；显式要求流光的地方不受影响。
      </p>

      <div
        class="channel-list"
        role="radiogroup"
        aria-label="默认提醒方式"
        data-field="notifications.channel"
      >
        <button
          v-for="item in CHANNELS"
          :key="item.value"
          type="button"
          class="channel-option"
          :class="{ active: channel === item.value }"
          :aria-pressed="channel === item.value"
          :data-field="`notifications.channel.${item.value}`"
          @click="saveChannel(item.value)"
        >
          <span class="channel-mark" aria-hidden="true" />
          <span class="channel-text">
            <strong>{{ item.label }}</strong>
            <span class="tiny muted">{{ item.description }}</span>
          </span>
        </button>
      </div>

      <p class="tiny muted">
        流光提醒不支持点击打开文件夹：需要那个入口时选「系统通知」或「两者都发」。
      </p>
    </section>

    <section class="section-card">
      <h2 class="section-title">试一下</h2>
      <p class="section-desc">按当前默认方式立刻发一条示例提醒，用来确认设置真的生效。</p>

      <div class="row">
        <AppButton
          size="sm"
          :disabled="testing"
          data-field="notifications.test"
          @click="testChannel"
        >
          {{ testing ? '发送中…' : '发送测试提醒' }}
        </AppButton>
      </div>
    </section>
  </section>
</template>

<style scoped>
.page > .section-card {
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-hairline);
}

.channel-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 选项行：左侧圆点表示单选，选中时整行分层填充 + 强调色描边（不靠颜色深浅单独表达） */
.channel-option {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  text-align: left;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);
}

.channel-option:hover {
  background: var(--fill-2);
}

.channel-option.active {
  background: var(--fill-3);
  border-color: color-mix(in srgb, var(--aurora-blue) 46%, transparent);
}

.channel-mark {
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 3px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: transparent;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.channel-option.active .channel-mark {
  border-color: var(--aurora-blue);
  box-shadow: inset 0 0 0 3px var(--aurora-blue);
}

.channel-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.channel-text strong {
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}
</style>
