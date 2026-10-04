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
import { BookOpenText } from '@aurora/shared/browser'

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
    <form class="login-card glass-panel" @submit.prevent="submit">
      <template v-if="!props.embedded">
        <span class="mark" aria-hidden="true">
          <BookOpenText :size="22" :stroke-width="1.7" />
        </span>
        <h1 class="login-title">Aurora Center</h1>
      </template>
      <p class="login-sub">
        {{
          mode === 'login' ? '登录以远程管理你的 Aurora 客户端' : '创建一个新的 Aurora Center 账户'
        }}
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
  place-items: center;
  padding: var(--space-7) var(--space-4);
  min-height: 60vh;
}

.login-wrap.embedded {
  padding: var(--space-4) 0 0;
  min-height: 0;
}

.login-card {
  width: min(380px, 100%);
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
}

.login-wrap.embedded .login-card {
  box-shadow: none;
  padding: 0;
  width: 100%;
  background: transparent;
  border: none;
}

.mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--aurora-gradient);
  color: var(--on-accent);
}

.login-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-2xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
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
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-pill);
  background: var(--aurora-blue);
  color: var(--on-accent);
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
</style>
