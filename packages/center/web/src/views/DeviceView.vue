<script setup lang="ts">
/**
 * 设备确认页（docs/12 §4.3）：客户端点「登录账户」后打开 `#/device?code=<userCode>`。
 * 流程：userCode → GET /api/client/device/info 换 deviceCode（无需登录）→ 登录态下
 * 批准 / 拒绝 → POST /api/client/device/authorize → 客户端轮询自动拿到令牌。
 * 未登录时先内嵌登录 / 注册表单，成功后自动回到确认流程。
 */
import { onMounted, ref } from 'vue'
import { ApiError, api } from '../api'
import { formatTime } from '../format'
import { currentUser } from '../store'
import LoginView from './LoginView.vue'

type Phase = 'loading' | 'ready' | 'invalid' | 'approved' | 'denied'

const phase = ref<Phase>('loading')
const userCode = ref('')
const deviceCode = ref('')
const expiresAt = ref('')
const busy = ref(false)
const error = ref('')

onMounted(() => {
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  userCode.value = (query.get('code') ?? '').trim()
  if (!userCode.value) {
    phase.value = 'invalid'
    return
  }
  void loadInfo()
})

async function loadInfo(): Promise<void> {
  error.value = ''
  try {
    const info = await api.deviceInfo(userCode.value)
    deviceCode.value = info.deviceCode
    expiresAt.value = info.expiresAt
    phase.value = 'ready'
  } catch {
    // 404（不存在 / 已过期 / 已消费）与其余异常同样按无效链接收尾
    phase.value = 'invalid'
  }
}

async function authorize(approve: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await api.authorizeDevice(deviceCode.value, approve)
    phase.value = approve ? 'approved' : 'denied'
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      phase.value = 'invalid' // 挑战已过期 / 已消费
    } else if (err instanceof ApiError && err.status === 409) {
      error.value = '该客户端已绑定其他账户的有效令牌，无法授权到当前账户'
    } else {
      error.value = err instanceof Error ? err.message : '操作失败，请稍后重试'
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="device-wrap">
    <div class="card device-card">
      <template v-if="phase === 'loading'">
        <div class="device-center"><span class="spinner"></span></div>
      </template>

      <template v-else-if="phase === 'invalid'">
        <h1 class="device-title">链接无效</h1>
        <p class="text-2 device-desc">
          没有找到对应的登录请求——确认码可能已过期或已被使用。请回到 Aurora
          客户端重新发起「登录账户」。
        </p>
        <a class="btn btn-secondary" href="#/">返回控制台</a>
      </template>

      <template v-else-if="phase === 'approved'">
        <h1 class="device-title ok">已确认登录</h1>
        <p class="text-2 device-desc">
          客户端「{{ userCode }}」的登录请求已批准，几秒内它会自动登录你的账户。本页可以关闭。
        </p>
        <a class="btn btn-secondary" href="#/">返回控制台</a>
      </template>

      <template v-else-if="phase === 'denied'">
        <h1 class="device-title">已拒绝</h1>
        <p class="text-2 device-desc">
          你已拒绝该客户端的登录请求，客户端不会登录任何账户。本页可以关闭。
        </p>
        <a class="btn btn-secondary" href="#/">返回控制台</a>
      </template>

      <template v-else>
        <h1 class="device-title">确认客户端登录</h1>
        <p class="text-2 device-desc">
          有一台 Aurora 客户端请求登录你的账户。请核对客户端屏幕上的确认码：
        </p>
        <p class="device-code mono">{{ userCode }}</p>
        <p class="text-2 device-meta">确认码 {{ formatTime(expiresAt) }} 前有效</p>

        <template v-if="currentUser">
          <p v-if="error" class="form-error">{{ error }}</p>
          <div class="device-actions">
            <button class="btn btn-ghost" type="button" :disabled="busy" @click="authorize(false)">
              {{ busy ? '处理中…' : '拒绝' }}
            </button>
            <button class="btn btn-primary" type="button" :disabled="busy" @click="authorize(true)">
              确认登录此客户端
            </button>
          </div>
        </template>
        <template v-else>
          <p class="device-login-hint text-2">先登录（或注册）账户，登录后继续确认：</p>
          <LoginView embedded />
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.device-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.device-card {
  width: 400px;
  max-width: 100%;
  padding: 28px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

.device-center {
  display: flex;
  justify-content: center;
  padding: 24px 0;
}

.device-title {
  margin: 0 0 8px;
  font-size: 20px;
  text-align: center;
}

.device-title.ok {
  color: var(--ok);
}

.device-desc {
  font-size: 13.5px;
  text-align: center;
  margin: 0 0 16px;
}

.device-code {
  text-align: center;
  font-size: 26px;
  letter-spacing: 0.12em;
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 14px 12px;
  margin: 0 0 8px;
  font-weight: 600;
}

.device-meta {
  font-size: 12.5px;
  text-align: center;
  margin: 0 0 18px;
}

.device-login-hint {
  font-size: 13px;
  margin: 0 0 12px;
  text-align: center;
}

.device-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

@media (max-width: 480px) {
  .device-card {
    padding: 22px 18px;
  }
}
</style>
