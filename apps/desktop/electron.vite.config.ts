import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const r = (...p: string[]): string => resolve(__dirname, ...p)

/** Renderer window entries — one HTML per window (docs/02 §2.2, docs/07 §2). */
const windowEntries = {
  'service-dock': r('src/renderer/service-dock/index.html'),
  'edge-bar': r('src/renderer/edge-bar/index.html'),
  chat: r('src/renderer/chat/index.html'),
  'mini-chat': r('src/renderer/mini-chat/index.html'),
  settings: r('src/renderer/settings/index.html'),
  onboarding: r('src/renderer/onboarding/index.html'),
}

/**
 * 主进程必须**内联**工作区包：它们是纯 ESM（`type: module`），
 * 而主进程产物是 CJS —— `require()` 一个 ESM 包会抛 `ERR_REQUIRE_ESM`。
 * 第三方依赖（electron / systeminformation / chokidar）保持 external。
 */
const bundleWorkspacePackages = {
  exclude: ['@aurora/shared', '@aurora/agent-core', '@aurora/modes'],
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(bundleWorkspacePackages)],
    build: {
      outDir: r('out/main'),
      rollupOptions: {
        input: { index: r('src/main/index.ts') },
      },
    },
  },
  preload: {
    // preload 运行在 **沙箱化** 渲染进程里（sandbox: true），既没有 node:fs，
    // 也解析不了 pnpm 工作区包 → 必须自包含：只 require('electron') + 字面量通道表。
    // 因此这里**不做** externalizeDepsPlugin，让 `@aurora/shared` 的类型导入被完全擦除。
    build: {
      outDir: r('out/preload'),
      rollupOptions: {
        input: { index: r('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: r('src/renderer'),
    resolve: {
      alias: {
        '@renderer': r('src/renderer'),
        '@shared': r('src/renderer/shared'),
      },
    },
    plugins: [vue()],
    build: {
      outDir: r('out/renderer'),
      rollupOptions: {
        input: windowEntries,
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  },
})
