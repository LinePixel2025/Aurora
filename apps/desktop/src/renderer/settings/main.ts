import { createApp } from 'vue'
import App from './App.vue'
import '@aurora/shared/browser/theme.css'
import './settings.css'
import { bootstrapApp } from '../shared/bootstrap.js'

const app = createApp(App)
await bootstrapApp(app, { trackWindows: true })
app.mount('#app')
