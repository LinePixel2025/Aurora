import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * Aurora Center Web UI 构建配置（docs/12 §10）。
 *
 * - root 指向 web/：SPA 源码独立于服务器 src/，由 vite 全权处理；
 * - base './' + hash 路由：静态托管无需 history fallback，服务器直接吐 dist-web 即可；
 * - 产物输出到 ../dist-web（服务器静态服务的目录，docs/12 §1）。
 */
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [vue()],
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
})
