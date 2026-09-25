/**
 * 开发自测（仅 `isDev` 下由主进程调用）。
 *
 * 目的：在**真实 Electron + 真实 preload + 真实 IPC** 上跑一遍关键链路，
 * 覆盖单测覆盖不到的部分（contextBridge 暴露面、sandbox 下的 preload、
 * IPC 序列化、safeStorage 加密落盘、窗口状态机）。
 *
 * 由 `main/index.ts` 在 `AURORA_SMOKE=1` 时通过 `webContents.executeJavaScript` 注入执行，
 * 结果以 `AURORA_SMOKE_RESULT:` 前缀打印到主进程日志。
 */
import { CONFIG_VERSION } from '@aurora/shared'

export const SMOKE_FLAG = 'AURORA_SMOKE'
export const SMOKE_RESULT_PREFIX = 'AURORA_SMOKE_RESULT:'
/**
 * 注入到渲染进程执行的自测脚本（字符串形式，避免被打包器当作模块依赖）。
 *
 * `stubBaseUrl` / `stubModel` 由主进程在启动本地桩 LLM 后传入：
 * 对话链路需要一个**离线可断言**的响应源。
 * `watchDir` 是本轮自测的临时感知文件夹——引导步骤必须写回它，
 * 否则会把配置指向开发者的真实目录，破坏隔离且让多次运行互相干扰。
 */
export function smokeScript(stubBaseUrl: string, stubModel: string, watchDir: string): string {
  return String.raw`
(async () => {
  const STUB_BASE = ${JSON.stringify(stubBaseUrl)}
  const STUB_MODEL = ${JSON.stringify(stubModel)}
  const WATCH_DIR = ${JSON.stringify(watchDir)}
  // 期望的配置版本由主进程注入（不再写死数字：Schema 升版时这里必须跟着走，否则自测会假 FAIL）
  const EXPECTED_CONFIG_VERSION = ${CONFIG_VERSION}
  const results = []
  const record = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })
  const expectOk = (name, result) => {
    if (result && result.ok) return result.value
    record(name, false, result ? result.message : 'result 为 undefined')
    return null
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** 轮询直到条件满足或超时；返回最后一次读取的值 */
  const waitFor = async (read, done, timeoutMs) => {
    const started = Date.now()
    let value = await read()
    while (!done(value) && Date.now() - started < timeoutMs) {
      await wait(150)
      value = await read()
    }
    return value
  }

  /** 轮询分类流水直到条件满足 */
  const waitForClassification = async (predicate, timeoutMs) => {
    const list = await waitFor(
      async () => {
        const result = await window.aurora.classification.history()
        return result && result.ok ? result.value : []
      },
      predicate,
      timeoutMs,
    )
    return list
  }

  /**
   * 投放文件并等待其被处理。
   *
   * 为什么要重试：Windows 上「同名文件被移走后又写回原路径」时，
   * chokidar 的 awaitWriteFinish 轮询偶发漏掉这次 add（已用真实 chokidar + FS 探针
   * 确认 re-add 本身会被上报，因此这是事件时序问题而非监听缺陷）。
   * 真实用户重复拖入也会自然重试，所以这里做**有界重试**并回报尝试次数，
   * 而不是靠拉长超时把偶发失败盖过去。
   */
  const dropAndWait = async (fileName, content, predicate, timeoutMs) => {
    let list = []
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const dropped = await window.aurora.app.smokeDropFile({ fileName, content })
      if (!dropped || !dropped.ok) {
        return { list, attempts: attempt, error: dropped ? dropped.message : 'drop 失败' }
      }
      list = await waitForClassification(predicate, timeoutMs)
      if (predicate(list)) return { list, attempts: attempt }
    }
    return { list, attempts: 3 }
  }

  /** 轮询自测诊断（仅 AURORA_SMOKE=1 可用）直到课前提醒触发过 */
  const waitForPreClass = async (timeoutMs) => {
    const diagnostics = await waitFor(
      async () => {
        const result = await window.aurora.app.getSmokeDiagnostics()
        return result && result.ok ? result.value : { enabled: false }
      },
      (value) => Array.isArray(value.preClassFired) && value.preClassFired.length > 0,
      timeoutMs,
    )
    return diagnostics && diagnostics.preClassFired ? diagnostics.preClassFired[0] : null
  }

  /** 渲染层任何路径都不得看到密文或明文（docs/08 §1.1 的 apiKeySet / envSet 约定） */
  const PLAINTEXT_MARKER = 'sk-smoke-plaintext-marker'
  const assertNoSecretLeak = (name, payload) => {
    const json = JSON.stringify(payload)
    const leakedCipher = /"apiKeyEnc"\s*:\s*"[^"]+"/.test(json)
    const leakedEnv = /"envEnc"\s*:\s*\{[^}]+\}/.test(json)
    const leakedPlain = json.includes(PLAINTEXT_MARKER)
    record(name, !leakedCipher && !leakedEnv && !leakedPlain, leakedPlain ? '出现明文' : leakedCipher || leakedEnv ? '出现密文' : '无密文/明文')
  }

  if (!window.aurora) {
    return { fatal: 'window.aurora 未暴露：preload 加载失败' }
  }

  try {
    // 0. 广播脱敏：订阅 settings:changed，确保推送路径同样不泄漏凭据
    const changedPayloads = []
    const offChanged = window.aurora.settings.onChanged((next) => changedPayloads.push(next))

    // 1. 应用信息
    const info = expectOk('app.getInfo', await window.aurora.app.getInfo())
    if (info) {
      record('app.getInfo.platform', typeof info.platform === 'string' && info.platform.length > 0, info.platform)
      record('app.getInfo.cryptoAvailable', info.cryptoAvailable === true, String(info.cryptoAvailable))
      record('app.getInfo.userDataDir 已隔离', /(Aurora|aurora-smoke-)/i.test(info.userDataDir), info.userDataDir)
    }

    // 2. 配置读写（IPC 层）
    const settings = expectOk('settings.get', await window.aurora.settings.get())
    if (settings) {
      record('settings.get.version', settings.version === EXPECTED_CONFIG_VERSION, String(settings.version))
      // 自测前置把科目裁剪为「数学 / 物理 / 语文」，断言随之对齐（不再是九科模板）
      record('settings.get 科目列表已就绪', settings.modes.classroom.subjects.length === 3, String(settings.modes.classroom.subjects.length))
      record('settings.get 不回传密文', settings.llm.providers === undefined || Object.values(settings.llm.providers).every((p) => p.apiKeyEnc === ''), 'apiKeyEnc 已清空')
      assertNoSecretLeak('settings.get 无凭据字段', settings)
    }

    // 3. 模型配置由主进程在启动自测前写入（指向本地桩 LLM），这里只做读写/脱敏断言：
    //    若在此处再写一次 baseUrl，会把桩服务地址覆盖成真实服务，导致对话断言失败。
    const update = expectOk('settings.update(llm)', await window.aurora.settings.update({
      llm: {
        active: 'smoke',
        providers: {
          smoke: { type: 'openai-compat', baseUrl: 'https://api.deepseek.com', apiKeyEnc: '', model: 'deepseek-chat', temperature: 0.7 },
        },
      },
    }))
    if (update) record('settings.update 生效', update.llm.active === 'smoke', update.llm.active)
    assertNoSecretLeak('settings.update 回包不含密文', update ?? {})

    const secrets = expectOk('settings.setSecrets', await window.aurora.settings.setSecrets({
      'llm.providers.smoke.apiKey': 'sk-smoke-plaintext-marker',
    }))
    if (secrets) record('setSecrets 已加密落盘', secrets.persisted === true, JSON.stringify(secrets.paths))

    // 写入凭据后应产生一次 settings:changed 广播，推送路径同样不得含密文/明文
    await wait(120)
    record('settings:changed 已推送', changedPayloads.length > 0, 'times=' + changedPayloads.length)
    for (const payload of changedPayloads) assertNoSecretLeak('settings:changed 广播已脱敏', payload)
    offChanged()

    record('hasSecret 可查询', expectOk('settings.hasSecret', await window.aurora.settings.hasSecret('llm.providers.smoke.apiKey')) === true, '')
    record('app.getInfo.needsOnboarding 变为 false', expectOk('app.getInfo#2', await window.aurora.app.getInfo())?.needsOnboarding === false, '')

    // 3.1 全新 provider 路径（设置页「AI 模型」的实际流程）：先更新配置再写凭据，
    //     且第一次更新只带 apiKeyEnc: ''（渲染层永远拿不到密文）。
    //     这条断言覆盖"改模型名 / 新增 provider 会不会把凭据弄丢"。
    const freshProviderId = 'fresh-' + Date.now()
    const freshSave = expectOk('settings.update(全新 provider)', await window.aurora.settings.update({
      llm: {
        active: freshProviderId,
        providers: {
          [freshProviderId]: { type: 'openai-compat', baseUrl: STUB_BASE, apiKeyEnc: '', model: 'fresh-model', temperature: 0.5, reasoningEffort: 'auto' },
        },
      },
    }))
    record(
      '全新 provider 可保存（apiKeyEnc 为空也能过校验）',
      freshSave?.llm?.providers?.[freshProviderId]?.model === 'fresh-model',
      freshSave?.llm?.providers?.[freshProviderId]?.model ?? 'save 失败',
    )
    expectOk('settings.setSecrets(全新 provider)', await window.aurora.settings.setSecrets({
      ['llm.providers.' + freshProviderId + '.apiKey']: 'sk-fresh-marker',
    }))
    record(
      '全新 provider 凭据可读回',
      expectOk('settings.hasSecret#fresh', await window.aurora.settings.hasSecret('llm.providers.' + freshProviderId + '.apiKey')) === true,
      '',
    )
    // 关键回归：改模型名（patch 不含 apiKeyEnc）不得清掉已存凭据
    const rename = expectOk('settings.update(改模型名)', await window.aurora.settings.update({
      llm: {
        active: freshProviderId,
        providers: {
          [freshProviderId]: { type: 'openai-compat', baseUrl: STUB_BASE, model: 'renamed-model', temperature: 0.5, reasoningEffort: 'auto' },
        },
      },
    }))
    record(
      '改模型名后凭据仍在',
      rename?.llm?.providers?.[freshProviderId]?.model === 'renamed-model' &&
        expectOk('settings.hasSecret#rename', await window.aurora.settings.hasSecret('llm.providers.' + freshProviderId + '.apiKey')) === true,
      'model=' + (rename?.llm?.providers?.[freshProviderId]?.model ?? '?'),
    )
    // 关键回归（本轮修）：真实设置页 saveProvider 会把 settings:get 回传的**全量 providers**
    // （每个都带 apiKeyEnc: ''）原样写回去。空串必须被理解为「本次不改凭据」——
    // 主进程 applyPatch 已按这个语义处理（空串不覆盖已存密文）。这里显式带空串回传并断言凭据仍在。
    // 注意：本段在 String.raw 模板字符串里，注释不能出现反引号。
    const emptyCipher = expectOk('settings.update(带空 apiKeyEnc 回传)', await window.aurora.settings.update({
      llm: {
        active: freshProviderId,
        providers: {
          [freshProviderId]: { type: 'openai-compat', baseUrl: STUB_BASE, apiKeyEnc: '', model: 'renamed-model', temperature: 0.5, reasoningEffort: 'auto' },
        },
      },
    }))
    record(
      '带空 apiKeyEnc 回传后凭据仍在',
      emptyCipher?.llm?.providers?.[freshProviderId]?.model === 'renamed-model' &&
        expectOk('settings.hasSecret#emptyCipher', await window.aurora.settings.hasSecret('llm.providers.' + freshProviderId + '.apiKey')) === true,
      'model=' + (emptyCipher?.llm?.providers?.[freshProviderId]?.model ?? '?'),
    )

    // 3.1.3 MCP 凭据保真的同一条真实路径（本轮修）：设置页保存服务器列表时回传的是
    //     settings:get 脱敏过的对象（每个 server 的 envEnc 都是空对象）。空 envEnc 必须被
    //     理解为「本次不改凭据」—— 否则一次「停用 / 删除别的服务器」就会清空全部 MCP 密文。
    //     夹具用 http + enabled:false：hub 对 disabled 服务器不建连，不会真的起进程。
    const mcpServerName = 'smoke-mcp-' + Date.now()
    const mcpSaved = expectOk('settings.update(mcp 新增)', await window.aurora.settings.update({
      mcp: {
        servers: [{
          name: mcpServerName,
          transport: 'http',
          url: 'http://127.0.0.1:9/mcp',
          envEnc: { TOKEN: '' },
          headersEnc: {},
          enabled: false,
        }],
      },
    }))
    record(
      'MCP 服务器可保存（envEnc 占位也能过校验）',
      mcpSaved?.mcp?.servers?.[0]?.name === mcpServerName,
      String(mcpSaved?.mcp?.servers?.[0]?.name ?? 'save 失败'),
    )
    const mcpSecret = expectOk('settings.setSecrets(mcp)', await window.aurora.settings.setSecrets({
      ['mcp.servers.' + mcpServerName + '.env.TOKEN']: 'sk-mcp-plaintext-marker',
    }))
    record(
      'MCP env 已加密落盘',
      mcpSecret?.persisted === true &&
        expectOk('settings.hasSecret#mcp', await window.aurora.settings.hasSecret('mcp.servers.' + mcpServerName + '.env.TOKEN')) === true,
      JSON.stringify(mcpSecret?.paths ?? []),
    )
    // 关键回归：把**脱敏后**的服务器列表原样写回（「停用 / 启用」「删除其它服务器」都走这条）
    const redactedServers = (expectOk('settings.get#mcp', await window.aurora.settings.get())?.mcp?.servers) ?? []
    const resaved = expectOk('settings.update(mcp 原样回传)', await window.aurora.settings.update({ mcp: { servers: redactedServers } }))
    const resavedServer = resaved?.mcp?.servers?.[0] ?? null
    record(
      '带空 envEnc 回传后 MCP 凭据仍在',
      Boolean(resavedServer?.envSet?.indexOf('TOKEN') >= 0) &&
        expectOk('settings.hasSecret#mcpResave', await window.aurora.settings.hasSecret('mcp.servers.' + mcpServerName + '.env.TOKEN')) === true,
      resavedServer ? 'envSet=' + JSON.stringify(resavedServer.envSet) : 'save 失败',
    )
    assertNoSecretLeak('MCP 回包不含密文', resaved ?? {})

    // 3.1.4 删除语义（本轮修）：llm.providers 是 record，「缺项」表达不了删除。
    //     回传一份少了 fresh 的 providers（不带 removedProviders）不得误删它 ——
    //     fresh 的密文还要留到脚本结束后由主进程读盘断言（见 index.ts）。
    const withoutFresh = { ...(emptyCipher?.llm?.providers ?? {}) }
    delete withoutFresh[freshProviderId]
    const notDeleted = expectOk('settings.update(缺项回传)', await window.aurora.settings.update({
      llm: { active: 'smoke', providers: withoutFresh },
    }))
    record(
      '缺项回传不会误删 provider（删除必须显式声明）',
      notDeleted?.llm?.providers?.[freshProviderId] !== undefined &&
        expectOk('settings.hasSecret#notDeleted', await window.aurora.settings.hasSecret('llm.providers.' + freshProviderId + '.apiKey')) === true,
      Object.keys(notDeleted?.llm?.providers ?? {}).join(',') || 'providers 为空',
    )

    // 3.1.5 真删除：显式声明 removedProviders 之后，provider 与它的凭据都必须消失
    //     （旧行为是「provider 还在、密文被 clearSecret 清掉」，本轮修掉）。
    const removeProviderId = 'remove-' + Date.now()
    expectOk('settings.update(建待删 provider)', await window.aurora.settings.update({
      llm: {
        active: 'smoke',
        providers: {
          ...(notDeleted?.llm?.providers ?? {}),
          [removeProviderId]: { type: 'openai-compat', baseUrl: STUB_BASE, apiKeyEnc: '', model: 'remove-me', temperature: 0.5, reasoningEffort: 'auto' },
        },
      },
    }))
    expectOk('settings.setSecrets(待删 provider)', await window.aurora.settings.setSecrets({
      ['llm.providers.' + removeProviderId + '.apiKey']: 'sk-remove-marker',
    }))
    const removalPatch = { ...(notDeleted?.llm?.providers ?? {}) }
    delete removalPatch[removeProviderId]
    const removed = expectOk('settings.update(删除 provider)', await window.aurora.settings.update({
      llm: { active: 'smoke', providers: removalPatch, removedProviders: [removeProviderId] },
    }))
    record(
      '删除 provider 真正生效',
      removed?.llm?.providers?.[removeProviderId] === undefined,
      Object.keys(removed?.llm?.providers ?? {}).join(',') || 'providers 为空',
    )
    record(
      '删除 provider 会一并清掉凭据',
      expectOk('settings.hasSecret#removed', await window.aurora.settings.hasSecret('llm.providers.' + removeProviderId + '.apiKey')) === false,
      '',
    )

    // 3.2 凭据保真（可观测性说明）：渲染层看到的 apiKeyEnc 按设计永远是空串
    //     （docs/08 §1.1 脱敏），因此这里只能断言"凭据是否已设置"标记；
    //     密文真实性由下面的 hasSecret 断言覆盖 —— 它走主进程侧 getSecret → decrypt。
    //     注意：本字符串是注入的纯 JS，不能出现 TS 语法（如 as / 非空断言）。
    const smokeAfterWrites = expectOk('settings.get#cipher', await window.aurora.settings.get())
    const smokeProviderSeen = smokeAfterWrites && smokeAfterWrites.llm && smokeAfterWrites.llm.providers
      ? smokeAfterWrites.llm.providers['smoke']
      : null
    record(
      'smoke provider 凭据标记为已设置',
      Boolean(smokeProviderSeen && smokeProviderSeen.apiKeySet),
      JSON.stringify(smokeProviderSeen ?? {}).slice(0, 80),
    )
    record(
      'smoke provider 凭据可查询',
      expectOk('settings.hasSecret#smoke', await window.aurora.settings.hasSecret('llm.providers.smoke.apiKey')) === true,
      '',
    )

    // 3.2 把模型配置指回本地桩服务：对话链路（工具循环）需要一个可断言的响应源。
    //     不要带 apiKeyEnc 字段：显式传空串会把刚写入的密文覆盖掉（凭据解耦于业务字段）。
    const repoint = expectOk('settings.update(llm#stub)', await window.aurora.settings.update({
      llm: {
        active: 'smoke',
        providers: {
          smoke: { type: 'openai-compat', baseUrl: STUB_BASE, model: STUB_MODEL, temperature: 0.7 },
        },
      },
    }))
    record('模型配置指向本地桩服务', repoint?.llm?.providers?.smoke?.baseUrl === STUB_BASE, repoint?.llm?.providers?.smoke?.baseUrl ?? '')

    // 4. 模式与引导
    const modes = expectOk('mode.list', await window.aurora.mode.list())
    record('mode.list 返回三个模式', Array.isArray(modes) && modes.length === 3, modes ? modes.map((m) => m.id).join(',') : '')
    // 自测前置已配好感知文件夹与科目，因此 classroom 初始即为就绪
    record('classroom 初始就绪（已配置感知文件夹 + 科目）', modes?.find((m) => m.id === 'classroom')?.ready === true, JSON.stringify(modes?.find((m) => m.id === 'classroom')?.readinessHint ?? null))
    record('当前模式为 classroom', modes?.find((m) => m.active)?.id === 'classroom', modes?.find((m) => m.active)?.id ?? '')

    // 注意：这里**不再**切到 work 再切回来。切换 pattern 会触发
    // onDeactivate/onActivate 与监听器重建，而模式引导的前两步本来就会重写
    // 感知文件夹与科目列表（见下方 answers），两者叠加会让 10.x 的分类断言
    // 依赖"引导猜中的路径"，而不是本轮隔离的临时目录。模式切换本身已由
    // manager.test.ts 完整覆盖。

    const session = expectOk('mode.guideStart', await window.aurora.mode.guideStart('classroom'))
    record('引导第一步为 watch-dir', session?.step?.stepId === 'watch-dir', session?.step?.stepId ?? '')
    const badAnswer = expectOk('mode.guideAnswer(空)', await window.aurora.mode.guideAnswer('classroom', '   '))
    record('空答案被拒绝且不推进', typeof badAnswer?.error === 'string' && badAnswer.session.nextIndex === 0, badAnswer?.error ?? '')

    // 引导答案里的感知文件夹必须是**本轮临时目录**（WATCH_DIR），
    // 否则会把配置改到真实目录：既破坏 userData 隔离，也让并发的两次自测互相干扰。
    const answers = [WATCH_DIR, '数学,物理', '默认', '是']
    let last = null
    for (const answer of answers) {
      last = expectOk('mode.guideAnswer(' + answer + ')', await window.aurora.mode.guideAnswer('classroom', answer))
    }
    record('引导走完四步', last?.session?.completed === true, 'nextIndex=' + (last?.session?.nextIndex ?? '?'))
    record('引导写入感知文件夹（仍是隔离目录）', last?.settings?.modes?.classroom?.watchDir === WATCH_DIR, String(last?.settings?.modes?.classroom?.watchDir))
    record('引导写入科目列表', last?.settings?.modes?.classroom?.subjects?.length === 2, String(last?.settings?.modes?.classroom?.subjects?.length))

    const readyList = expectOk('mode.list#3', await window.aurora.mode.list())
    record('classroom 变为就绪', readyList?.find((m) => m.id === 'classroom')?.ready === true, '')
    expectOk('mode.resetGuide', await window.aurora.mode.resetGuide('classroom'))

    // 5. Skill 清单（内置技能会随版本新增，断言名单存在而非硬编码总数）
    const skills = expectOk('skills.list', await window.aurora.skills.list())
    const skillNames = Array.isArray(skills) ? skills.map((s) => s.name) : []
    const requiredSkills = ['file-classify', 'system-status', 'timetable']
    record(
      'skills.list 含全部基础内置技能',
      requiredSkills.every((name) => skillNames.includes(name)),
      skillNames.join(','),
    )

    // 6. 系统感知
    const summary = expectOk('perception.summary', await window.aurora.perception.summary())
    record('感知含时间与星期', typeof summary?.localTime === 'string' && typeof summary?.weekday === 'string', JSON.stringify(summary?.unknown ?? []))

    // 7. LLM 连接测试（真实网络；失败也必须返回结构化错误而不是抛异常）
    const badTest = await window.aurora.llm.testConnection({ baseUrl: 'https://127.0.0.1:9/v1', apiKey: 'sk-x', model: 'm' })
    record('llm.testConnection 返回结构化结果', badTest && typeof badTest.ok === 'boolean', badTest?.ok ? badTest.message : badTest?.message ?? 'undefined')

    // 8. 窗口状态机（交互窗唯一主对话窗口、提示条两态）
    const win = window.aurora.window
    expectOk('window.show(edge-bar)', await win.show('edge-bar'))
    // 8.1 提示条两态展开（docs/07 §2.2）：只改窗口宽度，**不应改变可见性**
    const barExpanded = expectOk('window.setEdgeBarExpanded(true)', await win.setEdgeBarExpanded(true))
    record('提示条展开后仍可见', barExpanded?.visible['edge-bar'] === true, JSON.stringify(barExpanded))
    const barCollapsed = expectOk('window.setEdgeBarExpanded(false)', await win.setEdgeBarExpanded(false))
    record('提示条收起后仍可见', barCollapsed?.visible['edge-bar'] === true, JSON.stringify(barCollapsed))
    expectOk('window.showChat', await win.showChat())
    const withChat = expectOk('window.getState#2', await win.getState())
    // 交互窗是唯一主对话窗口：show 后可见且 primary=chat，hide 后不可见且 primary 归空。
    // 同时回归 show() 的真实显隐同步（窗口必须真的从桌面上消失）。
    record('window.showChat 后 chat 可见且 primary=chat', withChat?.visible['chat'] === true && withChat?.primary === 'chat', JSON.stringify(withChat))
    expectOk('window.hide(chat)', await win.hide('chat'))
    const hidden = expectOk('window.getState#3', await win.getState())
    record('window.hide(chat) 后 chat 不可见、primary 归空且提示条仍在', hidden?.visible['chat'] !== true && hidden?.primary === null && hidden?.visible['edge-bar'] === true, JSON.stringify(hidden))

    // 9. 真实对话链路（chat:send → 工具循环 → chat:event 流式 → chat:history）
    //    quick 会话由主进程在自测前清空，因此这里的条数断言是确定的。
    const events = []
    const off = window.aurora.chat.onEvent((event) => events.push(event))
    const sent = expectOk('chat.send', await window.aurora.chat.send({ sessionId: 'quick', text: '/system-status 我电脑现在什么状态', origin: 'edge-bar' }))
    if (sent) {
      for (let i = 0; i < 200 && !events.some((e) => e.type === 'done' || e.type === 'error'); i += 1) await wait(50)
    }
    const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('')
    const toolEvents = events.filter((e) => e.type === 'tool')
    const toolStates = events.filter((e) => e.type === 'tool').map((e) => e.call.state).join('>')
    record('chat 流式文本非空', text.length > 0, text.slice(0, 60))
    record('模型回复来自桩服务', text.includes('AURORA_STUB_OK'), text.slice(0, 60))
    record('chat 事件以 done 结束', events.some((e) => e.type === 'done'), events.map((e) => e.type).join('>'))
    record('无 error 事件', !events.some((e) => e.type === 'error'), events.find((e) => e.type === 'error')?.message ?? '')
    record('触发了工具调用（use_skill）', toolEvents.some((e) => e.call.name === 'use_skill'), toolEvents.map((e) => e.call.name).join(','))
    record('工具卡片状态 running→success', toolStates.includes('running') && toolStates.includes('success'), toolStates)
    record('工具卡片带 messageId', toolEvents.every((e) => typeof e.messageId === 'string' && e.messageId.length > 0), '')

    off()

    const history = expectOk('chat.history', await window.aurora.chat.history({ sessionId: 'quick' }))
    record('chat.history 含 user + 两轮助手（3 条）', Array.isArray(history) && history.length === 3, 'len=' + (history ? history.length : '?'))
    record('chat.history 保留工具卡片状态', history?.[1]?.toolCalls?.[0]?.state === 'success', JSON.stringify(history?.[1]?.toolCalls ?? []))

    // 9.1 正文流式（2026-09，docs/06 §16.2）：桩服务把最后一段回复拆成**两条** content 分片，
    //     因此「逐条增量下发」在事件层面必须是 ≥2 条 text 事件 —— 旧的「攒完整段发一次」
    //     在这里只会看到 1 条，是最直接的回归判据。
    const textEvents = events.filter((e) => e.type === 'text')
    record(
      '正文按增量逐条下发（不是等整段说完才发一次）',
      textEvents.length >= 2,
      'textEvents=' + textEvents.length + ' deltas=' + JSON.stringify(textEvents.map((e) => e.delta)),
    )
    // 流式身份：每条增量带的 messageId 必须是**同一轮那一条**，且就是落盘后的助手消息 id ——
    // 这是「边流边渲染的那条消息与磁盘上的是同一条」的依据（id 预领，见 06 §16.2）。
    const textIds = [...new Set(textEvents.map((e) => e.messageId))]
    const storedAssistant = (history ?? []).filter((item) => item.role === 'assistant')
    record(
      '正文增量同轮同 id，且该 id 就是落盘的助手消息 id',
      textIds.length === 1 &&
        typeof textIds[0] === 'string' &&
        textIds[0].length > 0 &&
        storedAssistant.some((item) => item.id === textIds[0]),
      'textIds=' + JSON.stringify(textIds) + ' stored=' + JSON.stringify(storedAssistant.map((i) => i.id)),
    )
    // token 用量：桩服务的结束片带 usage → 必须转成 usage 事件（输入 token = 本轮上下文占用）
    const usageEvents = events.filter((e) => e.type === 'usage')
    record(
      'usage 事件下发（promptTokens 为本轮上下文占用）',
      usageEvents.length >= 1 && usageEvents.every((e) => e.usage.promptTokens > 0 && Number.isInteger(e.round)),
      JSON.stringify(usageEvents.map((e) => ({ round: e.round, usage: e.usage }))),
    )

    // 9.1 第二轮对话：证明上下文可续接（tool 结果留在会话里）
    const secondEvents = []
    const off2 = window.aurora.chat.onEvent((event) => secondEvents.push(event))
    const sent2 = expectOk('chat.send#2', await window.aurora.chat.send({ sessionId: 'quick', text: '再说一句', origin: 'edge-bar' }))
    if (sent2) {
      for (let i = 0; i < 200 && !secondEvents.some((e) => e.type === 'done' || e.type === 'error'); i += 1) await wait(50)
    }
    off2()
    const history2 = expectOk('chat.history#2', await window.aurora.chat.history({ sessionId: 'quick' }))
    record('续接后历史累积到 5 条', Array.isArray(history2) && history2.length === 5, 'len=' + (history2 ? history2.length : '?'))
    record('第二轮无 error', !secondEvents.some((e) => e.type === 'error'), secondEvents.find((e) => e.type === 'error')?.message ?? '')

    // 9.4 子代理链路（docs/06 §19 / §16.1）：父对话派 task → 子代理跑两轮 → 报告回传。
    //     桩服务按标记分流（见 smoke-llm.ts 的 SUBAGENT_TASK_MARKER / SUBAGENT_REPORT_MARKER），
    //     会话 id 单开一个，免得动到上面按条数断言的 quick 会话。
    const subevents = []
    const offSub = window.aurora.chat.onEvent((event) => subevents.push(event))
    const sentSub = expectOk(
      'chat.send(子代理)',
      await window.aurora.chat.send({
        sessionId: 'smoke-subagent',
        text: 'STUB_TASK_MARKER 派个子代理看看',
        origin: 'edge-bar',
      }),
    )
    if (sentSub) {
      for (
        let i = 0;
        i < 400 && !subevents.some((e) => e.type === 'done' || e.type === 'error');
        i += 1
      ) {
        await wait(50)
      }
    }
    offSub()
    const subProgress = subevents.filter((e) => e.type === 'subagent')
    const subTool = subevents.filter((e) => e.type === 'tool' && e.call.name === 'task')
    const seqs = subevents.map((e) => e.seq)
    record(
      '子代理进度事件到达（≥2 次：开始与终态）',
      subProgress.length >= 2,
      'count=' + subProgress.length,
    )
    record(
      '子代理事件早于 task 工具终态卡片',
      subProgress.length > 0 &&
        subTool.some((e) => e.call.state === 'success') &&
        subevents.indexOf(subProgress[0]) <
          subevents.indexOf(subTool.find((e) => e.call.state === 'success')),
      '',
    )
    record(
      '子代理终态带报告与工具步骤',
      (() => {
        const last = subProgress[subProgress.length - 1]
        const snapshot = last?.subagent
        return (
          snapshot?.status === 'success' &&
          (snapshot.report ?? '').includes('STUB_SUB_OK') &&
          snapshot.steps.some((step) => step.kind === 'tool' && step.name === 'list_dir')
        )
      })(),
      JSON.stringify(subProgress[subProgress.length - 1]?.subagent ?? {}).slice(0, 160),
    )
    record(
      'task 工具卡快照随历史持久化（subagent.report）',
      await (async () => {
        const subHistory = expectOk(
          'chat.history(子代理)',
          await window.aurora.chat.history({ sessionId: 'smoke-subagent' }),
        )
        const call = (subHistory ?? [])
          .flatMap((item) => item.toolCalls ?? [])
          .find((item) => item.name === 'task')
        return (call?.subagent?.report ?? '').includes('STUB_SUB_OK')
      })(),
      '',
    )
    record(
      '事件序号单调递增（渲染层排序依据，docs/06 §16.1）',
      seqs.length > 3 && seqs.every((value, index) => index === 0 || value > seqs[index - 1]),
      'n=' + seqs.length,
    )
    // round 只挂在「内容类」事件上：queued / done / user-message 没有轮次概念
    const roundEvents = subevents.filter((e) =>
      ['text', 'tool', 'reasoning', 'subagent', 'usage'].includes(e.type),
    )
    record(
      '内容类事件都带轮次 round，工具事件都带 messageId',
      roundEvents.length > 0 &&
        roundEvents.every((e) => Number.isInteger(e.round) && e.round >= 0) &&
        subTool.every((e) => typeof e.messageId === 'string' && e.messageId.length > 0),
      'n=' + roundEvents.length,
    )

    // 9.2 MCP 状态接口（即使没有配置服务器也必须返回结构化结果而不是抛错）
    const mcpStatus = expectOk('mcp.status', await window.aurora.mcp.status())
    record('mcp.status 返回数组', Array.isArray(mcpStatus), 'len=' + (mcpStatus ? mcpStatus.length : '?'))
    // 9.3 更新状态接口（docs/09）：开发态必须是 disabled 且不抛错；
    //     安装版里的真实检查由 scripts/verify-update.mjs + 打包产物校验覆盖。
    const updateState = expectOk('update.getState', await window.aurora.update.getState())
    record(
      'update.getState 开发态为 disabled',
      updateState?.status === 'disabled' && updateState?.enabled === false,
      JSON.stringify({ status: updateState?.status, enabled: updateState?.enabled, version: updateState?.currentVersion }),
    )
    const updateCheck = expectOk('update.check(开发态)', await window.aurora.update.check())
    record('update.check 开发态安全降级（不联网）', updateCheck?.status === 'disabled', String(updateCheck?.status))

    // 10. 设置页窗口可打开（验证多窗口入口）
    expectOk('window.show(settings)', await win.show('settings'))
    const withSettings = expectOk('window.getState#4', await win.getState())
    record('设置窗可见', withSettings?.visible['settings'] === true, JSON.stringify(withSettings))

    // ───────────────────── 分类管线（P4，docs/05 §3） ─────────────────────
    // 主进程已把感知文件夹指向自测临时目录，并向其中放好待分类文件。
    // 这里只经 IPC 观察结果，不直接触碰文件系统（渲染层本来也没有那个能力）。

    // 10.1 分类事件的推送通道（先订阅，再实时投放文件）
    const clsEvents = []
    const offCls = window.aurora.classification.onEvent((event) => clsEvents.push(event))

    const ledger = expectOk('classification.history', await window.aurora.classification.history())
    record('分类流水可读（数组）', Array.isArray(ledger), 'len=' + (ledger ? ledger.length : '?'))

    const stateEvents = expectOk('classification.state', await window.aurora.classification.state())
    record('分类状态可水合（数组）', Array.isArray(stateEvents), 'len=' + (stateEvents ? stateEvents.length : '?'))

    // 实时投放文件（渲染层无文件系统能力，经自测专用通道写入感知文件夹），
    // 这样验证的是真实的 chokidar add → 分类链路，而非启动时扫描。
    const dropped = expectOk(
      'app.smokeDropFile(数学作业)',
      await window.aurora.app.smokeDropFile({
        fileName: '数学作业.txt',
        content: '一元二次方程练习题\n求根公式',
      }),
    )
    record('待分类文件已投放到感知文件夹', typeof dropped === 'string' && dropped.length > 0, String(dropped))

    const seeded = await waitForClassification(
      (list) => list.some((item) => item.fileName.indexOf('数学作业') === 0 && item.movedTo),
      20000,
    )
    const classified = seeded.find((item) => item.fileName.indexOf('数学作业') === 0)
    record('新文件被自动分类（30s 内）', Boolean(classified), classified ? classified.subject : '未在超时内完成')
    record('判定为数学（文件名命中的科目）', classified?.subject === '数学', String(classified?.subject))
    record('文件已被移动（movedTo 指向科目目录）', Boolean(classified?.movedTo && classified.movedTo.indexOf('数学') >= 0), String(classified?.movedTo))
    record('走了规则判定（未消耗模型调用）', classified?.source === 'rule', String(classified?.source))
    record('分类事件已推送到渲染层', clsEvents.length > 0, 'events=' + clsEvents.length)
    record('事件状态最终为 done', clsEvents.some((event) => event.state === 'done'), clsEvents.map((event) => event.state).join('>'))

    // 10.2 低置信度 → 落「待分类」
    // 判定条件用 **source === 'fallback'**：待分类目录名不会出现在 reason 里
    // （reason 是"模型依据 + 低于阈值说明"），按目录名等会必然等到超时。
    // 同时带上 movedTo：history.append（记录判定结果）发生在真正搬文件**之前**，
    // 只等 source === 'fallback' 会读到移动前的快照，
    // 于是"已移入待分类目录"这条断言会随机拿到 movedTo=undefined。
    // 等终态才能既验证"落到了待分类"，又不会误报。
    const fallbackAttempt = await dropAndWait(
      '低置信扫描件.txt',
      '内容无法辨认',
      (list) =>
        list.some(
          (item) =>
            item.fileName.indexOf('低置信') === 0 && item.source === 'fallback' && item.movedTo,
        ),
      25000,
    )
    const fallback = fallbackAttempt.list
    const fallbackRecord = fallback.find(
      (item) =>
        item.fileName.indexOf('低置信') === 0 && item.source === 'fallback' && item.movedTo,
    )
    record('低置信文件已处理', Boolean(fallbackRecord), fallbackRecord ? fallbackRecord.reason : '未在超时内完成')
    record(
      '低置信落入「待分类」兜底',
      fallbackRecord?.source === 'fallback',
      String(fallbackRecord?.source) + ' attempts=' + fallbackAttempt.attempts,
    )
    // 兜底必须真的**落盘到待分类目录**（只断言 source 无法证明文件搬对了地方）
    record(
      '兜底文件已移入「待分类」目录',
      Boolean(fallbackRecord?.movedTo && fallbackRecord.movedTo.indexOf('待分类') >= 0),
      String(fallbackRecord?.movedTo),
    )
    record(
      '兜底记录未猜科目',
      fallbackRecord?.subject === '' && fallbackRecord?.confidence === 0.1,
      JSON.stringify({ subject: fallbackRecord?.subject, confidence: fallbackRecord?.confidence }),
    )

    // 10.3 用户修正 → 沉淀规则 → 同类文件跳过模型
    const correctedList = expectOk(
      'classification.correct',
      await window.aurora.classification.correct({
        recordId: fallbackRecord ? fallbackRecord.id : 'missing',
        subject: '物理',
      }),
    )
    const corrected = (correctedList || []).find(
      (item) => item.id === (fallbackRecord ? fallbackRecord.id : ''),
    )
    record(
      '修正后标记 corrected 且科目更新',
      corrected?.corrected === true && corrected?.subject === '物理',
      JSON.stringify({ subject: corrected?.subject, corrected: corrected?.corrected }),
    )

    // 同名文件再次出现（同一次运行内的第二份）：应命中「已学习」规则
    const rerunAttempt = await dropAndWait(
      '低置信扫描件.txt',
      '内容仍然无法辨认',
      (list) => list.filter((item) => item.fileName.indexOf('低置信') === 0).length >= 2,
      25000,
    )
    const rerun = rerunAttempt.list
    const rerunRecords = rerun.filter((item) => item.fileName.indexOf('低置信') === 0)
    record(
      '同名文件再次出现并被重新分类',
      rerunRecords.length >= 2,
      'count=' + rerunRecords.length + ' attempts=' + rerunAttempt.attempts +
        ' records=' + JSON.stringify(rerunRecords.map((item) => ({
          id: item.id,
          state: item.reason,
          movedTo: item.movedTo ? 'yes' : 'no',
          modifiedAt: item.modifiedAt ? 'yes' : 'no',
        }))),
    )
    // 刻意按**属性**找而不是取 rerunRecords[0]：修正动作与在途任务可能交错，
    // 列表里还会出现一条 skipped（"处理期间已被移动"）的审计记录，
    // 按位置取会取到它，从而把"规则已生效"误判为失败。
    const ruledRecord = rerunRecords.find(
      (item) => item.source === 'rule' && item.subject === '物理',
    )
    record(
      '规则已学习：第二次走 rule 而非 llm',
      Boolean(ruledRecord),
      JSON.stringify({
        source: ruledRecord ? ruledRecord.source : null,
        subject: ruledRecord ? ruledRecord.subject : null,
        all: rerunRecords.map((item) => item.source + ':' + (item.subject || '-')).join(','),
      }),
    )
    offCls()

    // ───────────────────── 系统感知（P5，docs/06 §8） ─────────────────────

    const perception2 = expectOk('perception.summary#2', await window.aurora.perception.summary())
    record(
      '感知含前台窗口（或明确列为未采集）',
      Boolean(perception2?.foreground) ||
        (perception2?.unknown || []).indexOf('前台窗口') >= 0,
      JSON.stringify(perception2?.foreground ?? perception2?.unknown ?? null),
    )
    record('感知含显示器信息', Boolean(perception2?.display), JSON.stringify(perception2?.display ?? null))
    record('感知含课程表（数组）', Array.isArray(perception2?.lessons), 'lessons=' + (perception2?.lessons ? perception2.lessons.length : '?'))

    // ───────────────────── 课前提醒（P5，docs/05 §3.4） ─────────────────────
    // 自测下主进程把「打开科目文件夹」换成记录回执（不真的弹资源管理器），
    // 因此这里断言真的触发过，且目标目录指向该科目。
    const preClass = await waitForPreClass(50000)
    record('课前提醒已触发', Boolean(preClass), JSON.stringify(preClass))
    record(
      '课前提醒指向正确科目与目录',
      Boolean(preClass && preClass.subject === '数学' && preClass.targetDir.indexOf('数学') >= 0),
      JSON.stringify(preClass),
    )

    // ───────────────────── 敏感工具确认通道（P5，docs/06 §5） ─────────────────────
    // 渲染层只断言订阅面可用（真实确认往返由单测覆盖，
    // 这里若真的触发一次会阻塞 60s 等超时，不适合自测）
    let sensitiveSubscribed = false
    try {
      const offSensitive = window.aurora.proactive.onSensitiveTool(() => undefined)
      sensitiveSubscribed = typeof offSensitive === 'function'
      offSensitive()
    } catch (error) {
      sensitiveSubscribed = false
    }
    record('敏感工具确认订阅面可用', sensitiveSubscribed, String(sensitiveSubscribed))

    // ─────────────── 全局快捷键注册状态（docs/07 §5） ───────────────
    // 只断言通道可用并回传了结构化状态：Alt+Space 是否真的注册成功取决于
    // 运行自测的机器有没有被系统/其他程序占用，"注册失败"也是合法结果。
    const hotkey = expectOk('hotkey.status', await window.aurora.hotkey.status())
    record(
      '快捷键状态可查询（含是否已注册）',
      typeof hotkey === 'object' && hotkey !== null && typeof hotkey.registered === 'boolean',
      JSON.stringify(hotkey),
    )

    // ─────────────── Skill 扫描状态与重扫（docs/06 §6） ───────────────
    const skillsStatus = expectOk('skills.status', await window.aurora.skills.status())
    record(
      'Skill 状态含生效的用户目录',
      Boolean(skillsStatus && skillsStatus.userDir),
      JSON.stringify(skillsStatus && { userDir: skillsStatus.userDir, total: skillsStatus.total }),
    )
    const rescanned = expectOk('skills.rescan', await window.aurora.skills.rescan())
    record(
      'Skill 重扫返回扫描结果',
      Boolean(rescanned && typeof rescanned.total === 'number' && rescanned.scannedAt),
      JSON.stringify(rescanned && { total: rescanned.total, failed: rescanned.failed }),
    )

    // ─────────────── 会话列表与新会话（docs/06 §4） ───────────────
    const sessions = expectOk('chat.sessions', await window.aurora.chat.sessions())
    record(
      '会话列表可读且含 quick 会话',
      Array.isArray(sessions) && sessions.some((item) => item.id === 'quick'),
      JSON.stringify(Array.isArray(sessions) ? sessions.map((item) => item.id) : null),
    )
    const newSessionId = expectOk('chat.newSession', await window.aurora.chat.newSession())
    record(
      '可新建会话并返回新 id',
      typeof newSessionId === 'string' && newSessionId.length > 0 && newSessionId !== 'quick',
      String(newSessionId),
    )

    // ─────────── 归档 / 取消归档往返（docs/06 §4） ───────────
    // 状态写在会话文件自身的 meta 里，而不是配置或 sidecar 索引：因此
    // 「归档 → 重新拉列表」必须能读到标记。这条同时钉住 store 的落盘（await 后才返回）
    // 与 summaries 的透出；取消归档必须可逆（否则归档等于单向删除）。
    const archiveResult = expectOk(
      'chat.archiveSession(归档)',
      await window.aurora.chat.archiveSession({ sessionId: newSessionId, archived: true }),
    )
    const afterArchive = expectOk('chat.sessions(归档后)', await window.aurora.chat.sessions())
    const foundArchived =
      Array.isArray(afterArchive) &&
      afterArchive.find((item) => item.id === newSessionId) !== undefined &&
      afterArchive.find((item) => item.id === newSessionId).archived === true
    record(
      '会话可归档且列表里带 archived 标记',
      archiveResult !== null && archiveResult.archived === true && foundArchived === true,
      JSON.stringify({ archiveResult, foundArchived }),
    )

    const unarchiveResult = expectOk(
      'chat.archiveSession(取消归档)',
      await window.aurora.chat.archiveSession({ sessionId: newSessionId, archived: false }),
    )
    const afterUnarchive = expectOk('chat.sessions(取消归档后)', await window.aurora.chat.sessions())
    const foundUnarchived =
      Array.isArray(afterUnarchive) &&
      afterUnarchive.find((item) => item.id === newSessionId) !== undefined &&
      afterUnarchive.find((item) => item.id === newSessionId).archived !== true
    record(
      '取消归档可逆（列表里不再带归档标记）',
      unarchiveResult !== null && unarchiveResult.archived === false && foundUnarchived === true,
      JSON.stringify({ unarchiveResult, foundUnarchived }),
    )

    // ─────────────── ClassIsland 桥接（docs/05 §3.4 v2） ───────────────
    // 自测前置（seedSmokeClassroom）会把课表来源切到 classisland 并写一份夹具 JSON，
    // 因此这里断言的是**真实读取链路**：写文件 → provider 解析 → 今日课程。
    const bridgeTest = await window.aurora.classisland.test()
    record(
      'ClassIsland 测试连接：读取夹具 JSON 成功',
      bridgeTest.ok === true && bridgeTest.value.ok === true,
      JSON.stringify(bridgeTest.ok ? { lessons: bridgeTest.value.lessons.length, error: bridgeTest.value.error } : bridgeTest),
    )
    const bridgeLessons = bridgeTest.ok ? bridgeTest.value.lessons : []
    record(
      'ClassIsland 今日课程含夹具里的数学课',
      bridgeLessons.some((lesson) => lesson.subject === '数学'),
      JSON.stringify(bridgeLessons.map((lesson) => lesson.startTime + ' ' + lesson.subject)) +
        '｜本地 ' +
        new Date().toLocaleString('zh-CN') +
        ' weekday=' +
        new Date().getDay() +
        '（夹具按今天 / 明天各写一份同一节课：本接口只返回「今日」课程，而课前提醒同时看今天与明天；' +
        '若这条在跨零点时失败，先看这里的时间与夹具的 weekday）',
    )

    const bridgeStatus = expectOk('classisland.status', await window.aurora.classisland.status())
    record(
      'ClassIsland 状态显示已启用且同步成功',
      Boolean(bridgeStatus && bridgeStatus.enabled && bridgeStatus.ok),
      JSON.stringify(bridgeStatus),
    )

    // status 快照 v3（docs/05 §3.4）：夹具里种了 onClass + 当前 / 下节课与三个时间字段，
    // 这里断言它真的透到了 IPC（契约字段，不再是运行时透传）。
    const snapshot = bridgeStatus?.status
    record(
      'ClassIsland 状态透出 v3 快照（含当前的起止时间）',
      snapshot?.version === 3 &&
        snapshot.onClass === true &&
        snapshot.currentSubject === '数学' &&
        typeof snapshot.currentStartTime === 'string' &&
        typeof snapshot.currentEndTime === 'string' &&
        typeof snapshot.nextEndTime === 'string',
      JSON.stringify(snapshot),
    )
    record(
      'classisland:test 也带上同一份快照',
      bridgeTest.ok === true && bridgeTest.value.status?.version === 3,
      JSON.stringify(bridgeTest.ok ? bridgeTest.value.status : bridgeTest),
    )

    // 感知摘要里的课堂状态（v3）：桥接快照 → provider 缓存 → PerceptionSummary.classStatus。
    // 这一条把「装配真的接通了」钉住：只测解析器证明不了 perception 拿到了它。
    const perceptionSummary = expectOk(
      'perception.summary',
      await window.aurora.perception.summary(),
    )
    const classStatus = perceptionSummary?.classStatus
    record(
      '感知摘要包含课堂状态快照（与桥接夹具一致）',
      classStatus?.version === 3 &&
        classStatus.onClass === true &&
        classStatus.currentSubject === '数学',
      JSON.stringify(classStatus),
    )

    // 提醒通道（v3）：夹具没有真实的 ClassIsland 在监听命令，
    // 因此这里只断言「未配置 / 不可达时也是结构化失败而不是抛错」——
    // 真实的端到端弹出验证在真机上做（见桥接插件 README 的「已验证程度」）。
    const notifyAttempt = await window.aurora.classisland.notify({
      title: 'Aurora 自测',
      body: '自测提醒通道（预期：结构化失败，因为自测没有 ClassIsland 消费命令）',
      channel: 'custom',
    })
    record(
      'classisland:notify 通道可用且回结构化结果（不抛错）',
      notifyAttempt.ok === true &&
        typeof notifyAttempt.value.ok === 'boolean' &&
        typeof notifyAttempt.value.elapsedMs === 'number',
      JSON.stringify(notifyAttempt.ok ? notifyAttempt.value : notifyAttempt),
    )

    // ─────────────── 日志目录通道（原死通道） ───────────────
    // 只断言通道存在且返回结构化结果：真的打开资源管理器在无头环境没有意义。
    const openLogs = await window.aurora.app.openLogs()
    record(
      'openLogs 通道已接通（不再挂起）',
      typeof openLogs === 'object' && openLogs !== null && typeof openLogs.ok === 'boolean',
      JSON.stringify(openLogs && { ok: openLogs.ok }),
    )

    // 11. 清理自测写入的配置
    //     （"密文确实落库且可解密"由 hasSecret#smoke / update(llm#stub) 两条断言覆盖：
    //      它们走的是主进程侧 getSecret → decrypt，渲染层只见布尔值。）
    expectOk('settings.clearSecret', await window.aurora.settings.clearSecret('llm.providers.smoke.apiKey'))

    return { results }
  } catch (error) {
    return { fatal: String(error && error.stack ? error.stack : error), results }
  }
})()
`
}
