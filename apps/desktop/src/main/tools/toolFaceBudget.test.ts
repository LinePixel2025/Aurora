import { describe, expect, it } from 'vitest'
import { buildToolGuidance, SkillsBridge, ToolRegistry } from '@aurora/agent-core'
import { createDefaultSettings, createMemoryLogger } from '@aurora/shared'
import { measureToolFace, TOOL_FACE_BUDGET } from './budget.js'
import {
  registerAgentCoreTools,
  registerAutomationTools,
  registerAwarenessTools,
  registerBrowserTools,
  registerCenterTools,
  registerClassIslandTools,
  registerComputerTools,
  registerComputerUseTools,
  registerExtensionTools,
  registerImageTools,
  registerSettingsTool,
} from './index.js'

/**
 * 端口桩：只在**构造工具**时被访问，`execute` 不会被调用。
 *
 * 用泛型而不是 `any`，既过 ESLint，也让 `run: stub<never>()` 能直接填进
 * 各装配器的端口位（`never` 可赋给任何类型）。
 */
function stub<T>(): T {
  const fn = (() => stub<T>()) as unknown as (...args: unknown[]) => unknown
  const proxy = new Proxy(fn, {
    get: (_target, prop) => (prop === 'then' ? undefined : stub<T>()),
    apply: () => stub<T>(),
  })
  return proxy as unknown as T
}

/**
 * 构造**全量内置工具面**（所有开关打开、vision 打开）：
 * 11 个装配器 + 真实的 `use_skill`（空技能注册表）。
 *
 * 本测试只护栏内置装配器；插件 / MCP 不计入（插件上限见 docs/14：
 * 单插件 32、全部 128）。阈值见 `TOOL_FACE_BUDGET`，超了先评审再加。
 */
function buildFullToolFace(): ToolRegistry {
  const tools = new ToolRegistry()
  const logger = createMemoryLogger()
  const settings = createDefaultSettings()
  const getSettings = (): typeof settings => settings

  registerComputerTools({
    tools,
    getSettings,
    logger,
    homeDir: () => 'C:\\Users\\tester',
    sessionWorkspaceDir: () => 'C:\\Users\\tester',
    run: stub<never>(),
    files: stub<never>(),
    office: stub<never>(),
    officeAvailable: () => true,
    open: stub<never>(),
  }).sync()

  registerSettingsTool({ tools, logger, port: stub<never>() }).sync()
  registerExtensionTools({
    tools,
    logger,
    webFetch: stub<never>(),
    clipboard: stub<never>(),
    notify: stub<never>(),
    banner: stub<never>(),
    imageGen: stub<never>(),
    imageDisplay: stub<never>(),
    preview: stub<never>(),
  }).sync()
  registerImageTools({
    tools,
    logger,
    visionEnabled: () => true,
    viewImage: stub<never>(),
    screenshot: stub<never>(),
    clipboardImage: stub<never>(),
  }).sync()
  registerAgentCoreTools({
    tools,
    logger,
    todoPort: stub<never>(),
    askUserPort: stub<never>(),
    provider: stub<never>(),
    getSettings,
  }).sync()
  registerClassIslandTools({ tools, logger, port: stub<never>() }).sync()
  registerCenterTools({
    tools,
    logger,
    port: stub<never>(),
    config: () => ({
      enabled: true,
      serverUrl: 'http://localhost:8787',
      allowFileTransfer: true,
      maxFileMb: 64,
    }),
  }).sync()
  registerAutomationTools({ tools, logger, port: stub<never>(), getSettings }).sync()
  registerAwarenessTools({ tools, logger, port: stub<never>(), active: () => true }).sync()
  registerBrowserTools({
    tools,
    logger,
    port: stub<never>(),
    enabled: () => true,
    permissionMode: () => 'auto',
    onDisabled: () => undefined,
  }).sync()
  registerComputerUseTools({
    tools,
    logger,
    port: stub<never>(),
    enabled: () => true,
    available: () => true,
    visionEnabled: () => true,
    permissionMode: () => 'auto',
    onDisabled: () => undefined,
  }).sync()

  const skills = { enabled: () => [] } as unknown as ConstructorParameters<typeof SkillsBridge>[0]
  new SkillsBridge(skills).registerInto(tools)
  return tools
}

describe('工具面预算（docs/06 §5.4）', () => {
  it('全量内置工具面不超过 65 个 / 42,000 字符', () => {
    const defs = buildFullToolFace().toLlmTools()
    // 62 = 61 个装配器工具 + use_skill；新增工具必须同步评审预算，别静默涨
    expect(defs).toHaveLength(62)
    expect(defs.length).toBeLessThanOrEqual(TOOL_FACE_BUDGET.maxTools)
    expect(measureToolFace(defs).chars).toBeLessThanOrEqual(TOOL_FACE_BUDGET.maxChars)
  })

  it('重叠工具的边界描述都指向另一侧（逻辑合并的文案契约）', () => {
    const defs = buildFullToolFace().toLlmTools()
    const edges: Record<string, string> = {
      read_file: 'office_read',
      office_read: 'read_file',
      web_fetch: 'browser_open',
      browser_open: 'open_path',
      browser_read: 'web_fetch',
      open_path: 'browser_open',
      screenshot: 'computer_screenshot',
      computer_screenshot: 'screenshot',
      view_image: 'clipboard_read_image',
      clipboard_read_image: 'view_image',
      notify_user: 'notify_banner',
    }
    for (const [name, marker] of Object.entries(edges)) {
      const def = defs.find((item) => item.name === name)
      if (def === undefined) throw new Error(`缺少工具：${name}`)
      expect(def.description).toContain(marker)
    }
  })

  it('全量工具面生成六条选择顺序', () => {
    const names = buildFullToolFace()
      .toLlmTools()
      .map((def) => def.name)
    const guidance = buildToolGuidance(names)
    for (const marker of [
      '读文件先分流',
      '取网页先分流',
      '截屏先分流',
      '打开网页给用户看',
      '看图先看来源',
      '告知用户默认用',
    ]) {
      expect(guidance).toContain(marker)
    }
  })
})
