/// <reference types="vite/client" />

// `*.vue` 的模块声明只服务编辑器的 tsc；类型真相由 vue-tsc（tsconfig.web.json）给出。
// 泛型参数刻意写成显式的 Record/unknown：`{}` 会触发 @typescript-eslint/no-empty-object-type。
declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
