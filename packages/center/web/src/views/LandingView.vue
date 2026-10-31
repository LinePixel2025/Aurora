<script setup lang="ts">
/**
 * 未登录官网首页。
 *
 * 下载信息只读公开 `/api/updates/current`；没有发布记录或 Center 暂时不可用时降级到通用入口，
 * 页面本身不依赖登录态或客户端连接。
 */
import { computed, onMounted, ref } from 'vue'
import type { CenterReleaseInfo } from '@aurora/shared'
import {
  ArrowRight,
  Bot,
  Command,
  FileDown,
  MonitorSmartphone,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
} from '@aurora/shared/browser'
import { api } from '../lib/api'
import { navigate } from '../router'

const release = ref<CenterReleaseInfo | null>(null)
const releaseLoaded = ref(false)

onMounted(async () => {
  try {
    release.value = (await api.currentRelease()).current
  } catch {
    release.value = null
  } finally {
    releaseLoaded.value = true
  }
})

const installer = computed(() => release.value?.files.find((file) => file.kind === 'installer'))
const downloadHref = computed(() =>
  installer.value === undefined
    ? 'https://github.com/LinePixel2025/Aurora/releases/latest'
    : `/api/updates/${encodeURIComponent(installer.value.name)}`,
)
const versionLabel = computed(() => release.value?.version ?? 'Windows x64')
const sizeLabel = computed(() => {
  const size = installer.value?.size
  if (size === undefined) return '安装包'
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
})

const downloadState = computed(() => {
  if (!releaseLoaded.value) return '正在读取当前版本…'
  if (release.value === null) return '从最新发布页获取安装包'
  return `Aurora v${release.value.version} · ${sizeLabel.value}`
})
</script>

<template>
  <div class="landing" data-panel="landing">
    <section class="hero">
      <div class="hero-rail" aria-hidden="true">
        <span />
        <i />
        <i />
        <i />
      </div>

      <div class="hero-copy">
        <p class="eyebrow">
          <span class="eyebrow-dot" aria-hidden="true" />
          Windows 系统级 Agent
        </p>
        <h1>让 Windows<br /><span>自己完成工作。</span></h1>
        <p class="hero-lede">
          Aurora 常驻在桌面右侧，理解屏幕上的上下文，连接文件、终端与自动化。
          需要时出现，不需要时不打扰。
        </p>

        <div class="hero-actions">
          <a
            class="hero-primary"
            :href="downloadHref"
            data-action="landing.download"
            @click="releaseLoaded = true"
          >
            <FileDown :size="17" :stroke-width="1.9" aria-hidden="true" />
            下载 Aurora
          </a>
          <button
            type="button"
            class="hero-secondary"
            data-action="landing.enter-console"
            @click="navigate('login')"
          >
            进入控制台
            <ArrowRight :size="16" :stroke-width="1.8" aria-hidden="true" />
          </button>
        </div>

        <div class="hero-download-meta">
          <span>{{ downloadState }}</span>
          <span>Windows 10 / 11</span>
          <span>未签名正式版</span>
        </div>
      </div>

      <div class="hero-stage" aria-label="Aurora Center 控制台预览">
        <div class="stage-topline">
          <span><i /> AURORA CONTROL PLANE</span>
          <span>WINDOWS / ONLINE</span>
        </div>
        <div class="stage-frame">
          <img src="/aurora-console-preview.png" alt="Aurora Center 控制台设备、会话与控制面板" />
        </div>
        <div class="stage-note">
          <Bot :size="15" :stroke-width="1.7" aria-hidden="true" />
          <span>远程会话、文件回传与自动化状态在同一工作台内完成。</span>
        </div>
      </div>
    </section>

    <section id="capabilities" class="capabilities">
      <header class="section-head">
        <p class="section-kicker">BEYOND A CHAT WINDOW</p>
        <h2>不是另一个聊天框，<br />是 Windows 的执行层。</h2>
        <p>
          Aurora 把模型、工具和系统状态接在同一套会话里。它能看到正在处理的文件，
          也能在获得授权后执行真实操作。
        </p>
      </header>

      <div class="capability-list">
        <article>
          <span class="capability-icon"><Sparkles :size="20" :stroke-width="1.7" /></span>
          <div>
            <h3>无感常驻</h3>
            <p>右侧提示条轻量运行，收起时只留一条状态边；需要输入时再展开，不打断当前工作。</p>
          </div>
          <span class="capability-code">EDGE</span>
        </article>

        <article>
          <span class="capability-icon"><Workflow :size="20" :stroke-width="1.7" /></span>
          <div>
            <h3>文件自感知</h3>
            <p>监听指定目录，提取图片与常用文档内容，生成可检索的本地知识与后续建议。</p>
          </div>
          <span class="capability-code">CONTEXT</span>
        </article>

        <article>
          <span class="capability-icon"><Terminal :size="20" :stroke-width="1.7" /></span>
          <div>
            <h3>真实电脑操控</h3>
            <p>在权限边界内读写文件、检索项目、运行命令。敏感动作先问，再执行。</p>
          </div>
          <span class="capability-code">ACTION</span>
        </article>
      </div>
    </section>

    <section id="security" class="security-band">
      <div class="security-copy">
        <p class="section-kicker">CONTROL STAYS LOCAL</p>
        <h2>远程可见，边界仍在本机。</h2>
        <p>
          Center 只转发远程会话与白名单配置。凭据由本机安全存储加密；项目根、权限档位与
          敏感工具确认链仍由客户端自己裁决。
        </p>
        <button type="button" class="security-login" @click="navigate('login')">
          <MonitorSmartphone :size="16" :stroke-width="1.8" aria-hidden="true" />
          登录管理你的设备
        </button>
      </div>
      <div class="security-points">
        <div>
          <ShieldCheck :size="18" :stroke-width="1.7" aria-hidden="true" />
          <strong>白名单配置</strong>
          <span>远端不能替客户端改全局权限档。</span>
        </div>
        <div>
          <Command :size="18" :stroke-width="1.7" aria-hidden="true" />
          <strong>会话级覆盖</strong>
          <span>模型、项目与权限只作用于指定远程会话。</span>
        </div>
        <div>
          <FileDown :size="18" :stroke-width="1.7" aria-hidden="true" />
          <strong>文件可控</strong>
          <span>暂存文件 24 小时自动删除。</span>
        </div>
      </div>
    </section>

    <section id="download" class="download-band">
      <div>
        <p class="section-kicker">READY FOR WINDOWS</p>
        <h2>把工作交给 Aurora。</h2>
        <p>下载桌面端后，用 Center 账号连接设备，即可在浏览器查看和控制远程会话。</p>
      </div>
      <div class="download-action">
        <span class="download-version">{{ versionLabel }}</span>
        <a :href="downloadHref" class="download-button" data-action="landing.download-footer">
          <FileDown :size="18" :stroke-width="1.9" aria-hidden="true" />
          下载 Windows 安装包
        </a>
        <small>{{ downloadState }}</small>
      </div>
    </section>

    <footer class="landing-footer">
      <span>Aurora Center</span>
      <span>把 Windows 接入 AI 生态。</span>
      <span>HarmonyOS Sans Fonts © 2021 Huawei Device Co., Ltd.</span>
    </footer>
  </div>
</template>

<style scoped>
.landing {
  --landing-pad: clamp(20px, 5vw, 80px);
  overflow: hidden;
}

.hero {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 0.88fr) minmax(420px, 1.12fr);
  gap: clamp(36px, 6vw, 96px);
  align-items: center;
  min-height: min(780px, calc(100vh - 64px));
  padding: clamp(64px, 9vw, 120px) var(--landing-pad) clamp(72px, 9vw, 112px);
  border-bottom: 1px solid var(--border-subtle);
  background:
    linear-gradient(90deg, transparent 0 12%, var(--center-grid) 12% 12.08%, transparent 12.08%),
    var(--center-hero-bg);
}

.hero-rail {
  position: absolute;
  top: 0;
  bottom: 0;
  left: clamp(12px, 4vw, 64px);
  width: 1px;
  background: var(--center-rail);
}

.hero-rail span {
  position: absolute;
  top: 14%;
  left: -3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--center-signal);
  box-shadow: 0 0 0 6px color-mix(in srgb, var(--center-signal) 14%, transparent);
  animation: aurora-breathe var(--dur-breathe) var(--ease-standard) infinite;
}

.hero-rail i {
  position: absolute;
  left: -9px;
  width: 19px;
  height: 1px;
  background: var(--center-rail-strong);
}

.hero-rail i:nth-of-type(1) {
  top: 30%;
}

.hero-rail i:nth-of-type(2) {
  top: 58%;
}

.hero-rail i:nth-of-type(3) {
  top: 82%;
}

.hero-copy {
  position: relative;
  z-index: 1;
  max-width: 620px;
}

.eyebrow,
.section-kicker {
  margin: 0;
  color: var(--center-signal);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
}

.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 22px;
}

.eyebrow-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--status-ok);
}

.hero h1 {
  margin: 0;
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: clamp(42px, 5vw, 68px);
  font-weight: 600;
  line-height: 0.98;
  letter-spacing: -0.055em;
}

.hero h1 span {
  white-space: nowrap;
}

.hero-lede {
  max-width: 560px;
  margin: 28px 0 0;
  color: var(--text-secondary);
  font-size: clamp(15px, 1.4vw, 18px);
  line-height: 1.75;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 34px;
}

.hero-primary,
.hero-secondary,
.download-button,
.security-login {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 46px;
  padding: 0 18px;
  border-radius: 8px;
  font: inherit;
  font-size: var(--text-sm);
  text-decoration: none;
  cursor: pointer;
  transition:
    transform var(--dur-press) var(--ease-standard),
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.hero-primary,
.download-button {
  border: none;
  background: var(--center-signal);
  color: var(--center-signal-ink);
  font-weight: 600;
}

.hero-primary:hover,
.download-button:hover {
  background: var(--center-signal-hover);
  transform: translateY(-1px);
}

.hero-secondary {
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-primary);
}

.hero-secondary:hover {
  background: var(--fill-2);
  transform: translateY(-1px);
}

.hero-download-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 18px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.hero-download-meta span + span::before {
  content: '/';
  margin-right: 18px;
  color: var(--border-strong);
}

.hero-stage {
  position: relative;
  z-index: 1;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--center-frame-border);
  border-radius: 12px;
  background: var(--center-frame);
  box-shadow: var(--shadow-3);
}

.stage-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 30px;
  padding: 0 6px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
}

.stage-topline span:first-child {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.stage-topline i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-ok);
}

.stage-frame {
  overflow: hidden;
  border: 1px solid var(--center-frame-border);
  border-radius: 8px;
  background: #090b0d;
}

.stage-frame img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: cover;
  object-position: top center;
}

.stage-note {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 42px;
  padding: 0 8px;
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.stage-note svg {
  flex: 0 0 auto;
  color: var(--center-signal);
}

.capabilities {
  padding: clamp(76px, 10vw, 144px) var(--landing-pad);
  border-bottom: 1px solid var(--border-subtle);
}

.section-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 480px);
  gap: 18px 64px;
  align-items: end;
}

.section-head .section-kicker {
  grid-column: 1 / -1;
}

.section-head h2,
.security-copy h2,
.download-band h2 {
  margin: 0;
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: clamp(34px, 4.5vw, 60px);
  font-weight: 600;
  line-height: 1.04;
  letter-spacing: -0.045em;
}

.section-head > p:last-child,
.security-copy > p,
.download-band > div > p:last-child {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-base);
  line-height: 1.8;
}

.capability-list {
  display: grid;
  margin-top: clamp(48px, 7vw, 88px);
  border-top: 1px solid var(--border-subtle);
}

.capability-list article {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 120px;
  gap: 24px;
  align-items: center;
  min-height: 132px;
  padding: 24px 0;
  border-bottom: 1px solid var(--border-subtle);
}

.capability-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--fill-1);
  color: var(--center-signal);
}

.capability-list h3 {
  margin: 0 0 7px;
  color: var(--text-primary);
  font-size: var(--text-lg);
  font-weight: 500;
}

.capability-list p {
  max-width: 760px;
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.7;
}

.capability-code {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-align: right;
}

.security-band {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(340px, 0.85fr);
  gap: clamp(48px, 8vw, 128px);
  padding: clamp(72px, 9vw, 128px) var(--landing-pad);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--center-band);
}

.security-copy h2 {
  margin-top: 18px;
}

.security-copy > p {
  max-width: 680px;
  margin-top: 24px;
}

.security-login {
  margin-top: 30px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-primary);
}

.security-login:hover {
  background: var(--fill-2);
}

.security-points {
  display: grid;
  align-content: center;
  border-top: 1px solid var(--border-subtle);
}

.security-points div {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 4px 12px;
  align-items: center;
  min-height: 94px;
  border-bottom: 1px solid var(--border-subtle);
}

.security-points svg {
  grid-row: 1 / 3;
  color: var(--center-signal);
}

.security-points strong {
  align-self: end;
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: 500;
}

.security-points span {
  align-self: start;
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.download-band {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 48px;
  align-items: center;
  padding: clamp(72px, 9vw, 120px) var(--landing-pad);
  background: var(--center-download-bg);
}

.download-band h2 {
  margin-top: 16px;
}

.download-band > div > p:last-child {
  max-width: 680px;
  margin-top: 20px;
}

.download-action {
  display: grid;
  justify-items: end;
  gap: 10px;
}

.download-version {
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
}

.download-button {
  min-height: 52px;
  padding-inline: 22px;
}

.download-action small {
  color: var(--text-muted);
  font-size: 11px;
}

.landing-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 28px;
  align-items: center;
  min-height: 72px;
  padding: 18px var(--landing-pad);
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: 11px;
}

.landing-footer span:last-child {
  margin-left: auto;
}

@media (max-width: 1080px) {
  .hero {
    grid-template-columns: minmax(0, 1fr);
    min-height: auto;
  }

  .hero-stage {
    max-width: 860px;
  }

  .section-head,
  .security-band {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .landing {
    --landing-pad: 18px;
  }

  .hero {
    gap: 42px;
    padding-top: 58px;
    padding-bottom: 64px;
  }

  .hero h1 {
    font-size: clamp(42px, 13vw, 60px);
  }

  .hero-actions,
  .hero-primary,
  .hero-secondary {
    width: 100%;
  }

  .hero-download-meta span + span::before {
    display: none;
  }

  .hero-stage {
    padding: 8px;
    border-radius: 10px;
  }

  .stage-topline {
    font-size: 9px;
  }

  .stage-note {
    align-items: flex-start;
    min-height: auto;
    padding: 11px 8px 5px;
    line-height: 1.5;
  }

  .capability-list article {
    grid-template-columns: 42px minmax(0, 1fr);
    gap: 16px;
  }

  .capability-code {
    display: none;
  }

  .download-band {
    grid-template-columns: minmax(0, 1fr);
  }

  .download-action {
    justify-items: stretch;
  }

  .download-button {
    width: 100%;
  }

  .landing-footer span:last-child {
    width: 100%;
    margin-left: 0;
  }
}
</style>
