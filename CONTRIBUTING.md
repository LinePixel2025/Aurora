# 贡献指南

感谢你考虑为 **Aurora** 贡献代码、文档或场景反馈。Aurora 是一款常驻 Windows 托盘的
系统级 AI Agent（Electron + Vue 3 + TypeScript，pnpm workspace monorepo），由单人长期维护。
无论是一个 Bug 报告、一次文档修正，还是一个插件，都同样有价值。

参与本项目即表示你同意遵守 [行为准则](./CODE_OF_CONDUCT.md)。

---

## 贡献方式

| 方式 | 入口 | 说明 |
|---|---|---|
| 报告 Bug | [新建 Bug Issue](https://github.com/LinePixel2025/Aurora/issues/new?template=bug_report.yml) | 附版本、复现步骤与脱敏后的日志片段 |
| 功能建议 | [新建功能 Issue](https://github.com/LinePixel2025/Aurora/issues/new?template=feature_request.yml) | 说明真实使用场景与预期行为 |
| 文档修正 | [新建文档 Issue](https://github.com/LinePixel2025/Aurora/issues/new?template=docs.yml) / 直接 PR | `docs/` 是单一事实来源，修正错漏同样重要 |
| 插件 | [插件开发指南](./docs/15-plugin-development-guide.md) | 不必改仓库源码，按清单贡献工具 / 面板 / 小组件 |
| 代码 | 从 `main` 开短命分支提 PR | 先读下文「代码约定」与「分支与提交」 |
| 安全漏洞 | [SECURITY.md](./SECURITY.md) | **不要开公开 Issue**，走私密漏洞报告 |

---

## 环境要求

- **Windows 10 / 11 x64**（本项目的唯一正式支持平台）
- **Node.js >= 20.19**（见根 `package.json` 的 `engines`）
- **pnpm 11.15.1**：执行一次 `corepack enable` 即可，版本由 `packageManager` 字段钉住
- 首次 `pnpm install` 会下载 Electron 运行时（约 100 MB）
- Office 结构化能力依赖固定版本 OfficeCLI：`pnpm officecli:fetch`

macOS / Linux 不是支持目标：窗口材质、Computer Use、自动化等都依赖 Win32 行为。

---

## 本地开发

```bash
pnpm install          # 安装依赖（含 Electron 运行时）
pnpm dev              # Electron 开发：主进程 / preload / 渲染层 HMR
pnpm build            # 三个包 + Electron 产物（apps/desktop/out）
pnpm typecheck        # 全仓 tsc / vue-tsc
pnpm test             # Vitest 全量单测
pnpm lint             # ESLint
pnpm format           # Prettier 写入（无分号、单引号、100 列、LF）
```

常用验收命令：

| 命令 | 用途 |
|---|---|
| `pnpm verify` | 真实磁盘配置层验收（需先 `pnpm build`） |
| `pnpm verify:plugin <目录\|zip>` | 插件包独立校验（共用 shared 清单 schema） |
| `$env:AURORA_SMOKE='1'; pnpm dev` | 真实 Electron + IPC 端到端自测（约 40s，结果在 `%TEMP%\aurora-smoke-logs`） |
| `$env:AURORA_CAPTURE="$env:TEMP\aurora-capture"; pnpm dev` | 四窗 / 设置页 / 各条 DOM 探针场景截图并写 `report.json` |
| `pnpm --filter @aurora/center build && pnpm --filter @aurora/center verify:web` | Center 网页端视觉 + 行为验收 |

跑单个测试文件用 `pnpm vitest run <文件路径>`。**不要**用 `pnpm --filter @aurora/<pkg> test`：
根 `vitest.config.ts` 的 `include` 是根相对路径，在包目录下执行匹配不到任何用例。

> **全新克隆先构建工作区包**：包之间经 `package.json` 的 `main` / `types` 指向 `dist`，
> 没有 `dist/` 时 `pnpm typecheck` / `pnpm test` 会报 `TS2307: Cannot find module '@aurora/shared'`。
> 先跑一次 `pnpm build:packages` 即可（CI 已内置这一步）。

---

## 提交前检查

PR 不是强制门禁，检查靠本地命令。**至少**跑通 CI 同款五项：

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

额外建议：

- 前端改动：跑一次定向截图（`AURORA_CAPTURE_ONLY`），视觉验收基线见 [docs/07 §5.3](./docs/07-ui-spec.md)
- 涉及 `packages/shared/src/browser/**`：桌面与 Center Web **两端**都要截图核对（单源资产）
- 涉及配置 Schema / IPC 契约 / 发布流程：先读 [AGENTS.md](./AGENTS.md) 与对应文档分册
- 准备合并或发布前再跑全量冒烟与全量截图；迭代期只跑定向，别每轮都全量

CI（`.github/workflows/ci.yml`）刻意**按需触发**，不跟随 push / PR 自动运行，原理见
[docs/09 §2](./docs/09-packaging-release.md)。需要云端干净环境时手动发起：
`gh workflow run ci.yml --ref <分支>`。

---

## 代码约定

本仓库的硬规则集中在 [AGENTS.md](./AGENTS.md)，改代码前请完整读一遍。最容易踩的几条：

- **TypeScript strict**：开启 `verbatimModuleSyntax`、`noUncheckedIndexedAccess`、`noImplicitOverride`；
  ESLint 强制 `consistent-type-imports`，未用变量用 `_` 前缀。
- **格式**：Prettier 无分号、单引号、`printWidth: 100`、尾逗号 all、LF。`.vue` 模板不要写多语句内联处理器。
- **纯 Node 边界**：`packages/agent-core` 与 `packages/modes` 不得依赖 Electron / DOM。
- **preload 自包含**：改 IPC 契约必须同时改 `packages/shared/src/ipc/channels.ts` 与
  `apps/desktop/src/preload/channels.ts`（两侧有编译期双向断言）。
- **渲染层只允许类型导入**：运行时值走 `@aurora/shared/browser` 子路径，否则会把 `node:fs` 拉进浏览器 bundle。
- **配置 Schema 改动**：走 `migrations.ts` 版本迁移链，推进 `CONFIG_VERSION`，同步 `docs/08 §1`。
- **中文文档与注释为主**：新增的公共 API 请写清意图与边界，避免只复述代码。
- **日志**：业务包只依赖 `@aurora/shared` 的 `Logger` 接口，不要 `console.log` 当正式日志。
- **凭据**：绝不落明文；新增密文路径要同步 `SettingsStore` 的 4 处加主进程脱敏。

---

## 分支与提交

- 默认在 `main` 主干开发。以下**四类高风险改动**先开短命分支 `risk/<主题>` 并走自审 PR：
  配置 Schema 迁移、IPC 契约、两端共享渲染资产（`packages/shared/src/browser/**`）、发布流程。
- 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)，描述用中文：
  `feat(v0.6.5): 新增 …` / `fix: …` / `docs: …` / `chore: …`。
- **一个功能 / 修复一个 commit**，整体 revert 不夹带无关改动。
- 合并一律 **squash**，保持 `main` 线性；合并后删除分支，不建 `develop` / `release` 长期分支。
- 分支名与提交信息请勿包含表情符号或与内容无关的编号。

---

## 文档先行

[`docs/`](./docs/README.md) 是项目的**单一事实来源**。改配置 Schema、IPC 契约、窗口交互前，
**先改文档再改代码**；用户可见的行为变化同时更新 README 与用户手册（`docs/10`）。
文档里的路径与数字（基线条数、迁移版本号）必须与代码一致。

---

## 测试

- 新增行为请补单测；修 Bug 请补能复现该 Bug 的回归用例。
- 基线测试不绿时先修基线，不要在红基线上叠加改动。
- 验收口径变化必须同步夹具，否则会变成长期「恒红」噪音。
- 探针 / 截图场景以 `report.json` 的 `count` 与 `ok` 为准，退出码 0 不等于截到了。

---

## 插件贡献

插件不必进入本仓库，可以独立分发。开发时建议：

- 用 [`plugin-dev-kit/`](./plugin-dev-kit/README.md) 的 `create-plugin` 脚手架与 `check-plugin` 校验；
- 贡献入口只写在 `manifest.json`，运行期不动态注册；工具名统一 `plugin.<id>.<name>`；
- 权限取最小集，默认 `confirm`；页面型插件运行在沙箱 iframe；
- 记住**安装即信任**：插件进程不是 OS 沙箱，文档与安装弹窗都要如实说明。

---

## 发布

发布由维护者负责：`scripts/release.mjs` 会打包、写 `docs/release-notes/vX.Y.Z.md`、
打 annotated tag 并双投 GitHub Releases 与 Aurora Center。**请勿自行创建 tag 或发布安装包**；
普通贡献者无需关心发布流程，只需保证本地检查全绿。

---

## 许可

Aurora 以 [MIT License](./LICENSE) 开源。提交 Pull Request 即表示你同意你的贡献按 MIT 许可发布。
本项目**不要求签署 CLA**。

---

## 联系方式

- 一般问题：GitHub Issues（附版本与环境）
- 安全漏洞：见 [SECURITY.md](./SECURITY.md)，请勿公开
- 行为准则事件：见 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) 的执行条款
