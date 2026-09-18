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

/** 注入到渲染进程执行的自测脚本（字符串形式，避免被打包器当作模块依赖） */
export const SMOKE_SCRIPT = String.raw`
(async () => {
  const results = []
  const record = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })
  const expectOk = (name, result) => {
    if (result && result.ok) return result.value
    record(name, false, result ? result.message : 'result 为 undefined')
    return null
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  if (!window.aurora) {
    return { fatal: 'window.aurora 未暴露：preload 加载失败' }
  }

  try {
    // 1. 应用信息
    const info = expectOk('app.getInfo', await window.aurora.app.getInfo())
    if (info) {
      record('app.getInfo.platform', typeof info.platform === 'string' && info.platform.length > 0, info.platform)
      record('app.getInfo.cryptoAvailable', info.cryptoAvailable === true, String(info.cryptoAvailable))
      record('app.getInfo.userDataDir 指向 Aurora', /Aurora$/i.test(info.userDataDir), info.userDataDir)
    }

    // 2. 配置读写（IPC 层）
    const settings = expectOk('settings.get', await window.aurora.settings.get())
    if (settings) {
      record('settings.get.version', settings.version === 1, String(settings.version))
      record('settings.get 科目模板', settings.modes.classroom.subjects.length === 9, String(settings.modes.classroom.subjects.length))
      record('settings.get 不回传密文', settings.llm.providers === undefined || Object.values(settings.llm.providers).every((p) => p.apiKeyEnc === ''), 'apiKeyEnc 已清空')
    }

    // 3. 写入模型配置（含凭据加密）
    const update = expectOk('settings.update(llm)', await window.aurora.settings.update({
      llm: {
        active: 'smoke',
        providers: {
          smoke: { type: 'openai-compat', baseUrl: 'https://api.deepseek.com', apiKeyEnc: '', model: 'deepseek-chat', temperature: 0.7 },
        },
      },
    }))
    if (update) record('settings.update 生效', update.llm.active === 'smoke', update.llm.active)

    const secrets = expectOk('settings.setSecrets', await window.aurora.settings.setSecrets({
      'llm.providers.smoke.apiKey': 'sk-smoke-plaintext-marker',
    }))
    if (secrets) record('setSecrets 已加密落盘', secrets.persisted === true, JSON.stringify(secrets.paths))

    record('hasSecret 可查询', expectOk('settings.hasSecret', await window.aurora.settings.hasSecret('llm.providers.smoke.apiKey')) === true, '')
    record('app.getInfo.needsOnboarding 变为 false', expectOk('app.getInfo#2', await window.aurora.app.getInfo())?.needsOnboarding === false, '')

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

    // 9. 对话占位链路（chat:send → chat:event 流式）
    const events = []
    const off = window.aurora.chat.onEvent((event) => events.push(event))
    const sent = expectOk('chat.send', await window.aurora.chat.send({ sessionId: 'quick', text: '我电脑现在什么状态', origin: 'service-dock' }))
    if (sent) {
      for (let i = 0; i < 60 && !events.some((e) => e.type === 'done'); i += 1) await wait(50)
    }
    off()
    const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('')
    record('chat 流式文本非空', text.length > 0, text.slice(0, 40))
    record('占位回复引用了真实感知/模式', /系统状态|当前模式/.test(text), '')
    record('chat 事件以 done 结束', events.some((e) => e.type === 'done'), events.map((e) => e.type).join('>'))

    // 10. 设置页窗口可打开（验证多窗口入口）
    expectOk('window.show(settings)', await win.show('settings'))
    const withSettings = expectOk('window.getState#4', await win.getState())
    record('设置窗可见', withSettings?.visible['settings'] === true, JSON.stringify(withSettings))

    // 11. 清理自测写入的配置
    expectOk('settings.clearSecret', await window.aurora.settings.clearSecret('llm.providers.smoke.apiKey'))

    return { results }
  } catch (error) {
    return { fatal: String(error && error.stack ? error.stack : error), results }
  }
})()
`
