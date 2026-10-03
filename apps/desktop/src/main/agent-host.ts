/**
 * AgentHost 装配层（docs/02 §3.1、docs/06 §5）。
 *
 * 本文件只做"接线"：把 `SettingsStore` 的凭据、当前模式提示词、系统感知、
 * Skill 注册表与 MCP Hub 组装成内核需要的依赖，再交给 `KernelAgentHost`。
 * 真实逻辑全部在 `packages/agent-core`（纯 Node、可单测）。
 */
import {
  describeError,
  isLlmError,
  matchAllowPatterns,
  type AgentProviderFactory,
  type ConfirmDecision,
  type ProviderConfig,
  type SessionModelOverride,
} from '@aurora/agent-core'
import { createLlmProvider } from './llm-provider.js'
import type { AgentEvent, AgentHost, LlmSettings, LlmProviderConfig } from '@aurora/shared'
import type { Logger, PermissionMode } from '@aurora/shared'
// 三档权限的判定是纯函数、主进程与渲染层共用同一份（docs/06 §11.2）
import {
  isWithinRoot,
  permissionTargetOf,
  resolveModelParams,
  resolveSessionModel,
} from '@aurora/shared'
import type {
  ModeManagerLike,
  PerceptionLike,
  SendMessageRequest,
  SettingsStoreLike,
} from './contracts.js'
import type { ConfirmResolution } from './proactive.js'

export interface AgentHostOptions {
  settings: SettingsStoreLike
  modes: ModeManagerLike
  perception: PerceptionLike
  logger: Logger
  /** 已装配好的内核 AgentHost（由 index.ts 构造） */
  kernel: AgentHost
  /**
   * 敏感工具确认（docs/06 §5）。运行时由主进程注入内核的 `runAgentLoop.confirmTool`；
   * 未提供时保持 P3 行为（仅按 `sensitivity` 留痕、不阻断执行）。
   */
  confirmTool?: ConfirmToolDecision
}

/**
 * 敏感工具执行前的用户确认回调（docs/06 §5）。
 * 形状与 `@aurora/agent-core` 的 `AgentLoopOptions.confirmTool` 一致：
 * 由内核在工具 `sensitivity === 'confirm'` 时调用，`false` 表示用户拒绝执行，
 * `'always'` 表示"本次放行 + 本会话内同名工具不再询问"（docs/06 §11.2）。
 */
export type ConfirmToolDecision = (info: {
  name: string
  input: unknown
  sessionId: string
  sensitivity: 'confirm'
}) => Promise<ConfirmDecision>

/** 确认载体（结构上由 `proactive.ts` 的 `ProactiveScheduler` 满足） */
export interface SensitiveToolConfirmerLike {
  requestSensitiveToolConfirm(input: {
    sessionId: string
    toolName: string
    input: unknown
  }): Promise<ConfirmResolution>
}

/**
 * 包装内核 AgentHost：替换掉 P1 的占位回复，并在事件流出口补上
 * LLM 错误码的中文可操作提示（IPC 契约与渲染层无需改动）。
 */
export class DesktopAgentHost implements AgentHost {
  private readonly options: AgentHostOptions
  private readonly detach: () => void
  private readonly listeners = new Set<(event: AgentEvent) => void>()

  constructor(options: AgentHostOptions) {
    this.options = options
    this.detach = options.kernel.onEvent((event) => this.dispatch(event))
  }

  isReady(): boolean {
    return this.options.kernel.isReady()
  }

  /**
   * 与 `AgentHost` 契约同形（见 `contracts.ts`）：`extraContext` 是附件提取的文本，
   * `images` 是本轮**图片附件的路径**（多模态输入，docs/06 §3.1）——
   * 后者由 `ipc.ts` 按扩展名挑出、并按 `vision` 判定是否下发，主进程只是透传给内核。
   */
  send(
    request: SendMessageRequest & { extraContext?: string; images?: readonly string[] },
  ): Promise<{ requestId: string }> {
    return this.options.kernel.send(request)
  }

  abort(requestId: string): boolean {
    return this.options.kernel.abort(requestId)
  }

  /** 该会话是否正在跑请求（`/compact` 的 E_BUSY 判定；透传内核） */
  isBusy(sessionId: string): boolean {
    return this.options.kernel.isBusy(sessionId)
  }

  /** 手动压缩会话上下文（`/compact`，docs/06 §4；透传内核，结局由 CompactOutcome 表达） */
  compact(sessionId: string) {
    return this.options.kernel.compact(sessionId)
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 敏感工具确认钩子：由 `index.ts` 在装配内核时交给 `KernelAgentHost`，
   * 再由内核透传给 `runAgentLoop`（docs/06 §5）。未配置时为 `undefined`。
   */
  get confirmTool(): ConfirmToolDecision | undefined {
    return this.options.confirmTool
  }

  /** 供设置页 / 诊断使用：当前系统提示词预览。 */
  async buildSystemPromptPreview(): Promise<string> {
    return [this.options.modes.systemPrompt(), await this.options.perception.contextSummary()]
      .filter((part) => part !== '')
      .join('\n\n')
  }

  dispose(): void {
    this.detach()
    this.listeners.clear()
  }

  private dispatch(event: AgentEvent): void {
    const outgoing =
      event.type === 'error'
        ? { ...event, message: explainError(event.code, event.message) }
        : event
    for (const listener of this.listeners) {
      try {
        listener(outgoing)
      } catch (error) {
        this.options.logger.warn('Agent 事件监听器抛错', { error: String(error) })
      }
    }
  }
}

/**
 * provider 工厂的可选依赖（v-next 会话级模型，docs/06 §3）。
 */
export interface ProviderFactoryOptions {
  /**
   * 会话级模型覆盖：同步读会话 meta（`SessionStore.modelOverrideOf`），
   * 未覆盖 / 缓存未装载返回 `undefined`。缺省 = 无会话级能力（行为与从前逐字一致，
   * 老装配器与单测不受影响）。
   */
  sessionModelOf?: (sessionId: string) => SessionModelOverride | undefined
}

/**
 * 用当前设置即时构造 provider（每次请求都重新读取 + 解密）。
 * 这样在设置页改完 API Key / 模型后**无需重启**即可生效。
 *
 * `resolveFetch` 同理按调用即时取值：系统代理改完，下一次请求就走新代理
 * （docs/08 §6；在此之前 `advanced.proxy` 是个没有消费方的死字段）。
 *
 * `create({ allowFallback: true })` 额外提供**启动自愈**：默认条目不可用时临时回退到
 * 另一个可用条目（只影响本次请求构造，不写配置）。见下方 `fallback`。
 *
 * `create({ sessionId })`（v-next，docs/06 §3）叠加**会话级模型覆盖**：
 * 该会话在 `meta.llm` 里写了 `(providerId, model)` 且它仍然可用时，用这一对构造；
 * 覆盖指向的 provider 已被删除 / model 为空 / Key 取不到 → **静默回落全局档**
 * （只记 `debug`：会话级绑定是可选的，逐次执行刷 warn 只会淹掉真问题）。
 */
export function createProviderFactory(
  settings: SettingsStoreLike,
  logger: Logger,
  resolveFetch?: () => typeof fetch | undefined,
  options?: ProviderFactoryOptions,
): AgentProviderFactory {
  /**
   * 用某个已配置条目构造 provider。
   * 返回 `undefined` 的原因都会记日志（缺 baseUrl / model / 可用 Key），
   * 因此自愈回退时跳过哪些条目是可查的；`quiet` 用于探测回退候选（那些条目本就不是
   * 当前默认，缺 Key 属于正常状态，不该刷 warn）。
   */
  const build = (
    providerId: string,
    config: LlmProviderConfig,
    quiet = false,
  ): ProviderConfig | undefined => {
    if (config.baseUrl.trim() === '' || config.model.trim() === '') {
      if (!quiet) logger.warn('模型配置缺少 baseUrl 或 model', { providerId })
      return undefined
    }

    const apiKey = settings.getSecret(`llm.providers.${providerId}.apiKey`)
    if (apiKey === '') {
      if (!quiet) logger.warn('模型配置缺少 API Key（可能加密不可用或尚未填写）', { providerId })
      return undefined
    }

    // 模型能力与思考等级按**当前生效模型**解析（v23：`llm.providers.<id>.modelParams[model]`，
    // 唯一取值口径 `resolveModelParams`；缺省按 `provider.model` 取，未命中按字段回落默认）。
    const params = resolveModelParams(config)

    // 「思考等级」按用户设置透传给内核；`auto` 约定为「不下发 reasoning_effort」，
    // 在内核边界之前就映射成 undefined —— 其它层不许再判断 `'auto'`。
    const reasoningEffort = params.reasoningEffort === 'auto' ? undefined : params.reasoningEffort

    return {
      provider: createLlmProvider(config.type, {
        id: providerId,
        baseUrl: config.baseUrl,
        apiKey,
        defaultModel: config.model,
        ...(fetchImplOf(resolveFetch) === undefined
          ? {}
          : { fetchImpl: fetchImplOf(resolveFetch) }),
        onRetry: (info) =>
          logger.warn(info.reason === undefined ? 'LLM 请求重试' : 'LLM 请求降级重试', {
            providerId,
            attempt: info.attempt,
            code: info.code,
            delayMs: info.delayMs,
            ...(info.reason === undefined ? {} : { reason: info.reason }),
          }),
      }),
      model: config.model,
      // 能力开关（docs/06 §3.1）：内核据它决定要不要把历史里的图片读出来重放。
      // 默认档是**关**（模型级表未命中时 `resolveModelParams` 回落 `false`），与 Schema 一致。
      vision: params.vision === true,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
  }

  /**
   * 启动自愈（docs/06 §12）：默认条目不可用时，临时借一个**确实可用**的条目把本轮请求建起来。
   *
   * 这件事只影响本次请求构造：**不写配置**（`llm.active` 改不改由用户或设置页决定），
   * 否则一次模型调用就会悄悄改掉用户的选择。
   *
   * 触发场景有二：AI 把 `llm.active` 写空 / 写成一个不存在的 id（见 `set_setting` 的黑名单与
   * `SettingsStore.sanitize` 的重置），或用户在配置文件里手改错了字段。
   */
  const fallback = (llm: LlmSettings): ProviderConfig | undefined => {
    for (const [id, candidate] of Object.entries(llm.providers)) {
      if (id === llm.active) continue
      const built = build(id, candidate, true)
      if (built !== undefined) {
        logger.warn('默认模型配置不可用，已回退到可用条目', { active: llm.active, fallback: id })
        return built
      }
    }
    return undefined
  }

  return {
    create(createOptions?: {
      allowFallback?: boolean
      sessionId?: string
    }): ProviderConfig | undefined {
      const llm: LlmSettings = settings.get().llm
      // 会话级覆盖（docs/06 §3）：判据收在 shared 的 `resolveSessionModel`（唯一口径，
      // 渲染层与 Center 网页端同用一份）—— 这里只负责「拿它算出来的 (pid, model) 去构造」，
      // 构造不出来（Key 没配 / baseUrl 空）再回落全局档，绝不把会话拖成 E_NO_MODEL。
      const override =
        createOptions?.sessionId === undefined
          ? undefined
          : options?.sessionModelOf?.(createOptions.sessionId)
      const effective = resolveSessionModel(llm, override)
      if (effective.overridden) {
        const overrideConfig: LlmProviderConfig | undefined = llm.providers[effective.providerId]
        if (overrideConfig !== undefined) {
          const builtOverride = build(effective.providerId, {
            ...overrideConfig,
            model: effective.model,
          })
          if (builtOverride !== undefined) return builtOverride
          logger.debug('会话级模型覆盖不可用，已回落全局档', {
            sessionId: createOptions?.sessionId,
            providerId: effective.providerId,
            model: effective.model,
          })
        }
      }

      const providerId = llm.active
      if (providerId === '') {
        logger.debug('尚未选择默认模型配置')
        return allowFallbackOf(createOptions) ? fallback(llm) : undefined
      }
      const config: LlmProviderConfig | undefined = llm.providers[providerId]
      if (config === undefined) {
        logger.warn('默认模型配置不存在', { providerId })
        return allowFallbackOf(createOptions) ? fallback(llm) : undefined
      }
      const built = build(providerId, config)
      if (built === undefined && allowFallbackOf(createOptions)) return fallback(llm)
      return built
    },
  }
}

/** 只有显式要求自愈时才回退：普通调用（如设置页「测试连接」）必须如实报告失败。 */
function allowFallbackOf(options?: { allowFallback?: boolean }): boolean {
  return options?.allowFallback === true
}

/** 取当前出网 fetch；解析失败按「未提供」处理，让内核回落到全局 fetch。 */
function fetchImplOf(resolveFetch?: () => typeof fetch | undefined): typeof fetch | undefined {
  if (resolveFetch === undefined) return undefined
  try {
    return resolveFetch()
  } catch {
    return undefined
  }
}

/**
 * 把主动引导的确认载体适配成内核需要的 `confirmTool` 钩子（docs/06 §5）。
 *
 * - 设置项 `advanced.confirmSensitiveTools` 关闭时**每次调用即时判断**并直接放行
 *   （改设置无需重启；内核仍会按 `sensitivity` 写日志留痕）；
 * - `run_command` 命中用户维护的**免确认模式列表**（docs/06 §11.7）时跳过确认卡片、直接放行。
 *   这条路径是**减少打扰**、不是安全加固 —— 它只是少问一次，不增加任何权限，
 *   也没有把"未命中"变成放行。命中时**仍然写 `info` 级审计日志**（含被命中的模式与命令前缀），
 *   否则"为什么这次没弹卡片"将无从追溯；
 * - 模式本身非法（纯通配 / 含花括号 / 语法不合法）时匹配器一律跳过，等价于没有这条模式；
 * - 确认链路自身失败时按"拒绝"处理：确认交互不可用时宁可不执行敏感工具。
 */
export function createConfirmTool(options: {
  proactive: SensitiveToolConfirmerLike
  /**
   * 当前**生效**的权限档位（每次调用即时读，改设置无需重启，与 v13 之前的 `enabled` 同款）。
   * 取值由 `resolvePermissionMode()` 从 `agent.permissionMode` + `advanced.confirmSensitiveTools`
   * 双开关算出来（docs/06 §11.2）。
   *
   * v0.2.3 起按 `info.sessionId` **现解析**（与 `agent.loop` 上限的 getter 套路同款）：
   * 解析链为 **会话级覆盖（`SessionMeta.permissionMode`，docs/12 §6.3）> 全局档**。
   * 允许 async：会话 meta 存在会话文件里，装配层可能要先读盘。未注入会话覆盖时
   * 装配层自行回落全局档，这里只认返回值。
   */
  mode: (sessionId: string) => Promise<PermissionMode> | PermissionMode
  /** `run_command` 的免确认模式列表（每次调用即时读） */
  allowPatterns?: () => readonly string[]
  /**
   * 按会话解析的项目根（绝对路径）；无项目时返回 undefined（允许 async：会话绑定
   * 存在会话文件里，装配层可能要先读盘）。按**会话绑定**的项目根边界判定
   * （docs/06 §5.1；全局 `projects.current` 一级已于 v25 退役）。
   *
   * `auto` 档的免确认边界就是它：**根内免确认、根外照常弹卡**。
   * 会话级项目（docs/06 §5.1）起它按 `info.sessionId` 解析——会话绑定了项目就用那个根，
   * 未绑定 / 绑定已失效回落全局当前项目；无项目时没有"根内"可言 —— 此时 `auto` 档与
   * v13 之前"关掉确认总开关"的行为一致（完全不弹卡），否则老用户一旦关掉那个开关
   * 就会突然被逐次询问，等于静默改回了旧行为。
   */
  projectRoot?: (sessionId: string) => Promise<string | undefined>
  logger?: Logger
}): ConfirmToolDecision {
  return async (info) => {
    // 档位按会话现解析（getter 注入；会话级覆盖 > 全局档，docs/06 §11.2 / docs/12 §6.3）
    const mode = await options.mode(info.sessionId)

    // ── 只读档：写 / 执行类工具本来就不注册，这里是双保险 ──
    // 走到这里说明工具表与设置不一致（例如刚好在切换档位的瞬间），宁可不执行。
    if (mode === 'readonly') {
      options.logger?.warn('只读档下收到敏感工具调用，已拒绝', {
        tool: info.name,
        sessionId: info.sessionId,
      })
      return false
    }

    // ── 免确认模式（confirm / auto 两档都生效）──
    // 命中即跳过卡片，但审计日志照写 —— 见上方函数注释。
    if (info.name === 'run_command') {
      const command = readCommand(info.input)
      if (command !== undefined) {
        const matched = matchAllowPatterns(command, options.allowPatterns?.() ?? [])
        if (matched !== undefined) {
          options.logger?.info(
            '命令命中免确认模式，已跳过确认卡片（边界校验仍生效，不带 allowOutside）',
            {
              tool: info.name,
              pattern: matched,
              command: command.slice(0, 200), // 超长命令只记前 200 字符
            },
          )
          return 'machine'
        }
      }
    }

    // ── auto 档：只在项目根之内免确认 ──
    // （v0.2.4 起 center_send_file 改 `sensitivity: 'safe'` 直接发送，确认链路不再经过本函数，
    //  外发类工具的特例名单随之删除 —— 它的闸门在注册层：center.enabled / allowFileTransfer / maxFileMb。）
    if (mode === 'auto') {
      // 根按**会话**解析（会话绑定项目 > 全局当前项目，docs/06 §5.1）；允许 await 读盘
      const root = await options.projectRoot?.(info.sessionId)
      if (root === undefined || root.trim() === '') {
        // 无项目：没有"根内"的判据。保持 v13 之前"关掉确认总开关 = 不再逐次询问"的语义，
        // 否则老用户会因为这次升级突然被反复询问（静默的行为回退）。
        options.logger?.info(
          'auto 档且未配置项目，按免确认放行（边界校验仍生效，不带 allowOutside）',
          {
            tool: info.name,
          },
        )
        return 'machine'
      }
      const approved = reasonWithinRoot(info, root)
      if (approved !== undefined) {
        options.logger?.info(
          '调用落在项目根内，auto 档免确认放行（边界校验仍生效，不带 allowOutside）',
          {
            tool: info.name,
            root,
            target: approved,
          },
        )
        return 'machine'
      }
    }

    // ── confirm 档：工作目录内的文件写入 / 编辑免确认（v0.2.4，Codex 式 auto-edit）──
    // Codex 的「Auto」档位把工作区内的文件改动设为自动放行、命令仍要过目（on-request）；
    // Aurora 的 confirm 档从这里起对齐：write_file / edit_file 落在会话边界根之内
    // （会话绑定项目 > 全局当前项目 > Work 模式工作目录，docs/06 §5.1）时跳过卡片，
    // 越界 / 无根（未配项目且无 Work 工作目录）时维持逐次确认 —— 默认行为不变。
    if (mode === 'confirm' && (info.name === 'write_file' || info.name === 'edit_file')) {
      const root = await options.projectRoot?.(info.sessionId)
      const approved = root === undefined ? undefined : reasonWithinRoot(info, root)
      if (approved !== undefined) {
        options.logger?.info('confirm 档：写入落在工作目录边界内，免确认放行（边界校验仍生效）', {
          tool: info.name,
          root,
          target: approved,
        })
        return 'machine'
      }
    }

    try {
      return await options.proactive.requestSensitiveToolConfirm({
        sessionId: info.sessionId,
        toolName: info.name,
        input: info.input,
      })
    } catch (error) {
      options.logger?.warn('敏感工具确认链路失败，按拒绝处理', {
        tool: info.name,
        error: String(error),
      })
      return false
    }
  }
}

/**
 * `auto` 档判定：该调用是否落在项目根内（返回被判定用的目标路径；不在 / 判不出时 undefined）。
 *
 * 保守方向永远是"不自动放行"：
 * - 取不到目标路径（`permissionTargetOf` 返回 undefined）时只有 `run_command` 例外 ——
 *   缺省 `cwd` 回落到**生效工作目录**（配置了当前项目时即项目根——与 `registerComputerTools`
 *   的装配同源，`effectiveWorkspaceDir`），所以按根内判定；其余工具一律按越界处理（走确认）；
 * - **命令串里出现绝对路径时一律按越界处理**：我们不做 shell 解析，猜错一次就是静默越权，
 *   多问一次只是打扰（`docs/06 §11.2` 已写明这个取舍）。
 */
function reasonWithinRoot(
  info: { name: string; input: unknown },
  root: string,
): string | undefined {
  if (info.name === 'run_command') {
    const command = readCommand(info.input)
    if (command !== undefined && containsAbsolutePath(command)) return undefined
  }
  const target = permissionTargetOf(info.name, info.input)
  if (target === undefined) {
    // `run_command` 缺省 `cwd` 回落到生效工作目录；配置了当前项目时即项目根——与
    // `registerComputerTools` 的装配同源（`effectiveWorkspaceDir`），因此按根内处理；
    // 其余工具拿不到目标路径就等于"不知道它要碰哪"，一律走确认。
    return info.name === 'run_command' ? root : undefined
  }
  return isWithinRoot(target, root) ? target : undefined
}

/**
 * 命令串里是否出现"看起来是绝对路径"的片段。
 *
 * 只需要**宁可多问**：命中就退回确认卡片，不命中也不会漏掉真实越界（真越界会在执行时
 * 被 `command-runner` 的 cwd 校验拦下）。因此这里允许误报，不允许漏报。
 */
export function containsAbsolutePath(command: string): boolean {
  // 盘符路径（C:\ / C:/）、UNC（\\server\share）、以及 POSIX 绝对路径（/usr/...）。
  // 注意 `C:` 单独出现不算（可能是命令行参数里的 `key:value`），要求后面紧跟分隔符。
  return (
    /[A-Za-z]:[\\/]/.test(command) || command.includes('\\\\') || /(^|[\s"'=])[/\\]/.test(command)
  )
}

/**
 * 从工具入参里取 `run_command` 的命令串（`createConfirmTool` 的私有实现细节）。
 *
 * **只信任"确实是对象，且 `command` 是一个非空、非纯空白的字符串"这一种形态**；
 * 其余情形 —— 入参不是对象（字符串 / 数字 / 数组 / null）、缺 `command` 字段、
 * `command` 不是字符串（数字 / 对象 / 数组）、空串或纯空白 —— 一律返回 `undefined`。
 *
 * 调用方拿到 `undefined` 时的行为是**走正常确认**，绝不放行：
 * "解析不出命令"不能被当成"命中免确认"，否则模型只要换一种参数写法就能摘掉确认闸门。
 *
 * 返回值**去掉首尾空白**（`trim()`）：真正执行时 `terminal.ts` 用的是 `rawCommand.trim()`，
 * 若这里拿未 trim 的原串去匹配，模型传 `'  git status'`（前导空格）就对 `git status*`
 * 不命中、白弹一张卡片 —— 是 fail-safe（不会误放行），但"加了模式却有时不生效"极难排查，
 * 所以「被匹配的命令」与「被执行的命令」必须是**同一个串**。注意只改**匹配用的副本**：
 * 传给确认卡片的 `info.input` 保持原样，用户看到的仍是他实际要执行的那条命令（含空白）。
 */
function readCommand(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const command = (input as Record<string, unknown>)['command']
  if (typeof command !== 'string') return undefined
  const trimmed = command.trim()
  if (trimmed === '') return undefined
  return trimmed
}

/** LLM 错误 → 可操作的中文提示（IPC 层只做透传，文案集中在这里）。 */
export function explainError(code: string, message: string): string {
  if (isLlmErrorCode(code)) return describeError(code, message)
  return message
}

const LLM_ERROR_CODES = [
  'E_AUTH',
  'E_RATE_LIMIT',
  'E_TIMEOUT',
  'E_NETWORK',
  'E_NOT_FOUND',
  'E_BAD_REQUEST',
  'E_SERVER',
  'E_ABORTED',
  'E_UNKNOWN',
] as const

function isLlmErrorCode(code: string): code is (typeof LLM_ERROR_CODES)[number] {
  return (LLM_ERROR_CODES as readonly string[]).includes(code)
}

export { isLlmError }
export type { AgentHost, AgentEvent }
