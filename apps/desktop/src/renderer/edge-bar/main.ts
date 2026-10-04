import { createApp } from 'vue'
import App from './App.vue'
import '@aurora/shared/browser/theme.css'
import { bootstrapApp } from '../shared/bootstrap.js'

const app = createApp(App)
// 不在这里拉感知：收起态不显示系统状态，展开时由 App.vue 按需刷新（省 systeminformation 常驻）
await bootstrapApp(app, { trackWindows: true })
app.mount('#app')
