<script setup lang="ts">
/**
 * 登录 / 注册页。`embedded` 模式供设备确认页（#/device）内嵌：未登录的用户先在这里
 * 登录或注册，成功后由外层继续授权流程。注册成功返回与登录相同形状，直接进入登录态。
 */
import { ref } from 'vue'
import { login, register } from '../store'

const props = defineProps<{ embedded?: boolean }>()

const mode = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const error = ref('')

/** 后端错误码 → 人话（原始 message 兜底展示） */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes('E_REGISTRATION_DISABLED')) return '注册已关闭，请联系管理员创建账户'
  return raw
}

async function submit(): Promise<void> {
  if (submitting.value) return
  if (!username.value.trim() || !password.value) {
    error.value = '请输入用户名与密码'
    return
  }
  if (mode.value === 'register') {
    if (password.value !== confirmPassword.value) {
      error.value = '两次输入的密码不一致'
      return
    }
  }
  submitting.value = true
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
    submitting.value = false
  }
}

function switchMode(): void {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  error.value = ''
  confirmPassword.value = ''
}
</script>

<template>
  <div class="login-wrap" :class="{ embedded: props.embedded }">
    <form class="card login-card" @submit.prevent="submit">
      <h1 v-if="!props.embedded" class="login-title">Aurora Center</h1>
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
        />
      </label>
      <label v-if="mode === 'register'" class="field">
        <span class="field-label">确认密码</span>
        <input
          v-model="confirmPassword"
          class="input"
          type="password"
          autocomplete="new-password"
          placeholder="再输入一次密码"
        />
      </label>
      <p v-if="error" class="form-error">{{ error }}</p>
      <button class="btn btn-primary btn-block" type="submit" :disabled="submitting">
        <span v-if="submitting" class="spinner spinner-sm spinner-light"></span>
        <span>{{
          submitting
            ? mode === 'login'
              ? '登录中…'
              : '注册中…'
            : mode === 'login'
              ? '登录'
              : '注册'
        }}</span>
      </button>
      <button class="btn btn-ghost btn-block mode-switch" type="button" @click="switchMode">
        {{ mode === 'login' ? '没有账户？注册一个' : '已有账户？返回登录' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

/* 设备确认页内嵌：不铺满整屏，卡片随内容收缩 */
.login-wrap.embedded {
  min-height: 0;
  padding: 0;
}

.login-card {
  width: 360px;
  max-width: 100%;
  padding: 32px 28px;
}

.login-title {
  margin: 0 0 4px;
  font-size: 22px;
  text-align: center;
}

.login-sub {
  margin: 0 0 22px;
  text-align: center;
  color: var(--text-2);
  font-size: 13px;
}

.field {
  display: block;
  margin-bottom: 14px;
}

.field-label {
  display: block;
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 6px;
}

.mode-switch {
  margin-top: 10px;
}

@media (max-width: 480px) {
  .login-card {
    padding: 24px 20px;
  }
}
</style>
