<script setup lang="ts">
/**
 * 登录 / 注册卡片（docs/12 §3）。
 *
 * `embedded` 为真时去掉页级标题与外壳，供设备授权页内嵌（docs/12 §4.3：未登录先登录）。
 * 注册成功即登录（服务器返回与 login 同形状）；注册关闭时服务器回 403 + 提示码，
 * 这里翻译成一句人话。
 */
import { ref } from 'vue'
import { login, register } from '../state'
import { BookOpenText, MonitorSmartphone, ShieldCheck } from '@aurora/shared/browser'

const props = defineProps<{ embedded?: boolean }>()

const mode = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)

function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes('E_REGISTRATION_DISABLED')) return '注册已关闭，请联系管理员创建账户'
  return raw
}

async function submit(): Promise<void> {
  if (busy.value) return
  if (username.value.trim() === '' || password.value === '') {
    error.value = '请输入用户名与密码'
    return
  }
  if (mode.value === 'register') {
    if (password.value.length < 6) {
      error.value = '密码至少 6 位'
      return
    }
    if (password.value !== confirm.value) {
      error.value = '两次输入的密码不一致'
      return
    }
  }
  busy.value = true
  error.value = ''
  try {
    if (mode.value === 'login') {
      await login(username.value.trim(), password.value)
    } else {
      await register(username.value.trim(), password.value)
    }
  } catch (err) {
    error.value = err instanceof Error ? describeError(err) : '操作失败，请稍后重试'
  } finally {
    busy.value = false
  }
}

function switchMode(): void {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  error.value = ''
}
</script>

<template>
  <div class="login-wrap" :class="{ embedded: props.embedded }" data-panel="login">
    <section v-if="!props.embedded" class="login-intro">
      <p class="login-kicker">AURORA CONTROL PLANE</p>
      <h1>把设备状态、远程会话与自动化放在一张工作台上。</h1>
      <p>
        Center 只负责建立通道。真实文件、终端与项目边界仍在每一台装有 Aurora 的 Windows
        客户端上执行。
      </p>
      <div class="login-points">
        <span><MonitorSmartphone :size="17" :stroke-width="1.7" />远程查看在线设备</span>
        <span><BookOpenText :size="17" :stroke-width="1.7" />回放会话过程与结果</span>
        <span><ShieldCheck :size="17" :stroke-width="1.7" />白名单配置与敏感确认</span>
      </div>
    </section>

    <form class="login-card glass-panel" @submit.prevent="submit">
      <template v-if="!props.embedded">
        <p class="login-card-kicker">WELCOME BACK</p>
        <h2 class="login-title">登录控制台</h2>
      </template>
      <p class="login-sub">
        {{ mode === 'login' ? '使用 Center 账号继续。' : '创建一个新的 Aurora Center 账户。' }}
      </p>

      <label class="field">
        <span class="field-label">用户名</span>
        <input
          v-model="username"
          class="input"
          type="text"
          autocomplete="username"
          placeholder="用户名"
          data-field="login.username"
        />
      </label>

      <label class="field">
        <span class="field-label">密码</span>
        <input
          v-model="password"
          class="input"
          type="password"
          :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
          :placeholder="mode === 'login' ? '密码' : '密码（至少 6 位）'"
          data-field="login.password"
        />
      </label>

      <label v-if="mode === 'register'" class="field">
        <span class="field-label">确认密码</span>
        <input
          v-model="confirm"
          class="input"
          type="password"
          autocomplete="new-password"
          placeholder="再输一次密码"
          data-field="login.confirm"
        />
      </label>

      <p v-if="error" class="login-error" data-field="login.error">{{ error }}</p>

      <button class="btn-primary" type="submit" :disabled="busy" data-action="login.submit">
        {{ busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录' }}
      </button>

      <button class="btn-mode" type="button" data-action="login.switch-mode" @click="switchMode">
        {{ mode === 'login' ? '没有账户？注册一个' : '已有账户？返回登录' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-wrap {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(360px, 0.85fr);
  gap: clamp(48px, 8vw, 140px);
  align-items: center;
  min-height: calc(100vh - 64px);
  padding: clamp(56px, 8vw, 110px) clamp(20px, 6vw, 96px);
  background: var(--center-hero-bg);
}

.login-wrap.embedded {
  display: block;
  padding: var(--space-4) 0 0;
  min-height: 0;
  background: transparent;
}

.login-intro {
  max-width: 720px;
}

.login-kicker,
.login-card-kicker {
  margin: 0;
  color: var(--center-signal);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
}

.login-intro h1 {
  margin: 22px 0 0;
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: clamp(38px, 5vw, 68px);
  font-weight: 600;
  line-height: 1.02;
  letter-spacing: -0.05em;
}

.login-intro > p:not(.login-kicker) {
  max-width: 600px;
  margin: 26px 0 0;
  color: var(--text-secondary);
  font-size: var(--text-base);
  line-height: 1.8;
}

.login-points {
  display: grid;
  gap: 0;
  max-width: 540px;
  margin-top: 38px;
  border-top: 1px solid var(--border-subtle);
}

.login-points span {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 54px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.login-points svg {
  color: var(--center-signal);
}

.login-card {
  width: min(420px, 100%);
  justify-self: end;
  padding: clamp(28px, 4vw, 44px);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--center-auth-panel);
  box-shadow: var(--shadow-2);
}

.login-wrap.embedded .login-card {
  justify-self: stretch;
  box-shadow: none;
  padding: 0;
  width: 100%;
  background: transparent;
  border: none;
}

.login-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.04em;
}

.login-sub {
  margin: 0 0 var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field-label {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.input {
  height: var(--control-h-md);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--fill-1);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-base);
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.input:focus {
  outline: none;
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 1px var(--accent-ring);
}

.login-error {
  margin: 0;
  color: var(--danger-text);
  font-size: var(--text-sm);
}

.btn-primary {
  height: var(--control-h-md);
  border: none;
  border-radius: 7px;
  background: var(--center-signal);
  color: var(--center-signal-ink);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  cursor: pointer;
  transition: filter var(--transition-fast);
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.08);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: default;
}

.btn-mode {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
  min-height: var(--control-h-sm);
  border-radius: var(--radius-pill);
  transition: color var(--transition-fast);
}

.btn-mode:hover {
  color: var(--text-primary);
}

@media (max-width: 480px) {
  .input,
  .btn-primary {
    min-height: var(--hit-target);
  }
}

@media (max-width: 900px) {
  .login-wrap {
    grid-template-columns: minmax(0, 1fr);
    min-height: auto;
  }

  .login-intro {
    display: none;
  }

  .login-card {
    justify-self: center;
  }
}
</style>
