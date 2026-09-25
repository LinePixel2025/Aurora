/**
 * 「Agent 可修改的设置」清单（Design/betav2-spec.md §6.4、docs/06 §16）。
 *
 * 固定的中文清单，注入 systemPrompt 让模型知道自己能用 `set_setting` 改什么：
 * 与 shared 的 `WRITABLE_PATH_OVERRIDES`（显式可写覆盖表）保持同一口径，
 * 凭据类路径（`*.providers.*`）一律只读。清单是静态的 —— 覆盖表由 Schema 兜底校验，
 * 工具端口（tools/settings-port.ts）无论清单怎么说都只认 `canWriteSettingPath` 的判定，
 * 因此提示词与真实可写面不会出现「说能改但不能改」的安全缺口（最多是「能改但没说」）。
 *
 * 注入方式：`agent-core` 的 `SystemPromptParts.settingsHint` 已定义，但
 * `KernelAgentHost` 尚未开放该字段的装配入口（v8 中间态）—— 因此主进程把这段
 * 清单**附加在 modePrompt 之后**携带（buildSystemPrompt 会把它渲染成独立小节）；
 * agent-core 补上正式通道后应改走 `settingsHint` 字段并删除 `composeModePrompt`。
 */

export const SETTINGS_HINT = [
  '你可以用 `set_setting` 工具修改以下设置（改动即时生效，无需重启；改前先告知用户）：',
  '- llm.providers.<id>.model / reasoningEffort / temperature（模型与采样参数；baseUrl / API Key 等凭据一律只读）',
  '- tts.enabled / active / autoRead / maxChars（语音朗读）',
  '- stt.enabled / active（语音输入开关与默认识别模型）',
  '- imagegen.enabled / active（图像生成开关与默认生图模型）',
  '- general.edgeBar.enabled / opacity / quietHours（提示条开关、透明度与勿扰时段）',
  '- general.chat.showThinking（对话界面是否展示思考过程）',
  '- modes.current（切换当前模式）',
  '- modes.work.workspaceDir（Work 模式的工作目录）',
  '- modes.classroom.*（课堂模式设置：watchDir、subjects、schedule.*、preClassReminder、preClassOpenFolder、classification.*）',
  '- agent.tools.enabled / workspaceDir / terminal.* / files.* / open.*（电脑操控工具的开关与上限）',
  '- skills.userDir / disabled（用户技能目录与停用列表）',
  '- advanced.quietHours（全局勿扰时段）',
  '所有凭据类路径（llm/tts/stt/imagegen 的 providers 子树、mcp.servers）一律只读：',
  '用户要求修改密钥时，请引导他去设置页操作。',
].join('\n')

/**
 * 把「Agent 可修改的设置」小节附加到模式提示词之后（作为独立 `##` 小节渲染）。
 * 模式提示词为空时返回空串 —— `buildSystemPrompt` 对空 modePrompt 会整段省略，
 * 此时设置清单随之下省（实际模式的 systemPrompt 永远非空，这里是防御）。
 */
export function composeModePrompt(modePrompt: string): string {
  const base = modePrompt.trim()
  if (base === '') return ''
  return `${base}\n\n## Agent 可修改的设置\n${SETTINGS_HINT}`
}
