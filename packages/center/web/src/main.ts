/**
 * Center Web 入口：共享主题（设计令牌 / keyframes / 过渡预设 / 原子类）+ Markdown 样式 +
 * 本页自己的全局重置，然后挂载 SPA。
 *
 * 主题与 Markdown 样式都来自 `@aurora/shared/browser`（桌面端同一份实现，docs/07 §2.3
 * 的「Center Web 对齐口径」）——顺序固定：令牌在前、Markdown 在后、本页覆盖最后。
 */
import '@aurora/shared/browser/theme.css'
import '@aurora/shared/browser/markdown/md.css'
import './style.css'
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
