/**
 * `OpenPort` 的主进程实现（docs/06 §11）：把目标交给 Windows 默认程序。
 *
 * 本文件 import electron `shell`，因此**只能被主进程装配层 import**，不进 vitest
 * （Node 环境加载不了 electron）；真实打开行为由 `AURORA_SMOKE` 端到端自测覆盖。
 */
import { shell } from 'electron'
import type { OpenPort } from '@aurora/agent-core'

/** 网页 / 邮件交给默认浏览器；其余（文件、文件夹、程序名）走系统关联 */
const EXTERNAL_PATTERN = /^(https?:\/\/|mailto:)/i
const URL_PATTERN = /^https?:\/\//i

export interface ShellOpenPortOptions {
  /** 模型打开 http(s) 时的去向；缺省维持旧行为（外部浏览器） */
  urlMode?: () => 'internal' | 'external'
  /** 内置浏览器投放回调（装配层负责 showChat + preview:show） */
  present?: (target: string, sessionId: string) => void
}

export function createShellOpenPort(options: ShellOpenPortOptions = {}): OpenPort {
  return {
    async open(target, openOptions) {
      const sessionId = openOptions?.sessionId ?? ''
      if (
        URL_PATTERN.test(target) &&
        (options.urlMode?.() ?? 'external') === 'internal' &&
        options.present !== undefined &&
        sessionId !== ''
      ) {
        options.present(target, sessionId)
        return
      }
      if (EXTERNAL_PATTERN.test(target)) {
        await shell.openExternal(target)
        return
      }
      // Electron 的约定：openPath 返回**非空字符串**即为失败原因（空串才是成功）
      const failure = await shell.openPath(target)
      if (failure !== '') throw new Error(`打开失败（${target}）：${failure}`)
    },
  }
}
