import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const r = (...p: string[]): string => resolve(__dirname, ...p)

/** Renderer window entries — one HTML per window (docs/02 §2.2, docs/07 §2). */
const windowEntries = {
  'edge-bar': r('src/renderer/edge-bar/index.html'),
  chat: r('src/renderer/chat/index.html'),
  settings: r('src/renderer/settings/index.html'),
  memory: r('src/renderer/memory/index.html'),
  onboarding: r('src/renderer/onboarding/index.html'),
  automation: r('src/renderer/automation/index.html'),
  'awareness-glow': r('src/renderer/awareness-glow/index.html'),
  // 桌面小组件浮动卡片（docs/14 §5.3）：窗口 URL 带 `?pluginId=&widgetId=`
  widget: r('src/renderer/widget/index.html'),
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
        // 第二个入口是**文档内容提取 worker**（docs/02 §2.1、docs/05 §3.2）：
        // 由主进程以 `utilityProcess.fork` 启动，重任务隔离在子进程里，不阻塞事件循环。
        // 第三个入口是**插件宿主进程**（docs/14 §2.2）：一个启用插件一个
        // `utilityProcess`，崩溃 / 死循环不波及主进程；权限白名单仍在主进程判定。
        input: {
          index: r('src/main/index.ts'),
          'extract-worker': r('src/main/extract-worker.ts'),
          'office-worker': r('src/main/office-worker.ts'),
          'plugin-host': r('src/main/plugin-host.ts'),
        },
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
        input: {
          index: r('src/preload/index.ts'),
          // 插件页面（沙箱 webview）专用：只暴露 window.auroraPlugin（docs/14 §2.4）
          'plugin-page': r('src/preload/plugin-page.ts'),
        },
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
