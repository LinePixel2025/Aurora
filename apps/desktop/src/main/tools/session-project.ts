/**
 * 会话级项目解析（docs/06 §5.1，v17）：「每个会话可以绑定一个项目」的**唯一解析口径**。
 *
 * 现状（v16 及之前）项目只有全局一份：`projects.current` 决定缺省工作目录、auto 档免确认
 * 边界与 AGENTS.md 注入。v17 起会话可以绑定 `projects.list` 里的某一项
 * （`sessions/<id>.json` 的 `meta.projectId`，经 `chat:setSessionProject` 写入）；
 * 2026-09-30 会话三分（docs/06 §4）起再插入**会话空间**一级（`meta.space`）：
 *
 * - **绑定项目 > 空间目录 > 全局回落**：绑定了项目的会话（项目对话）以项目根为准；
 *   未绑定（或绑定项已被删除）的会话按空间落目录 —— Agent 空间（`space: 'agent'` 或
 *   未标记，含 `quick` 与历史会话）→ `%USERPROFILE%\Desktop\Aurora`（`agentDesktopDir`，
 *   固定常量、恒可解析）；Work 空间（`space: 'work'`）→ `modes.work.workspaceDir`
 *   （目录为空串时跳过本机继续旧链）。再往后按既有链回落：全局 `projects.current` >
 *   激活模式的工作目录（v18，当前只有 Work 模式）/ `agent.tools.workspaceDir` / 用户主目录；
 * - **空间目录排在全局当前项目之前**：空间是会话创建时刻的显式归属（左栏三分的判定依据），
 *   不随用户后来切 `projects.current` 漂移 —— 三分区「工作目录互不相同」靠这一级保证；
 * - 中心会话（`center-` 前缀）与本地会话**同一逻辑**，默认未绑定、Agent 空间，没有特殊分支。
 *
 * 这条链是 **Codex 式「一个会话一个工作目录」的唯一口径**（docs/05 §4 / docs/06 §5.1）：
 * 缺省 cwd、写入边界、auto 档免确认边界、提示词全部同源 —— Work 模式的
 * `modes.work.workspaceDir` 不再是提示词里的孤立概念，而是链上的一级回落。
 *
 * 三条消费方（docs/06 §5.1 / §11.2）共用这里的解析结果，不得各写一份：
 * 1. 缺省工作目录 / 搜索根（`registerComputerTools` → terminal / search 工具的 getter）；
 * 2. 项目根边界（`file-port` / `command-runner` 的 `workspaceRoot` guard）与
 *    auto 档免确认判定（`agent-host.ts` 的 `createConfirmTool`）、confirm 档的
 *    「根内写文件免确认」（v0.2.4，Codex 式 auto-edit）；
 * 3. 项目级 AGENTS.md 注入（`createProjectInstructionsSource` 的 `resolveRoot(sessionId)`）。
 *
 * 其中 1 / 2 的**工具执行链取值**经 `adaptForSubagent` 视图：子代理（task 工具）的 `-sub`
 * 会话 id 先剥回父会话再解析（docs/06 §19）—— 缺省 cwd / 搜索根 / 边界根跟随父会话的
 * 工作目录，todo 清单等状态隔离仍按 `-sub`。
 *
 * 本文件**不 import electron**：纯取值闭包 + agent-core 纯函数组合，可在 Node 里单测
 * （`session-project.test.ts`）。
 */
import {
  effectiveWorkspaceDir,
  parentSessionIdOf,
  resolveProjectRootById,
} from '@aurora/agent-core'
import type { SessionSpace } from '@aurora/agent-core'
import type { Settings } from '@aurora/shared'

export interface SessionProjectDeps {
  getSettings: () => Settings
  /**
   * 取会话绑定的项目 id（`SessionStore.projectOf` 的同步缓存读）。
   * 返回 `undefined` / 空串 = 未绑定（或缓存未装载 —— 装配层不变量：会话的工具执行
   * 之前 `agentLoop` 已经读过该会话，缓存必然已就绪；异步路径请用 `projectIdOf` 预热）。
   */
  getProjectId: (sessionId: string | undefined) => string | undefined
  /**
   * 取会话空间（`SessionStore.spaceOf` 的同步缓存读；undefined 归一为 `'agent'`）。
   * 与 `getProjectId` 同一条装配层不变量（工具执行前会话必然已装载）。
   */
  sessionSpaceOf: (sessionId: string | undefined) => SessionSpace
  /**
   * Agent 空间的固定工作目录（`agentDesktopDir(homedir())` 的结果）。
   * 由装配层注入并负责**懒创建**目录（失败只告警）—— 本文件不碰 fs。
   */
  agentDir: () => string
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
   * 该会话的项目根**边界**（端口 `workspaceRoot` guard、auto 档免确认判定与
   * confirm 档「根内写免确认」用，docs/06 §5.1 / §11.2）：
   * 会话绑定项目 > 会话空间目录 > 全局当前项目 > 激活模式工作目录（Work）。
   * Agent 空间恒可解析（`桌面\Aurora` 不依赖配置），因此**每个会话都有边界根** ——
   * 2026-09-30 起「无项目 = 无边界」的旧行为不再存在。
   */
  boundaryRoot(sessionId: string | undefined): string | undefined
  /**
   * 该会话的**生效工作目录**（缺省 cwd / 搜索根，docs/06 §5.1 唯一口径）：
   * 会话绑定项目 > 会话空间目录（Agent → `桌面\Aurora`；Work → 模式工作目录）>
   * 全局当前项目 > 激活模式工作目录（Work）> `agent.tools.workspaceDir` > 用户主目录。
   */
  workspaceDir(sessionId: string | undefined): string
}

export function createSessionProjectResolver(deps: SessionProjectDeps): SessionProjectResolver {
  /** 会话绑定 id → 归一后的项目根；未绑定 / 已删除一律静默为 undefined（逐次执行不刷日志） */
  const rootOfBinding = (projectId: string | undefined): string | undefined =>
    resolveProjectRootById(deps.getSettings(), projectId, { cwd: deps.cwd })

  const projectRootOf = (sessionId: string | undefined): string | undefined =>
    rootOfBinding(deps.getProjectId(sessionId))

  /**
   * Work 空间的工作目录（2026-09-30）：`modes.work.workspaceDir`，**不看** `modes.current`
   * —— 空间戳在会话创建时刻已确定归属，用户切走 Work 模式后这些会话仍在工作目录干活。
   * 空串 / 全空白 = 未配置 → undefined（跳过本机继续旧链）。
   */
  const workSpaceDir = (): string | undefined => {
    const dir = deps.getSettings().modes.work.workspaceDir.trim()
    return dir === '' ? undefined : dir
  }

  /**
   * 会话空间目录（docs/06 §4）：Agent 空间 → 固定 `桌面\Aurora`（恒可解析）；
   * Work 空间 → 模式工作目录（未配置时 undefined，继续旧链）。
   */
  const spaceDirOf = (sessionId: string | undefined): string | undefined => {
    const space = deps.sessionSpaceOf(sessionId)
    if (space === 'agent') return normalizeDir(deps.agentDir())
    if (space === 'work') return workSpaceDir()
    return undefined
  }

  /**
   * 激活模式的工作目录（v18，docs/05 §4）：当前只有 Work 模式提供。
   * `modes.current` 就在 settings 里，不需要注入模式管理器 —— 与设置同源、热改即时生效。
   */
  const activeModeDir = (): string | undefined => {
    const snapshot = deps.getSettings()
    if (snapshot.modes.current !== 'work') return undefined
    const dir = snapshot.modes.work.workspaceDir.trim()
    return dir === '' ? undefined : dir
  }

  return {
    projectRootOf,

    boundaryRoot(sessionId) {
      return (
        projectRootOf(sessionId) ??
        spaceDirOf(sessionId) ??
        deps.globalProjectRoot() ??
        activeModeDir()
      )
    },

    workspaceDir(sessionId) {
      const bound = projectRootOf(sessionId)
      if (bound !== undefined) return bound
      const space = spaceDirOf(sessionId)
      if (space !== undefined) return space
      // 既有链：全局当前项目 > 激活模式工作目录 > agent.tools.workspaceDir > 主目录
      return effectiveWorkspaceDir(
        deps.getSettings(),
        deps.globalProjectRoot(),
        deps.homeDir(),
        undefined,
        activeModeDir(),
      )
    },
  }
}

/** 目录串归一：空白 = 未配置（Agent 空间的目录恒非空，这里主要防装配层注入空串）。 */
function normalizeDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * 工具执行链用的解析器视图：子代理会话 id（`-sub` 后缀）先剥回**父会话**再解析。
 *
 * task 工具的子代理循环带着 `<父会话>-sub` 的 id 跑（todo 清单等状态隔离依赖它，
 * docs/06 §19），但电脑操控工具的缺省 cwd / 搜索根（`sessionWorkspaceDir`）与
 * file-port / command-runner / view_image 的边界根（`workspaceRoot` guard）必须按
 * **父会话**解析 —— 否则 `-sub` 查不到会话绑定，恒落 Agent 空间目录，主代理在项目里
 * 派子代理时子代理会在错误的目录里 grep / 写文件。与确认链「钉回父会话」
 * （task.ts 的 `confirmForSubagent`）是同一类钉回的另一半，同用 `parentSessionIdOf`。
 *
 * 只透出工具链用的两个方法；AGENTS.md 注入 / 确认边界 / workspaceHint 等**不经**此视图
 * （那些路径不会收到 `-sub` id，保持原语义）。纯函数包装，可单测。
 */
export interface ToolchainProjectResolver {
  workspaceDir(sessionId: string | undefined): string
  boundaryRoot(sessionId: string | undefined): string | undefined
}

export function adaptForSubagent(resolver: SessionProjectResolver): ToolchainProjectResolver {
  const unwrap = (sessionId: string | undefined): string | undefined =>
    sessionId === undefined || sessionId === '' ? sessionId : parentSessionIdOf(sessionId)
  return {
    workspaceDir: (sessionId) => resolver.workspaceDir(unwrap(sessionId)),
    boundaryRoot: (sessionId) => resolver.boundaryRoot(unwrap(sessionId)),
  }
}
