import { createApp } from 'vue'
import App from './App.vue'
import '@aurora/shared/browser/theme.css'
import { bootstrapApp } from '../shared/bootstrap.js'
import { bindWindowRequest } from './request.js'

// 先订阅主进程的窗口参数，再走 bootstrap：首包可能落在 bootstrap 的 IPC 往返之间。
bindWindowRequest()

const app = createApp(App)
await bootstrapApp(app, { trackPlugins: true })
app.mount('#app')
