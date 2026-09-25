import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      // 主进程里**不依赖 Electron** 的纯逻辑（如 updater 的状态机）也纳入单测。
      // 只能测试不 import 'electron' 的模块，否则 Node 环境下无法加载。
      'apps/desktop/src/main/**/*.test.ts',
      // 渲染层里**不 import electron、也不依赖 DOM** 的纯逻辑（如流式增量的按帧合并
      // 缓冲、帧调度由调用方注入）同样纳入单测 —— 它们跑在 node 环境里毫无问题。
      'apps/desktop/src/renderer/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
})
