<script setup lang="ts">
/**
 * 提醒设置页（v37，v38 扩展；2026-10-25 聚合定时提醒与勿扰时段；docs/07 §4、docs/08 §6/§6.1）。
 *
 * Aurora 所有提醒相关配置的集中入口，全部即时生效：
 * 1. **提醒走哪条通道**（`notifications.channel`）—— 系统通知 / 流光提醒 / 两者 / 不打扰；
 * 2. **流光提醒长什么样、多大声、留多久**（`sound` / `volume` / `speak` / `size` / `durationMs`）；
 * 3. **定时提醒**：自动化总开关（`automations.enabled`）+ 课前提醒三件套
 *    （`modes.classroom.preClass*`，与「模式」页 / 主界面自动化页同一字段；
 *    门控按 docs/08 §6.1 —— 非 ClassRoom 模式或课表无节次时控件不进 DOM，换 `data-empty` 说明）；
 * 4. **勿扰时段**（`advanced.quietHours`，与「通用」页同一字段与保存语义）。
 *
 * 语义边界（也写进页面文案）：`sound` / `speak` 是**总闸** —— 关掉之后连请求级
 * `sound: true` / `speak: true` 也不会越过；开着时请求级仍可让某一条静音 / 不读。
 * `channel` 只管 Aurora 自己发起的提醒；`notify_banner` 与插件 `ctx.banner` 是显式请求流光，
 * 但同样受这两个总闸约束（用户关了提示音就是不想被吵）。
 *
 * 写盘注意：`settings:update` 是**顶层浅合并**，`modes` / `advanced` 必须回传完整子树
 * （丢子树 = 静默丢字段，同主界面自动化页 `BUILTIN_SETTING_KEYS` 的口径）。
 */
import { computed, ref } from 'vue'
import type { BannerCardSize, NotificationTestResult, ReminderChannel } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
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

const SIZES: ReadonlyArray<{ value: BannerCardSize; label: string }> = [
  { value: 'compact', label: '紧凑' },
  { value: 'standard', label: '标准' },
  { value: 'large', label: '宽大' },
]

/** 停留时长的三个常用档（滑杆之外省得一点点拖） */
const DURATIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 4000, label: '4 秒' },
  { value: 6000, label: '6 秒' },
  { value: 10000, label: '10 秒' },
]

const notifications = computed(() => settingsStore.settings?.notifications ?? null)
const channel = computed<ReminderChannel>(() => notifications.value?.channel ?? 'system')
const sound = computed(() => notifications.value?.sound ?? true)
const speak = computed(() => notifications.value?.speak ?? true)
const volume = computed(() => notifications.value?.volume ?? 60)
const size = computed<BannerCardSize>(() => notifications.value?.size ?? 'standard')
const durationMs = computed(() => notifications.value?.durationMs ?? 6000)
/** 只有流光通道才吃这些细节：选系统通知时整块置灰（文案仍可见，免得用户找不到） */
const bannerActive = computed(() => channel.value === 'banner' || channel.value === 'both')

async function save(patch: Partial<NonNullable<typeof notifications.value>>): Promise<void> {
  const current = notifications.value
  if (current === null) return
  const ok = await settingsStore.update({ notifications: { ...current, ...patch } })
  if (!ok) {
    error.value = settingsStore.error
    return
  }
  error.value = null
  message.value = '已保存，下一条提醒立即按新设置生效'
}

// ───────────────────────── 定时提醒（自动化总开关 + 课前提醒三件套） ─────────────────────────

const modes = computed(() => settingsStore.settings?.modes ?? null)
const classroom = computed(() => modes.value?.classroom ?? null)
/** 门控与 docs/08 §6.1 一致：非 ClassRoom 模式或课表无节次时控件不进 DOM（换 data-empty 说明） */
const preClassReady = computed(
  () => modes.value?.current === 'classroom' && (classroom.value?.schedule.lessons.length ?? 0) > 0,
)
const preClassEmptyText = computed(() =>
  modes.value?.current === 'classroom'
    ? '先在「模式」页的课程表里添加节次，才能在这里配置课前提醒。'
    : '切换到 ClassRoom 模式并配置课程表后，就能在这里设置课前提醒。',
)
const automationsEnabled = computed(() => settingsStore.settings?.automations.enabled ?? true)

async function saveAutomations(enabled: boolean): Promise<void> {
  const current = settingsStore.settings?.automations
  if (current === undefined) return
  const ok = await settingsStore.update({ automations: { ...current, enabled } })
  if (!ok) {
    error.value = settingsStore.error
    return
  }
  error.value = null
  message.value = '已保存'
}

async function saveClassroom(patch: {
  preClassReminder?: boolean
  preClassLeadMinutes?: number
  preClassOpenFolder?: boolean
}): Promise<void> {
  const currentModes = modes.value
  const currentClassroom = classroom.value
  if (currentModes === null || currentClassroom === null) return
  const ok = await settingsStore.update({
    modes: { ...currentModes, classroom: { ...currentClassroom, ...patch } },
  })
  if (!ok) {
    error.value = settingsStore.error
    return
  }
  error.value = null
  message.value = '已保存，下一次课前提醒立即按新设置生效'
}

// ───────────────────────── 勿扰时段（advanced.quietHours） ─────────────────────────

const quietStart = computed(() => settingsStore.settings?.advanced?.quietHours?.start ?? '')
const quietEnd = computed(() => settingsStore.settings?.advanced?.quietHours?.end ?? '')

/** 保存语义与「通用」页同一份：留空 = 不启用；只填开始时结束时间按默认「07:00」补全 */
async function saveQuiet(which: 'start' | 'end', value: string): Promise<void> {
  const current = settingsStore.settings?.advanced ?? null
  if (current === null) return
  let next: { start: string; end: string } | null
  if (which === 'start') {
    const start = value.trim()
    next = start === '' ? null : { start, end: current.quietHours?.end ?? '07:00' }
  } else {
    const end = value.trim()
    next = current.quietHours?.start ? { start: current.quietHours.start, end } : null
  }
  const ok = await settingsStore.update({ advanced: { ...current, quietHours: next } })
  if (!ok) {
    error.value = settingsStore.error
    return
  }
  error.value = null
  message.value = '已保存'
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
      <p class="page-sub">Aurora 全部提醒相关设置：默认方式、流光样式、课前提醒与勿扰时段。</p>
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
          @click="save({ channel: item.value })"
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

    <section
      class="section-card"
      :class="{ dormant: !bannerActive }"
      data-field="notifications.style"
    >
      <h2 class="section-title">流光提醒</h2>
      <p class="section-desc">
        仅对「流光提醒」与「两者都发」生效；关掉声音或朗读后，任何来源都不会再出声。
      </p>

      <SettingField
        data-field="notifications.sound"
        label="提示音"
        hint="弹出时播两声轻提示音，与系统提示音互不影响"
      >
        <input
          type="checkbox"
          :checked="sound"
          :disabled="!bannerActive"
          @change="save({ sound: ($event.target as HTMLInputElement).checked })"
        />
      </SettingField>

      <SettingField
        data-field="notifications.volume"
        label="音量"
        hint="提示音与语音播报共用；0 等于静音"
      >
        <div class="volume-row">
          <input
            class="volume-range"
            type="range"
            min="0"
            max="100"
            step="5"
            :value="volume"
            :disabled="!bannerActive || !sound"
            @change="save({ volume: Number(($event.target as HTMLInputElement).value) })"
          />
          <span class="tiny muted mono volume-value">{{ volume }}%</span>
        </div>
      </SettingField>

      <SettingField
        data-field="notifications.speak"
        label="语音朗读"
        hint="朗读标题与正文；未配置 TTS 时自动跳过"
      >
        <input
          type="checkbox"
          :checked="speak"
          :disabled="!bannerActive"
          @change="save({ speak: ($event.target as HTMLInputElement).checked })"
        />
      </SettingField>

      <SettingField
        data-field="notifications.size"
        label="弹窗大小"
        hint="卡片宽度；正文越长越适合宽一档"
      >
        <div class="seg-row" role="radiogroup" aria-label="弹窗大小">
          <button
            v-for="item in SIZES"
            :key="item.value"
            type="button"
            class="seg-option"
            :class="{ active: size === item.value }"
            :aria-pressed="size === item.value"
            :data-field="`notifications.size.${item.value}`"
            :disabled="!bannerActive"
            @click="save({ size: item.value })"
          >
            {{ item.label }}
          </button>
        </div>
      </SettingField>

      <SettingField
        data-field="notifications.durationMs"
        label="停留时长"
        hint="到点自动淡出；点卡片可随时关闭"
      >
        <div class="duration-row">
          <button
            v-for="item in DURATIONS"
            :key="item.value"
            type="button"
            class="seg-option"
            :class="{ active: durationMs === item.value }"
            :aria-pressed="durationMs === item.value"
            :data-field="`notifications.duration.${item.value}`"
            :disabled="!bannerActive"
            @click="save({ durationMs: item.value })"
          >
            {{ item.label }}
          </button>
          <input
            class="duration-range"
            type="range"
            min="2000"
            max="30000"
            step="1000"
            :value="durationMs"
            :disabled="!bannerActive"
            @change="save({ durationMs: Number(($event.target as HTMLInputElement).value) })"
          />
          <span class="tiny muted mono duration-value">{{ Math.round(durationMs / 1000) }} 秒</span>
        </div>
      </SettingField>
    </section>

    <section class="section-card" data-field="notifications.schedule">
      <h2 class="section-title">定时提醒</h2>
      <p class="section-desc">自动化总开关与课前提醒；课前提醒需 ClassRoom 模式并已配置课程表。</p>

      <SettingField
        data-field="automations.enabled"
        label="自动化总开关"
        hint="关闭后所有自动化暂停评估，含课前提醒与自建任务"
      >
        <input
          type="checkbox"
          :checked="automationsEnabled"
          @change="saveAutomations(($event.target as HTMLInputElement).checked)"
        />
      </SettingField>

      <template v-if="preClassReady && classroom !== null">
        <SettingField
          data-field="modes.classroom.preClassReminder"
          label="课前提醒"
          hint="按上方默认提醒方式投递；勿扰时段内静默跳过"
        >
          <input
            type="checkbox"
            :checked="classroom.preClassReminder"
            @change="
              saveClassroom({ preClassReminder: ($event.target as HTMLInputElement).checked })
            "
          />
        </SettingField>

        <SettingField
          data-field="modes.classroom.preClassLeadMinutes"
          label="提前分钟数"
          hint="1～30 分钟，改完即时生效；设得太大时多节课会同时提醒"
        >
          <input
            class="input"
            type="number"
            min="1"
            max="30"
            step="1"
            :value="classroom.preClassLeadMinutes ?? 5"
            @change="
              saveClassroom({
                preClassLeadMinutes: Math.min(
                  30,
                  Math.max(1, Math.round(Number(($event.target as HTMLInputElement).value) || 5)),
                ),
              })
            "
          />
        </SettingField>

        <SettingField
          data-field="modes.classroom.preClassOpenFolder"
          label="自动打开科目文件夹"
          hint="课前提醒时同时打开对应科目文件夹；关闭后只发提醒"
        >
          <input
            type="checkbox"
            :checked="classroom.preClassOpenFolder"
            @change="
              saveClassroom({ preClassOpenFolder: ($event.target as HTMLInputElement).checked })
            "
          />
        </SettingField>
      </template>
      <p v-else class="section-desc" data-empty="modes.classroom.preClassReminder">
        {{ preClassEmptyText }}
      </p>
    </section>

    <section class="section-card" data-field="notifications.quiet">
      <h2 class="section-title">勿扰时段</h2>
      <p class="section-desc">
        只拦主动打扰（课前提醒、敏感工具确认），两端都填才生效；与「通用」页是同一份设置。
      </p>

      <SettingField
        data-field="advanced.quietHours.start"
        label="勿扰时段开始"
        hint="格式 HH:mm；留空表示不启用"
      >
        <input
          class="input"
          type="text"
          spellcheck="false"
          placeholder="22:30"
          :value="quietStart"
          @change="saveQuiet('start', ($event.target as HTMLInputElement).value)"
        />
      </SettingField>

      <SettingField data-field="advanced.quietHours.end" label="勿扰时段结束">
        <input
          class="input"
          type="text"
          spellcheck="false"
          placeholder="07:00"
          :value="quietEnd"
          @change="saveQuiet('end', ($event.target as HTMLInputElement).value)"
        />
      </SettingField>
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
/* 区组圆角 / 投影统一由 settings.css 提供。 */
.channel-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 选项行：左侧圆点表示单选。**未选中不画框**（4 个选项都描边就是一摞盒子），
 * hover 用分层填充，选中态才浮出强调色描边 + 填充。 */
.channel-option {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);
}

.channel-option:hover {
  background: var(--fill-1);
}

.channel-option.active {
  background: var(--fill-2);
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

/* 非流光通道时整块「样式 / 声音」置灰，但仍可读（告诉用户这些项存在） */
.dormant :is(input, button) {
  opacity: 0.5;
}

.volume-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 220px;
}

.volume-range {
  flex: 1;
  min-width: 120px;
  accent-color: var(--aurora-blue);
}

.volume-value,
.duration-value {
  flex: none;
  min-width: 48px;
  text-align: right;
  font-variant-numeric: var(--num-tabular);
}

.seg-row {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--fill-1);
}

/* 分段控件：与「通用 → 外观 → 主题」同一套形状与状态色 */
.seg-option {
  min-height: 28px;
  padding: 0 var(--space-3);
  border-radius: calc(var(--radius-sm) - 2px);
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--text-sm);
}

.seg-option:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.seg-option.active {
  background: var(--bg-overlay);
  color: var(--text-primary);
  box-shadow: var(--shadow-hairline);
}

.duration-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.duration-range {
  width: 160px;
  accent-color: var(--aurora-blue);
}
</style>
