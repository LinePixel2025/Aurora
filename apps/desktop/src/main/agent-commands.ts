/**
 * 内置 Agent 斜杠命令（`/init`，2026-10-03，docs/06 §6）。
 *
 * 与技能（`packages/agent-core/src/skills/bridge.ts` 的 `/技能名`）不同，`/init` 不是
 * 注册在技能表里的条目，而是**主进程识别后改写本轮请求**的内置命令：
 * 渲染层照常把 `/init` 三个字符发出去（用户气泡显示的就是 `/init`），`ipc.ts` 的
 * `chat:send` 在透传前识别它、把初始化指令拼进 `extraContext`（与技能正文同一通道，
 * 只影响本轮请求、随用户消息一起进模型）。
 *
 * 纯函数 + 无 IO：边界根由调用方解析（`sessionProjects.boundaryRoot` 的回落链），
 * 这里只负责拼装指令文本 —— 方便单测，也让「命令改写」这件事有一个唯一的家。
 */

/** 是否为内置 `/init` 命令（只认整串；`/init xxx` 不算 —— 没有参数语义） */
export function isInitCommand(text: string): boolean {
  return text.trim() === '/init'
}

export interface InitCommandContext {
  /** 会话边界根（绝对路径）：AGENTS.md 的生成目标目录 */
  root: string
  /** 该根是否为「项目根」（绑定了项目）；Agent / Work 空间的固定目录传 false */
  isProjectRoot: boolean
}

/**
 * `/init` 的指令正文（作为 extraContext 随本轮用户消息进模型）。
 *
 * 要求模型：先探查、再写、不覆盖已有内容 —— AGENTS.md 是**约定文件**
 * （`packages/agent-core/src/project/agentsFile.ts` 逐层收集后注入 systemPrompt），
 * 生成质量直接决定之后每一轮请求的项目认知，所以指令把「简短、可执行、不臆造」
 * 写成硬要求。写入走模型自己的 `write_file`（受权限档 / 项目根边界约束，
 * 这里不开任何旁路）。
 */
export function buildInitCommandContext(input: InitCommandContext): string {
  const scopeNote = input.isProjectRoot
    ? '当前会话绑定了一个项目，AGENTS.md 应生成在下面的项目根目录。'
    : '当前会话没有绑定项目，下面的目录是本会话的工作空间根（Agent 空间固定目录）；' +
      '如果用户其实想为某个项目生成 AGENTS.md，请先说明这一点并建议他绑定项目。'
  return [
    '【内置命令 /init：为当前项目生成 AGENTS.md】',
    scopeNote,
    `目标目录：${input.root}`,
    '请按以下步骤执行：',
    '1. 先探查目录内容（读 package.json / 配置文件 / 主要子目录的 README），弄清这是什么项目、用什么技术栈；',
    '2. 若该目录已存在 AGENTS.md：先读它，在其基础上**补充与修正**（构建命令、目录职责、代码约定里过时或缺失的部分），不要整份推翻重写；',
    '3. 若不存在：新建一份 AGENTS.md，用中文、尽量简短（不超过 60 行），至少包含：项目一句话说明、常用命令（安装 / 构建 / 测试 / lint）、目录职责一览、必须遵守的约定；',
    '4. 只写你从文件里读到的事实，禁止臆造命令或约定；探查不出的小节直接省略，不要留占位文字；',
    '5. 写完后用两三句话向用户总结你写了什么、放在哪里。',
  ].join('\n')
}
