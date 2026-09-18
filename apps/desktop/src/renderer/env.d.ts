/// <reference types="vite/client" />

import type { AuroraApi } from '@aurora/shared'

declare global {
  interface Window {
    /** preload 通过 contextBridge 暴露的白名单 API（docs/02 §6） */
    aurora: AuroraApi
  }
}

export {}
