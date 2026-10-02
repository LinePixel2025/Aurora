<script setup lang="ts">
/**
 * 设备确认页（docs/12 §4.3）：客户端点「登录账户」后打开 `#/device?code=<userCode>`。
 *
 * 流程：userCode → `GET /api/client/device/info` 换 deviceCode（无需登录）→ 登录态下
 * 批准 / 拒绝 → `POST /api/client/device/authorize` → 客户端轮询自动拿到令牌。
 * 未登录时先内嵌登录 / 注册卡片，成功后自动回到确认流程（本页不跳转）。
 *
 * 五个相位：loading / invalid（码不存在或挑战已过期）/ ready / approved / denied。
 */
import { onMounted, ref } from 'vue'
import { currentUser } from '../state'
import { ApiError, api } from '../lib/api'
import { formatTime } from '../lib/format'
import { CircleCheck, CircleX, MonitorSmartphone } from '@aurora/shared/browser'
import LoginView from './LoginView.vue'

type Phase = 'loading' | 'ready' | 'invalid' | 'approved' | 'denied'

const phase = ref<Phase>('loading')
const userCode = ref('')
const deviceCode = ref('')
const expiresAt = ref('')
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  userCode.value = (query.get('code') ?? '').trim()
  if (!userCode.value) {
    phase.value = 'invalid'
    return
  }
  try {
    const info = await api.deviceInfo(userCode.value)
    deviceCode.value = info.deviceCode
    expiresAt.value = info.expiresAt
    phase.value = 'ready'
  } catch {
    phase.value = 'invalid'
  }
})

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
  <div class="device-wrap" data-panel="device">
    <div class="device-card">
      <template v-if="phase === 'loading'">
        <div class="center"><span class="spinner" aria-label="正在加载" /></div>
      </template>

      <template v-else-if="phase === 'invalid'">
        <h1 class="device-title">链接无效</h1>
        <p class="device-desc">
          没有找到对应的登录请求 —— 确认码可能已过期或已被使用。请回到 Aurora
          客户端重新发起「登录账户」。
        </p>
        <a class="link" href="#/">返回控制台</a>
      </template>

      <template v-else-if="phase === 'approved'">
        <span class="device-mark ok" aria-hidden="true">
          <CircleCheck :size="24" :stroke-width="1.8" />
        </span>
        <h1 class="device-title">已确认登录</h1>
        <p class="device-desc">
          客户端「{{ userCode }}」的登录请求已批准，几秒内它会自动登录你的账户。本页可以关闭。
        </p>
        <a class="link" href="#/">返回控制台</a>
      </template>

      <template v-else-if="phase === 'denied'">
        <span class="device-mark danger" aria-hidden="true">
          <CircleX :size="24" :stroke-width="1.8" />
        </span>
        <h1 class="device-title">已拒绝</h1>
        <p class="device-desc">
          你已拒绝该客户端的登录请求，客户端不会登录任何账户。本页可以关闭。
        </p>
        <a class="link" href="#/">返回控制台</a>
      </template>

      <template v-else>
        <span class="device-mark" aria-hidden="true">
          <MonitorSmartphone :size="22" :stroke-width="1.7" />
        </span>
        <h1 class="device-title">确认客户端登录</h1>
        <p class="device-desc">
          有一台 Aurora 客户端请求登录你的账户。请核对客户端屏幕上的确认码：
        </p>
        <p class="device-code" data-field="device.code">{{ userCode }}</p>
        <p class="device-meta">确认码 {{ formatTime(expiresAt) }} 前有效</p>

        <template v-if="currentUser">
          <p v-if="error" class="device-error">{{ error }}</p>
          <div class="device-actions">
            <button
              class="btn-ghost"
              type="button"
              :disabled="busy"
              data-action="device.reject"
              @click="authorize(false)"
            >
              {{ busy ? '处理中…' : '拒绝' }}
            </button>
            <button
              class="btn-primary"
              type="button"
              :disabled="busy"
              data-action="device.approve"
              @click="authorize(true)"
            >
              确认登录此客户端
            </button>
          </div>
        </template>
        <template v-else>
          <p class="device-hint">先登录（或注册）账户，登录后继续确认：</p>
          <LoginView embedded />
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.device-wrap {
  display: grid;
  place-items: center;
  padding: var(--space-7) var(--space-4);
  flex: 1 1 auto;
}

.device-card {
  width: min(420px, 100%);
  padding: var(--space-6);
  background: var(--bg-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.center {
  display: grid;
  place-items: center;
  padding: var(--space-5);
}

.device-mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--fill-2);
  color: var(--text-secondary);
}

.device-mark.ok {
  background: var(--ok-fill);
  color: var(--ok-text);
}

.device-mark.danger {
  background: var(--danger-fill);
  color: var(--danger-text);
}

.device-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
}

.device-desc,
.device-hint,
.device-meta {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
}

.device-meta {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.device-code {
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--text-xl);
  letter-spacing: var(--tracking-eyebrow);
  text-align: center;
  font-variant-numeric: var(--num-tabular);
}

.device-error {
  margin: 0;
  color: var(--danger-text);
  font-size: var(--text-sm);
}

.device-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}

.btn-primary,
.btn-ghost {
  height: var(--control-h-md);
  padding: 0 var(--space-4);
  border-radius: var(--radius-pill);
  font-size: var(--text-base);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    filter var(--transition-fast);
}

.btn-primary {
  border: none;
  background: var(--aurora-blue);
  color: var(--on-accent);
  font-weight: var(--weight-medium);
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.08);
}

.btn-ghost {
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-secondary);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.btn-primary:disabled,
.btn-ghost:disabled {
  opacity: 0.6;
  cursor: default;
}

.link {
  align-self: flex-start;
  min-height: var(--control-h-sm);
  display: inline-flex;
  align-items: center;
  color: var(--accent-text);
  font-size: var(--text-sm);
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

@media (max-width: 480px) {
  .device-actions {
    flex-direction: column-reverse;
  }

  .btn-primary,
  .btn-ghost {
    width: 100%;
  }
}
</style>
