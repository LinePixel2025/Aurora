/**
 * 会话级项目解析（docs/06 §5.1，v17）：「每个会话可以绑定一个项目」的**唯一解析口径**。
 *
 * 现状（v16 及之前）项目只有全局一份：`projects.current` 决定缺省工作目录、auto 档免确认
 * 边界与 AGENTS.md 注入。v17 起会话可以绑定 `projects.list` 里的某一项
 * （`sessions/<id>.json` 的 `meta.projectId`，经 `chat:setSessionProject` 写入）：
 *
 * - **未绑定 / 绑定项已被删除** → 回落全局 `projects.current`，再按既有链回落
 *   `agent.tools.workspaceDir` / 用户主目录（`effectiveWorkspaceDir` 的第 4 参承接会话级入参）；
 * - 中心会话（`center-` 前缀）与本地会话**同一逻辑**，默认未绑定，没有任何特殊分支。
 *
 * 三条消费方（docs/06 §5.1 / §11.2）共用这里的解析结果，不得各写一份：
 * 1. 缺省工作目录 / 搜索根（`registerComputerTools` → terminal / search 工具的 getter）；
 * 2. 项目根边界（`file-port` / `command-runner` 的 `workspaceRoot` guard）与
 *    auto 档免确认判定（`agent-host.ts` 的 `createConfirmTool`）；
 * 3. 项目级 AGENTS.md 注入（`createProjectInstructionsSource` 的 `resolveRoot(sessionId)`）。
 *
 * 本文件**不 import electron**：纯取值闭包 + agent-core 纯函数组合，可在 Node 里单测
 * （`session-project.test.ts`）。
 */
import { effectiveWorkspaceDir, resolveProjectRootById } from '@aurora/agent-core'
import type { Settings } from '@aurora/shared'

export interface SessionProjectDeps {
  getSettings: () => Settings
  /**
   * 取会话绑定的项目 id（`SessionStore.projectOf` 的同步缓存读）。
   * 返回 `undefined` / 空串 = 未绑定（或缓存未装载 —— 装配层不变量：会话的工具执行
   * 之前 `agentLoop` 已经读过该会话，缓存必然已就绪；异步路径请用 `projectIdOf` 预热）。
   */
  getProjectId: (sessionId: string | undefined) => string | undefined
  /** 全局当前项目根（`resolveProject().root`，v13 口径的 live getter） */
  globalProjectRoot: () => string | undefined
  /** 用户主目录（回落链末级；每次调用即时取，别在装配期快照） */
  homeDir: () => string
  /** 相对项目根的归一基准 cwd（与全局 `resolveProject` 同源：`process.cwd()`） */
  cwd: string
}

export interface SessionProjectResolver {
  /**
   * 会话**自身绑定**的项目根（归一后的绝对路径）。
   * 未绑定 / 绑定项已删除 / root 空白 → `undefined`，**刻意不回落全局**——
   * 回落语义由 `boundaryRoot` / `workspaceDir` 表达，这里保持"会话自己绑了什么"的纯读。
   */
  projectRootOf(sessionId: string | undefined): string | undefined
  /**
   * 该会话的项目根**边界**（端口 `workspaceRoot` guard 与 auto 档免确认判定用）：
   * 会话绑定项目 > 全局当前项目。两者都无 → `undefined`（= 无边界，行为与 v13 之前一致）。
   */
  boundaryRoot(sessionId: string | undefined): string | undefined
  /**
   * 该会话的**生效工作目录**（缺省 cwd / 搜索根，docs/06 §5.1 唯一口径）：
   * 会话绑定项目 > 全局当前项目 > `agent.tools.workspaceDir` > 用户主目录
   * （`effectiveWorkspaceDir` 的会话级第 4 参）。
   */
  workspaceDir(sessionId: string | undefined): string
}

export function createSessionProjectResolver(deps: SessionProjectDeps): SessionProjectResolver {
  /** 会话绑定 id → 归一后的项目根；未绑定 / 已删除一律静默为 undefined（逐次执行不刷日志） */
  const rootOfBinding = (projectId: string | undefined): string | undefined =>
    resolveProjectRootById(deps.getSettings(), projectId, { cwd: deps.cwd })

  const projectRootOf = (sessionId: string | undefined): string | undefined =>
    rootOfBinding(deps.getProjectId(sessionId))

  return {
    projectRootOf,

    boundaryRoot(sessionId) {
      return projectRootOf(sessionId) ?? deps.globalProjectRoot()
    },

    workspaceDir(sessionId) {
      return effectiveWorkspaceDir(
        deps.getSettings(),
        deps.globalProjectRoot(),
        deps.homeDir(),
        projectRootOf(sessionId),
      )
    },
  }
}
