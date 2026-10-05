<script setup lang="ts">
/**
 * 首次安装引导（docs/08 §3）：
 *  欢迎 → AI 模型（必填）→ 模式选择 → 模式引导（按所选模式渲染）→ 完成
 *
 * 「模式引导」步骤不是按 guide steps 逐条渲染的对话流，而是表单式 Shortcut：
 * - ClassRoom：感知文件夹 / 科目 / 课前提醒表单（保存即置 guideCompleted）；
 * - Work：工作目录一项（保存即置 guideCompleted，等效其两步对话引导的收集结果）；
 * - 占位模式（code）：无配置项，「下一步」直接通过。
 * 跳过（「稍后设置」）不置 guideCompleted，对话式引导（GuideRunner 驱动）在模式内随时可重跑。
 *
 * 规则：AI 模型未完成不允许进入主界面；测试连接失败允许先保存但持续提示。
 *
 * 版面契约（step-05）：窗口固定 720×560、不可缩放 —— 三段式「进度 + 单步内容 + 底部操作」
 * 必须在这个尺寸内成立：内容区不出现滚动条、不溢出。表单控件一律用共享 `SettingField`，
 * 错误反馈一律用 `AppToast tone="error"`（不在页面里另写内联错误样式）。
 */
import { computed, reactive, ref } from 'vue'
import {
  DEFAULT_REASONING_EFFORT,
  PROVIDER_PRESETS,
  type ModeId,
  type TestConnectionResult,
} from '@aurora/shared/browser'
import AppButton from '../shared/components/AppButton.vue'
import AppToast from '../shared/components/AppToast.vue'
import SettingField from '../shared/components/SettingField.vue'
import StatusDot from '../shared/components/StatusDot.vue'
import { useWindowDrag } from '../shared/composables/useWindowDrag.js'
import { useModeStore, useSettingsStore } from '../shared/stores.js'

const settingsStore = useSettingsStore()
const modeStore = useModeStore()
/** 本窗可拖（docs/07 §1）：拖动条 = `.head`，其中的步骤进度挂 `no-drag` */
const { dragClass, noDragClass } = useWindowDrag('onboarding')

const stepIndex = ref(0)
const steps = ['欢迎', 'AI 模型', '选择模式', '模式设置', '完成'] as const
/** 步骤切换动画方向：与「下一步 / 上一步」一致，两个方向不能用同一个动画 */
const direction = ref<'forward' | 'back'>('forward')

const form = reactive({
  providerId: PROVIDER_PRESETS[0].id as string,
  baseUrl: PROVIDER_PRESETS[0].baseUrl as string,
  model: PROVIDER_PRESETS[0].model as string,
  apiKey: '',
  mode: 'classroom' as ModeId,
  watchDir: '',
  workspaceDir: '',
  subjects: '语文,数学,英语,物理,化学,生物,历史,地理,政治',
  preClassReminder: true,
})

const testing = ref(false)
const testResult = ref<TestConnectionResult | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)

const currentStepLabel = computed(() => steps[stepIndex.value] ?? '')
const transitionName = computed(() => (direction.value === 'forward' ? 'sheet-next' : 'sheet-prev'))
const selectedMode = computed(() => modeStore.modes.find((mode) => mode.id === form.mode) ?? null)
const modelReady = computed(
  () => form.baseUrl.trim() !== '' && form.model.trim() !== '' && form.apiKey.trim() !== '',
)

/** 切到某一步时统一处理方向，避免进/退两个方向共用一个动画 */
function goToStep(index: number, forward: boolean): void {
  direction.value = forward ? 'forward' : 'back'
  stepIndex.value = index
}

function applyPreset(id: string): void {
  const preset = PROVIDER_PRESETS.find((item) => item.id === id)
  if (!preset) return
  form.providerId = preset.id
  form.baseUrl = preset.baseUrl
  form.model = preset.model
  testResult.value = null
}

async function testConnection(): Promise<void> {
  testing.value = true
  testResult.value = null
  error.value = null
  const result = await window.aurora.llm.testConnection({
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    model: form.model,
    withModels: true,
  })
  testing.value = false
  if (result.ok) testResult.value = result.value
  else error.value = result.message
}

async function persistModel(): Promise<boolean> {
  const providerKey = form.providerId.trim() === '' ? 'custom' : form.providerId
  const okSettings = await settingsStore.update({
    llm: {
      active: providerKey,
      providers: {
        ...(settingsStore.settings?.llm.providers ?? {}),
        [providerKey]: {
          type: 'openai-compat',
          baseUrl: form.baseUrl.trim(),
          apiKeyEnc: '',
          model: form.model.trim(),
          // 引导页只确定「当前使用哪个模型」，候选列表留空（用户之后在「设置 → AI 模型」里维护）；
          // 该字段在 `LlmProviderConfig` 里是必填（zod `.default([])` 只放宽输入类型），必须显式给出。
          modelList: [],
          // 生成参数按**模型 id** 键（v23，docs/08 §1）。引导页只确定「当前使用哪个模型」，
          // 参数一律给出厂默认值（用户之后在「设置 → AI 模型 → 模型行内参数」里改）；
          // 三项都写全（别留下半截条目）。
          modelParams:
            form.model.trim() === ''
              ? {}
              : {
                  [form.model.trim()]: {
                    reasoningEffort: DEFAULT_REASONING_EFFORT,
                    // 上下文窗口（v11）：引导页不收集，留 0 = 未知（用户之后在设置页填）
                    contextWindow: 0,
                    // 图片输入（v22，docs/06 §3.1）：引导页不收集，出厂**关**（之后可在设置页开）。
                    // 默认关是刻意的：对不支持视觉的模型发图片分片会被服务端 400，
                    // 引导阶段没有任何地方能提醒用户这件事。
                    vision: false,
                  },
                },
        },
      },
    },
  })
  if (!okSettings) return false

  const secretResult = await window.aurora.settings.setSecrets({
    [`llm.providers.${providerKey}.apiKey`]: form.apiKey.trim(),
  })
  if (!secretResult.ok) {
    error.value = secretResult.message
    return false
  }
  if (!secretResult.value.persisted) {
    error.value = '当前系统未提供安全存储，API Key 只在本次运行中有效（不会写入磁盘）'
  }
  await settingsStore.refreshAppInfo()
  return true
}

async function next(): Promise<void> {
  error.value = null
  if (steps[stepIndex.value] === 'AI 模型') {
    if (!modelReady.value) {
      error.value = 'AI 模型为必填项：请填写 baseURL、API Key 与模型名'
      return
    }
    saving.value = true
    const saved = await persistModel()
    saving.value = false
    if (!saved) return
  }
  if (steps[stepIndex.value] === '选择模式') {
    const changed = await modeStore.setCurrent(form.mode)
    if (!changed) {
      error.value = modeStore.error ?? '模式切换失败'
      return
    }
  }
  goToStep(Math.min(stepIndex.value + 1, steps.length - 1), true)
}

function back(): void {
  error.value = null
  goToStep(Math.max(stepIndex.value - 1, 0), false)
}

async function finishClassroomGuide(): Promise<void> {
  // 表单式引导：直接写入配置并置 guideCompleted（对话式引导在 ClassRoom Mode 内随时可重跑）
  const subjectNames = form.subjects
    .split(/[,，、;；\n]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')

  const updated = await settingsStore.update({
    modes: {
      ...(settingsStore.settings?.modes ?? ({} as never)),
      classroom: {
        ...(settingsStore.settings?.modes.classroom ?? ({} as never)),
        guideCompleted: true,
        watchDir: form.watchDir.trim(),
        subjects:
          subjectNames.length > 0
            ? subjectNames.map((name) => ({
                name,
                folder: `分类/${name}`,
                keywords: [],
              }))
            : (settingsStore.settings?.modes.classroom.subjects ?? []),
        preClassReminder: form.preClassReminder,
      },
    },
  } as never)
  if (!updated) {
    error.value = settingsStore.error ?? '保存模式设置失败'
    return
  }
  await modeStore.load()
  goToStep(steps.length - 1, true)
}

async function finishWorkGuide(): Promise<void> {
  // 表单式引导（Work）：写入工作目录并置 guideCompleted —— 等效其两步对话引导
  // （工作目录问答 + 确认）的收集结果；对话式引导在 Work Mode 内随时可重跑
  const updated = await settingsStore.update({
    modes: {
      ...(settingsStore.settings?.modes ?? ({} as never)),
      work: {
        ...(settingsStore.settings?.modes.work ?? ({} as never)),
        guideCompleted: true,
        workspaceDir: form.workspaceDir.trim(),
      },
    },
  } as never)
  if (!updated) {
    error.value = settingsStore.error ?? '保存模式设置失败'
    return
  }
  await modeStore.load()
  goToStep(steps.length - 1, true)
}

async function complete(): Promise<void> {
  await settingsStore.refreshAppInfo()
  // 常驻入口是提示条（AI 服务窗已移除）；用户关掉了提示条时直接打开交互窗，避免引导结束后没有落脚处
  const edgeBarEnabled = settingsStore.settings?.general.edgeBar.enabled ?? true
  if (edgeBarEnabled) {
    await window.aurora.window.show('edge-bar')
  } else {
    await window.aurora.window.showChat()
  }
  await window.aurora.window.hide('onboarding')
}

/** 跳过模式引导：不置 guideCompleted，对话式引导（GuideRunner）稍后在模式内补跑 */
function skipModeGuide(): void {
  goToStep(steps.length - 1, true)
}

const lastStep = computed(() => steps.length - 1)
/** 「模式引导」步骤有表单可填的模式：ClassRoom / Work（占位模式只有一句说明 + 下一步） */
const hasModeForm = computed(() => form.mode === 'classroom' || form.mode === 'work')
</script>

<template>
  <div class="onboarding glass-surface-strong anim-window">
    <!-- 标题栏：整行可拖动（窗口无系统边框），右侧是步骤圆点进度 -->
    <header class="head glass-bar" :class="dragClass">
      <div class="brand">
        <span class="brand-mark aurora-mark" />
        <div>
          <h1>Aurora</h1>
          <p class="brand-sub">把 Windows 接入 AI 生态 · 首次引导</p>
        </div>
      </div>
      <div class="progress-wrap" :class="noDragClass">
        <ol class="progress">
          <li
            v-for="(step, index) in steps"
            :key="step"
            class="progress-item"
            :class="{ active: index === stepIndex, done: index < stepIndex }"
            :title="step"
          >
            <span class="dot" />
          </li>
        </ol>
        <span class="progress-text">{{ currentStepLabel }}</span>
      </div>
    </header>

    <main class="body anim-pane">
      <transition :name="transitionName" mode="out-in">
        <!-- ① 欢迎 -->
        <section v-if="stepIndex === 0" key="welcome" class="pane">
          <h2 class="pane-title anim-rise">欢迎使用 Aurora</h2>
          <p class="lead anim-rise">
            Aurora 常驻系统托盘，从屏幕右侧的提示条提供服务：悬停展开面板，点击呼出主界面。
            整个引导约 2 分钟。
          </p>
          <div class="cards anim-rise">
            <article class="card">
              <h3>ClassRoom Mode</h3>
              <p class="tiny muted">
                课堂学习：把新文件拖入「智慧感知文件夹」自动归类；课前提醒并打开科目文件夹。
              </p>
            </article>
            <article class="card">
              <h3>Work Mode</h3>
              <p class="tiny muted">
                办公场景：Office 文档 / 表格 / 演示文稿与 PDF 的处理、总结与生成。
              </p>
            </article>
            <article class="card dim">
              <h3>Code Mode</h3>
              <p class="tiny muted">编码场景（建设中）：工作区识别、Git 感知、终端工具组。</p>
            </article>
          </div>
        </section>

        <!-- ② AI 模型（必填） -->
        <section v-else-if="stepIndex === 1" key="llm" class="pane">
          <h2 class="pane-title anim-rise">配置 AI 模型 <span class="badge warn">必填</span></h2>
          <p class="lead anim-rise">支持任何 OpenAI 兼容服务；凭据加密后仅保存在本机。</p>

          <div class="row wrap anim-rise">
            <AppButton
              v-for="preset in PROVIDER_PRESETS"
              :key="preset.id"
              size="sm"
              variant="secondary"
              :class="{ 'preset-active': form.providerId === preset.id }"
              @click="applyPreset(preset.id)"
            >
              {{ preset.label }}
            </AppButton>
          </div>

          <div class="field-grid anim-rise">
            <SettingField label="baseURL" required hint="多数服务需以 /v1 结尾">
              <input
                v-model="form.baseUrl"
                type="text"
                spellcheck="false"
                placeholder="https://api.deepseek.com"
              />
            </SettingField>
            <SettingField label="模型名" required>
              <input
                v-model="form.model"
                type="text"
                spellcheck="false"
                placeholder="deepseek-chat"
              />
            </SettingField>
            <SettingField label="API Key" required hint="仅本机加密存储，不会上传">
              <input
                v-model="form.apiKey"
                type="password"
                spellcheck="false"
                placeholder="sk-..."
              />
            </SettingField>
          </div>

          <div class="row test-row anim-rise">
            <AppButton
              variant="secondary"
              :disabled="testing || !modelReady"
              @click="testConnection"
            >
              <StatusDot v-if="testing" tone="running" :size="8" />
              {{ testing ? '测试中…' : '测试连接' }}
            </AppButton>
            <AppToast v-if="testResult" :tone="testResult.ok ? 'ok' : 'error'">
              {{ testResult.message }}（{{ testResult.latencyMs }}ms）
              <template v-if="testResult.models && testResult.models.length > 0">
                · 可用模型 {{ testResult.models.length }} 个
              </template>
            </AppToast>
          </div>
        </section>

        <!-- ③ 模式选择 -->
        <section v-else-if="stepIndex === 2" key="modes" class="pane">
          <h2 class="pane-title anim-rise">选择使用模式</h2>
          <p class="lead anim-rise">同一时刻只启用一个模式，之后可在设置中随时切换或重新引导。</p>
          <div class="mode-list anim-rise">
            <button
              v-for="mode in modeStore.modes"
              :key="mode.id"
              class="mode-card interactive"
              :class="{ active: form.mode === mode.id, placeholder: mode.placeholder }"
              :aria-pressed="form.mode === mode.id"
              type="button"
              @click="form.mode = mode.id"
            >
              <strong>{{ mode.displayName }}</strong>
              <span v-if="mode.placeholder" class="badge">建设中</span>
              <span v-else-if="mode.id === 'classroom'" class="badge ok">推荐</span>
              <p class="tiny muted">{{ mode.description }}</p>
            </button>
          </div>
        </section>

        <!-- ④ 模式引导（按所选模式渲染，不硬编码 ClassRoom 的步骤数） -->
        <section v-else-if="stepIndex === 3" key="guide" class="pane">
          <h2 class="pane-title anim-rise">{{ selectedMode?.displayName ?? form.mode }} 设置</h2>
          <template v-if="form.mode === 'classroom'">
            <p class="lead anim-rise">
              设置「智慧感知文件夹」与科目列表；也可稍后在对话窗里重新引导。
            </p>
            <div class="anim-rise">
              <SettingField
                label="智慧感知文件夹"
                hint="留空则在首次激活时使用 用户目录\Aurora\感知文件夹"
              >
                <input
                  v-model="form.watchDir"
                  type="text"
                  spellcheck="false"
                  placeholder="D:\Aurora\感知文件夹"
                />
              </SettingField>
              <SettingField label="科目列表" hint="用逗号分隔；每科目标文件夹默认为 分类/<科目>">
                <textarea v-model="form.subjects" spellcheck="false" />
              </SettingField>
              <SettingField label="上课前提醒" hint="课前 5 分钟提醒并打开科目文件夹">
                <input v-model="form.preClassReminder" type="checkbox" />
              </SettingField>
            </div>
          </template>
          <template v-else-if="form.mode === 'work'">
            <p class="lead anim-rise">
              产出文件默认保存到「工作目录」；也可稍后在对话窗里重新引导。
            </p>
            <div class="anim-rise">
              <SettingField
                label="工作目录"
                hint="留空则使用 用户目录\Aurora\工作目录，产出文件默认保存在这里"
              >
                <input
                  v-model="form.workspaceDir"
                  type="text"
                  spellcheck="false"
                  placeholder="D:\Aurora\工作目录"
                />
              </SettingField>
            </div>
          </template>
          <p v-else class="lead anim-rise">该模式目前为占位实现，无需额外配置。</p>
        </section>

        <!-- ⑤ 完成 -->
        <section v-else key="done" class="pane done-pane">
          <span class="brand-mark xl aurora-mark anim-pop" />
          <h2 class="pane-title anim-rise">一切就绪</h2>
          <p class="lead anim-rise">
            Aurora 已常驻系统托盘。默认模型：<strong>{{
              settingsStore.activeProvider?.model ?? '未配置'
            }}</strong>
            ；当前模式：<strong>{{ modeStore.current?.displayName ?? form.mode }}</strong
            >。
          </p>
          <p class="tiny muted anim-rise">
            提示：提示条悬停展开面板，点击呼出主界面；托盘右键可切换模式与打开设置。
          </p>
        </section>
      </transition>
    </main>

    <!-- 底部操作：左为反馈区，右侧主按钮是视觉锚点 -->
    <footer class="foot glass-bar">
      <div class="grow foot-note">
        <AppToast v-if="error" tone="error">{{ error }}</AppToast>
        <AppToast v-else-if="!settingsStore.cryptoAvailable" tone="warn">
          系统安全存储不可用：API Key 只在本次运行中有效，不会写入磁盘。
        </AppToast>
        <AppToast v-else-if="testResult && !testResult.ok" tone="warn">
          连接测试未通过，可先继续，稍后在设置中修正。
        </AppToast>
        <span v-else class="tiny muted">步骤 {{ stepIndex + 1 }} / {{ steps.length }}</span>
      </div>
      <AppButton
        v-if="stepIndex > 0 && stepIndex < lastStep"
        variant="ghost"
        class="press"
        @click="back"
        >上一步</AppButton
      >
      <AppButton
        v-if="stepIndex === 3 && hasModeForm"
        variant="ghost"
        class="press"
        @click="skipModeGuide"
      >
        稍后设置
      </AppButton>
      <AppButton
        v-if="stepIndex === 3 && form.mode === 'classroom'"
        variant="primary"
        size="lg"
        class="press"
        :disabled="saving"
        @click="finishClassroomGuide"
      >
        保存并继续
      </AppButton>
      <AppButton
        v-else-if="stepIndex === 3 && form.mode === 'work'"
        variant="primary"
        size="lg"
        class="press"
        :disabled="saving"
        @click="finishWorkGuide"
      >
        保存并继续
      </AppButton>
      <AppButton
        v-else-if="stepIndex < lastStep"
        variant="primary"
        size="lg"
        class="press"
        :disabled="saving"
        @click="next"
      >
        <StatusDot v-if="saving" tone="running" :size="8" />
        {{ saving ? '保存中…' : '下一步' }}
      </AppButton>
      <AppButton v-else variant="primary" size="lg" class="press anim-rise" @click="complete"
        >开始使用</AppButton
      >
    </footer>
  </div>
</template>

<style scoped>
.onboarding {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background-color: var(--glass-surface-strong);
}

/* ───────── 顶部：拖动区 + 步骤圆点进度 ───────── */

.head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-height: var(--space-8);
  padding: var(--space-3) var(--space-6);
  border-bottom: 1px solid var(--border-subtle);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.brand h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
}

.brand-sub {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.brand-mark {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 9px;
}

.brand-mark.xl {
  width: var(--space-8);
  height: var(--space-8);
  border-radius: var(--radius-lg);
}

.progress-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-left: auto;
  white-space: nowrap;
}

.progress {
  display: flex;
  align-items: center;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.progress-item {
  display: flex;
  align-items: center;
}

/* 已完成 → 当前 → 未开始之间的连接线，纯装饰 */
.progress-item + .progress-item::before {
  content: '';
  display: block;
  width: 18px;
  height: 1px;
  background: var(--border-subtle);
}

.dot {
  display: block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--fill-2);
  transition:
    background var(--transition-fast),
    transform var(--transition-fast);
}

.progress-item.done .dot {
  background: var(--text-muted);
}

.progress-item.active .dot {
  background: var(--aurora-blue);
  transform: scale(1.3);
  box-shadow: 0 0 0 4px var(--fill-1);
}

.progress-text {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

/* ───────── 中部：单步内容（固定尺寸内不出现滚动条） ───────── */

.body {
  flex: 1;
  min-height: 0;
  padding: var(--space-5) var(--space-6);
  overflow-y: auto;
  overflow-x: hidden;
}

.pane {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.pane-title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-display);
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
  line-height: var(--leading-tight);
}

.lead {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
}

.cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
}

.card,
.mode-card {
  padding: var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border-soft);
  background: var(--glass-surface);
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    var(--shadow-hairline);
  text-align: left;
}

.card h3,
.mode-card strong {
  margin: 0 0 var(--space-2);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
}

.card p {
  margin: 0;
  line-height: var(--leading-relaxed);
}

.card.dim {
  background: transparent;
}

.card.dim h3 {
  color: var(--text-secondary);
}

.mode-list {
  display: grid;
  gap: var(--space-3);
}

.mode-card {
  display: grid;
  grid-template-columns: auto auto 1fr;
  grid-template-areas:
    'title tag spacer'
    'desc desc desc';
  gap: var(--space-1) var(--space-2);
  cursor: pointer;
}

.mode-card strong {
  grid-area: title;
}

.mode-card .badge {
  grid-area: tag;
  justify-self: start;
}

.mode-card p {
  grid-area: desc;
  margin: 0;
  line-height: var(--leading-relaxed);
}

.mode-card:hover {
  background: var(--fill-2);
}

.mode-card.active {
  border-color: var(--aurora-blue);
  background: var(--fill-3);
}

.mode-card.placeholder:not(.active) strong {
  color: var(--text-secondary);
}

.preset-active {
  border-color: var(--aurora-blue);
  background: var(--fill-3);
}

/* AI 模型页：两列栅格，四个字段在两行内排完（固定高度里装得下） */
.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 var(--space-4);
}

/**
 * 两列栅格：标签列压到 120px（够放 baseURL / API Key / 模型名），
 * 说明文字改成跨两列的独立一行 —— 否则在 120px 的列里会折成两三行，把固定高度吃掉。
 */
.field-grid :deep(.field) {
  grid-template-columns: 120px 1fr;
  grid-template-areas:
    'label control'
    'hint hint';
}

/* `.row` 用 theme.css 的全局原子类，这里只补它没有的换行能力 */
.wrap {
  flex-wrap: wrap;
}

.test-row {
  align-items: center;
  min-height: var(--control-h-md);
}

.test-row :deep(.toast) {
  min-width: 0;
  line-height: var(--leading-normal);
}

/* 完成页：品牌渐变 + 居中收束 */
.done-pane {
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  gap: var(--space-5);
}

.done-pane .pane-title {
  font-size: var(--text-2xl);
  background: var(--aurora-gradient);
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.done-pane .lead {
  max-width: 460px;
  font-size: var(--text-base);
}

.done-pane .tiny {
  margin: 0;
  max-width: 460px;
  line-height: var(--leading-relaxed);
}

/* ───────── 步骤切换：方向与操作一致（下一步 = 从右侧滑入） ───────── */

.sheet-next-enter-active,
.sheet-prev-enter-active {
  transition:
    opacity var(--dur-base) var(--ease-standard),
    transform var(--dur-base) var(--ease-smooth);
}

.sheet-next-leave-active,
.sheet-prev-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-smooth);
}

.sheet-next-enter-from,
.sheet-prev-leave-to {
  opacity: 0;
  transform: translateX(28px);
}

.sheet-next-leave-to,
.sheet-prev-enter-from {
  opacity: 0;
  transform: translateX(-28px);
}

/* ───────── 底部操作 ───────── */

.foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--space-8);
  padding: var(--space-3) var(--space-6);
  border-top: 1px solid var(--border-subtle);
}

.foot-note {
  min-width: 0;
}

/* 底部固定高度：反馈区长文案单行省略，不把页脚撑高 */
.foot-note :deep(.toast) {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
