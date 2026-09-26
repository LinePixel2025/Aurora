<script setup lang="ts">
import { ref } from 'vue'
import { login } from '../store'

const username = ref('')
const password = ref('')
const submitting = ref(false)
const error = ref('')

async function submit(): Promise<void> {
  if (submitting.value) return
  if (!username.value.trim() || !password.value) {
    error.value = '请输入用户名与口令'
    return
  }
  submitting.value = true
  error.value = ''
  try {
    await login(username.value.trim(), password.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '登录失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <form class="card login-card" @submit.prevent="submit">
      <h1 class="login-title">Aurora Center</h1>
      <p class="login-sub">登录以远程管理你的 Aurora 客户端</p>
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
        <span class="field-label">口令</span>
        <input
          v-model="password"
          class="input"
          type="password"
          autocomplete="current-password"
          placeholder="口令"
        />
      </label>
      <p v-if="error" class="form-error">{{ error }}</p>
      <button class="btn btn-primary btn-block" type="submit" :disabled="submitting">
        <span v-if="submitting" class="spinner spinner-sm spinner-light"></span>
        <span>{{ submitting ? '登录中…' : '登录' }}</span>
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
</style>
