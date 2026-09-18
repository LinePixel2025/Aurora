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

export const SMOKE_FLAG = 'AURORA_SMOKE'
export const SMOKE_RESULT_PREFIX = 'AURORA_SMOKE_RESULT:'

/**
 * 注入到渲染进程执行的自测脚本（字符串形式，避免被打包器当作模块依赖）。
 * `stubBaseUrl` / `stubModel` 由主进程在启动本地桩 LLM 后传入：
 * 对话链路需要一个**离线可断言**的响应源。
 */
export function smokeScript(stubBaseUrl: string, stubModel: string): string {
  return String.raw`
(async () => {
  const STUB_BASE = ${JSON.stringify(stubBaseUrl)}
  const STUB_MODEL = ${JSON.stringify(stubModel)}
  const results = []
  const record = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })
  const expectOk = (name, result) => {
    if (result && result.ok) return result.value
    record(name, false, result ? result.message : 'result 为 undefined')
    return null
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
      record('settings.get.version', settings.version === 1, String(settings.version))
      record('settings.get 科目模板', settings.modes.classroom.subjects.length === 9, String(settings.modes.classroom.subjects.length))
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
          [freshProviderId]: { type: 'openai-compat', baseUrl: STUB_BASE, apiKeyEnc: '', model: 'fresh-model', temperature: 0.5 },
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
          [freshProviderId]: { type: 'openai-compat', baseUrl: STUB_BASE, model: 'renamed-model', temperature: 0.5 },
        },
      },
    }))
    record(
      '改模型名后凭据仍在',
      rename?.llm?.providers?.[freshProviderId]?.model === 'renamed-model' &&
        expectOk('settings.hasSecret#rename', await window.aurora.settings.hasSecret('llm.providers.' + freshProviderId + '.apiKey')) === true,
      'model=' + (rename?.llm?.providers?.[freshProviderId]?.model ?? '?'),
    )
    const freshRemove = { ...(freshSave?.llm?.providers ?? {}) }
    delete freshRemove[freshProviderId]
    expectOk('settings.update(清理全新 provider)', await window.aurora.settings.update({
      llm: { active: 'smoke', providers: freshRemove },
    }))

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
    record('classroom 未就绪（缺感知文件夹）', modes?.find((m) => m.id === 'classroom')?.ready === false, '')

    expectOk('mode.set(work)', await window.aurora.mode.set('work'))
    expectOk('mode.set(classroom)', await window.aurora.mode.set('classroom'))
    const afterSwitch = expectOk('mode.list#2', await window.aurora.mode.list())
    record('模式切换回 classroom', afterSwitch?.find((m) => m.active)?.id === 'classroom', afterSwitch?.find((m) => m.active)?.id ?? '')

    const session = expectOk('mode.guideStart', await window.aurora.mode.guideStart('classroom'))
    record('引导第一步为 watch-dir', session?.step?.stepId === 'watch-dir', session?.step?.stepId ?? '')
    const badAnswer = expectOk('mode.guideAnswer(空)', await window.aurora.mode.guideAnswer('classroom', '   '))
    record('空答案被拒绝且不推进', typeof badAnswer?.error === 'string' && badAnswer.session.nextIndex === 0, badAnswer?.error ?? '')

    const answers = ['D:\\\\Aurora\\\\感知文件夹', '数学,物理', '默认', '是']
    let last = null
    for (const answer of answers) {
      last = expectOk('mode.guideAnswer(' + answer + ')', await window.aurora.mode.guideAnswer('classroom', answer))
    }
    record('引导走完四步', last?.session?.completed === true, 'nextIndex=' + (last?.session?.nextIndex ?? '?'))
    record('引导写入感知文件夹', last?.settings?.modes?.classroom?.watchDir === 'D:\\\\Aurora\\\\感知文件夹', String(last?.settings?.modes?.classroom?.watchDir))
    record('引导写入科目列表', last?.settings?.modes?.classroom?.subjects?.length === 2, String(last?.settings?.modes?.classroom?.subjects?.length))

    const readyList = expectOk('mode.list#3', await window.aurora.mode.list())
    record('classroom 变为就绪', readyList?.find((m) => m.id === 'classroom')?.ready === true, '')
    expectOk('mode.resetGuide', await window.aurora.mode.resetGuide('classroom'))

    // 5. Skill 清单
    const skills = expectOk('skills.list', await window.aurora.skills.list())
    record('skills.list 返回 3 个内置技能', Array.isArray(skills) && skills.length === 3, skills ? skills.map((s) => s.name).join(',') : '')

    // 6. 系统感知
    const summary = expectOk('perception.summary', await window.aurora.perception.summary())
    record('感知含时间与星期', typeof summary?.localTime === 'string' && typeof summary?.weekday === 'string', JSON.stringify(summary?.unknown ?? []))

    // 7. LLM 连接测试（真实网络；失败也必须返回结构化错误而不是抛异常）
    const badTest = await window.aurora.llm.testConnection({ baseUrl: 'https://127.0.0.1:9/v1', apiKey: 'sk-x', model: 'm' })
    record('llm.testConnection 返回结构化结果', badTest && typeof badTest.ok === 'boolean', badTest?.ok ? badTest.message : badTest?.message ?? 'undefined')

    // 8. 窗口状态机（含迷你窗/交互窗互斥）
    const win = window.aurora.window
    expectOk('window.show(service-dock)', await win.show('service-dock'))
    expectOk('window.show(edge-bar)', await win.show('edge-bar'))
    expectOk('window.showMiniChat', await win.showMiniChat())
    const withMini = expectOk('window.getState', await win.getState())
    record('迷你窗可见且 primary=mini-chat', withMini?.visible['mini-chat'] === true && withMini?.primary === 'mini-chat', JSON.stringify(withMini))
    expectOk('window.showChat', await win.showChat())
    const withChat = expectOk('window.getState#2', await win.getState())
    record('交互窗与迷你窗互斥', withChat?.visible['chat'] === true && withChat?.visible['mini-chat'] === false, JSON.stringify(withChat))
    expectOk('window.hide(service-dock)', await win.hide('service-dock'))
    const hidden = expectOk('window.getState#3', await win.getState())
    record('隐藏服务窗后迷你窗也隐藏', hidden?.visible['chat'] === true, JSON.stringify(hidden))

    // 9. 真实对话链路（chat:send → 工具循环 → chat:event 流式 → chat:history）
    //    quick 会话由主进程在自测前清空，因此这里的条数断言是确定的。
    const events = []
    const off = window.aurora.chat.onEvent((event) => events.push(event))
    const sent = expectOk('chat.send', await window.aurora.chat.send({ sessionId: 'quick', text: '/system-status 我电脑现在什么状态', origin: 'service-dock' }))
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

    // 9.1 第二轮对话：证明上下文可续接（tool 结果留在会话里）
    const secondEvents = []
    const off2 = window.aurora.chat.onEvent((event) => secondEvents.push(event))
    const sent2 = expectOk('chat.send#2', await window.aurora.chat.send({ sessionId: 'quick', text: '再说一句', origin: 'service-dock' }))
    if (sent2) {
      for (let i = 0; i < 200 && !secondEvents.some((e) => e.type === 'done' || e.type === 'error'); i += 1) await wait(50)
    }
    off2()
    const history2 = expectOk('chat.history#2', await window.aurora.chat.history({ sessionId: 'quick' }))
    record('续接后历史累积到 5 条', Array.isArray(history2) && history2.length === 5, 'len=' + (history2 ? history2.length : '?'))
    record('第二轮无 error', !secondEvents.some((e) => e.type === 'error'), secondEvents.find((e) => e.type === 'error')?.message ?? '')

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
