/**
 * 「Agent 可修改的设置」清单（docs/06 §17）。
 *
 * 固定的中文清单，经 `KernelAgentHost` 的 `settingsHint` 依赖**注入（正式通道）**，
 * 由 agent-core 的 buildSystemPrompt 渲染成独立小节，让模型知道自己能用
 * `set_setting` 改什么：与 shared 的 `WRITABLE_PATH_OVERRIDES`（显式可写覆盖表）
 * 保持同一口径，凭据类路径（`*.providers.*`）一律只读。清单是静态的 ——
 * 覆盖表由 Schema 兜底校验，工具端口（tools/settings-port.ts）无论清单怎么说
 * 都只认 `canWriteSettingPath` 的判定，因此提示词与真实可写面不会出现
 * 「说能改但不能改」的安全缺口（最多是「能改但没说」）。
 *
 * 注：早期经 `composeModePrompt()` 附加在 modePrompt 之后的旁路已删除
 * （docs/06 §17），本文件只保留 `SETTINGS_HINT` 常量。
 */

export const SETTINGS_HINT = [
  '你可以用 `set_setting` 工具修改以下设置（改动即时生效，无需重启；改前先告知用户）：',
  '- llm.providers.<id>.model / modelParams.<modelId>.reasoningEffort（模型与思考等级；baseUrl / API Key 等凭据一律只读）',
  '- tts.enabled / active / autoRead / maxChars（语音朗读）',
  '- stt.enabled / active（语音输入开关与默认识别模型）',
  '- imagegen.enabled / active（图像生成开关与默认生图模型）',
  '- general.edgeBar.enabled / opacity / quietHours / display / position（提示条开关、透明度、勿扰时段与贴附的显示器 / 屏幕侧）',
  '- general.gameMode.enabled（游戏模式联动开关）',
  '- general.chat.showThinking（对话界面是否展示思考过程）',
  '- appearance.theme / accent / glass / awarenessGlow（界面明暗档位：system / light / dark；强调色：aurora / teal / violet / rose / amber；毛玻璃开关；文件自感知流光特效开关；也可以用 set_appearance 工具改这四项）',
  '- notifications.channel（默认提醒方式：system 系统通知 / banner 流光提醒 / both 两者都发 / off 不打扰）',
  '- modes.current（切换当前模式）',
  '- modes.classroom.*（课堂模式设置：watchDir、subjects、schedule.*、preClassReminder、preClassLeadMinutes、preClassOpenFolder、classification.*）',
  // `agent.tools` 一律逐条列举，**不用通配写法**：`terminal` 下现在还有**只读**的
  // `terminal.allowPatterns`（v12 的免确认命令模式），写成通配会出现「说能改但不能改」的
  // 偏差（见 docs/06 §17）。清单口径与 Schema 的 `WRITABLE_PATH_OVERRIDES` 保持一致。
  '- agent.tools.enabled / workspaceDir（电脑操控工具总开关与默认工作目录）',
  '- agent.tools.terminal.enabled / timeoutMs / maxOutputChars（终端工具开关、命令超时与输出上限）',
  '- agent.tools.files.enabled / maxReadBytes（文件读写工具开关与单次读取上限）',
  '- agent.tools.search.enabled / maxResults（文件检索工具开关与结果条数上限）',
  '- agent.tools.open.enabled（「打开路径」工具开关）',
  '- skills.userDir / disabled（用户技能目录与停用列表）',
  '- advanced.quietHours（全局勿扰时段）',
  // 只读的自我提权路径**刻意不入上面的可改清单**：项目根同时决定注入的指令与权限边界、
  // Work 工作目录（`modes.work.workspaceDir`）是这条边界根回落链的一级，
  // 权限档位与各类确认闸门是 Agent 自己的闸门，循环预算与写前快照（`agent.loop.*` /
  // `agent.snapshots.*`）则是"该停下来问用户"与"写坏了能回滚"的最后兜底（docs/06 §12.2 / §5.1 / §11.8）。
  // 这里各补一句话，免得模型反复尝试必然被拒绝的写入。
  '项目（projects.*）、权限档位（agent.permissionMode）与确认闸门（advanced.confirmSensitiveTools、agent.tools.terminal.allowPatterns）一律只读：',
  'Work 模式的工作目录（modes.work.workspaceDir）同样一律只读 —— 它是权限边界根的一级，改它等于把免确认范围扩到任意目录：',
  '循环预算（agent.loop.*）、写前快照（agent.snapshots.*）与管理员提权（general.requireAdmin）同样一律只读：',
  '内置浏览器能力（agent.browser.*）同样一律只读 —— 它默认开启，但能否操作网页、最多开几个会话只能由用户在设置页调整：',
  '文件自感知（fileAwareness.*）同样一律只读 —— 它会读取文件、发送正文并安排后台分析，必须由用户在设置页显式开启：',
  '改它们等于改你自己的指令面、摘掉自己的确认闸门，或绕过预算与回滚的兜底，需要用户去设置页操作。',
  '所有凭据类路径（llm/tts/stt/imagegen 的 providers 子树、mcp.servers）一律只读：',
  '用户要求修改密钥时，请引导他去设置页操作。',
].join('\n')
