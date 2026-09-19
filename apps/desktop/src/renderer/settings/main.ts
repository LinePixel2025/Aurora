import { createApp } from 'vue'
import App from './App.vue'
import '../shared/theme.css'
import './settings.css'
import { bootstrapApp } from '../shared/bootstrap.js'

const app = createApp(App)
await bootstrapApp(app, { trackWindows: true })
app.mount('#app')
