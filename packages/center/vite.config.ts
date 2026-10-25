import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * Aurora Center Web UI 构建配置（docs/12 §10）。
 *
 * - root 指向 web/：SPA 源码独立于服务器 src/，由 vite 全权处理；
 * - base './' + hash 路由：静态托管无需 history fallback，服务器直接吐 dist-web 即可；
 * - 产物输出到 ../dist-web（服务器静态服务的目录，docs/12 §1）；
 * - `server.proxy` 只服务**开发**（`pnpm --filter @aurora/center dev:web`）：`/api` 与它的
 *   WebSocket 一起转发到本地 Center（默认 `http://127.0.0.1:8787`，用 `AURORA_CENTER_URL`
 *   指向别的地址）。生产托管方式不变 —— 仍是服务器直接吐 `dist-web`。
 */
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: process.env.AURORA_CENTER_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
      // 页面型插件面板的资源由服务器从市场包吐（docs/12 §6.5）：dev:web 下不代理就是 404
      '/p': {
        target: process.env.AURORA_CENTER_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
})
