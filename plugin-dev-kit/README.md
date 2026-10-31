# Aurora 插件开发工具包（v0.5.9）

这是一个**可整体拷走**的插件开发工具包：把整个目录复制到任意工作目录，让编码 Agent
先读 [AGENTS.md](./AGENTS.md) 与 [PROMPT.md](./PROMPT.md)，再以 [template/](./template) 为起点开发即可，
不需要 Aurora 源码。

## 目录

| 路径 | 内容 |
| --- | --- |
| [README.md](./README.md) | 本说明：如何开始、如何校验、如何打包安装 |
| [AGENTS.md](./AGENTS.md) | **给编码 Agent 的硬规则**（清单优先、权限、安全、验收） |
| [PROMPT.md](./PROMPT.md) | 可直接粘贴的提示词：新建插件 / 加小组件 / 加事件推送 / 代码审查 |
| [CHECKLIST.md](./CHECKLIST.md) | 提交前验收清单 |
| [docs/01-contract.md](./docs/01-contract.md) | 插件契约全文（进程、RPC、权限、清单、面板、页面、市场、安全） |
| [docs/02-guide.md](./docs/02-guide.md) | 插件开发指南全文（逐节怎么用 API） |
| [template/](./template) | 最小可运行模板：工具 + 面板 + 桌面小组件 + 提示条小组件 + 契约类型 |
| [examples/class-board/](./examples/class-board) | 完整示例：班级事务（Agent 工具 + 面板 + 桌面/提示条小组件 + 推送） |
| [examples/hello-aurora/](./examples/hello-aurora) | 全功能示例：工具 / Skill / 命令 / 面板 / 页面 / 自动化 / 主题 / 小组件 |
| [tools/create-plugin.mjs](./tools/create-plugin.mjs) | **脚手架**：从模板生成新插件并立刻校验 |
| [tools/check-plugin.mjs](./tools/check-plugin.mjs) | **独立校验器**：与宿主清单 schema 同口径（零依赖，支持 `--json`） |
| [tools/pack-plugin.mjs](./tools/pack-plugin.mjs) | **打包器**：生成可安装 / 可上传 Center 市场的 zip（零依赖） |

三个工具都只用 Node 内置模块，要求 Node.js ≥ 20。

## 60 秒开始

1. 生成插件目录（推荐，自动填充 id / 名称并附带类型文件）：

```bash
node tools/create-plugin.mjs ../my-plugin --id com.example.my-plugin --name "我的插件"
```

也可以手工复制模板：

```bash
cp -r template my-plugin
```

2. 改 `manifest.json` 的 `id` / `name` / `version` 与 `main.js` 的处理器；
3. 随时校验（改一次跑一次）：

```bash
node tools/check-plugin.mjs my-plugin
# 给 Agent / CI 用的机器可读输出：
node tools/check-plugin.mjs my-plugin --json
```

4. 打成安装包（包根直接是 `manifest.json`）：

```bash
node tools/pack-plugin.mjs my-plugin
# 产物：./com.example.my-plugin-0.1.0.zip
```

5. 装进 Aurora：设置 → 插件 → **安装插件包**，选择上面的 zip；
   或设置 → 插件 → **开发** → 添加目录，选择 `my-plugin` 目录（原地加载、改文件自动重启）。

## 用 Agent 开发

在**插件目录**里对 Agent 说：

> 先读 `../plugin-dev-kit/AGENTS.md`、`../plugin-dev-kit/docs/01-contract.md` 与
> `../plugin-dev-kit/docs/02-guide.md`，以 `template/` 为基线实现一个 `<你的需求>` 插件。
> 所有贡献必须写在 manifest.json；每改完运行
> `node ../plugin-dev-kit/tools/check-plugin.mjs .`，最后用
> `node ../plugin-dev-kit/tools/pack-plugin.mjs .` 产出安装包。

或直接粘贴 [PROMPT.md](./PROMPT.md) 里的提示词模板。

## 校验与打包口径

`tools/check-plugin.mjs` 是**离线基础校验**，覆盖范围已对齐宿主清单 zod schema：

- 清单字段与长度、`apiVersion`、`minAuroraVersion`、`activation`；
- 权限与贡献一一对应，`net.private` 必须同时声明 `net`；
- 工具 / 命令 / 自动化动作与事件 / 面板 / 小组件 / 主题 / 配置字段的上限、命名与必填项；
- 主题令牌白名单与颜色 / 长度格式（与宿主同一份白名单）；
- 宿主事件白名单、保留 id 段与保留命令名；
- 所有引用路径的 containment 与文件存在（`main` / Skill / 面板 / 小组件 / 图片 / 市场图标）；
- 声明式 schema 的节点白名单、数量 / 深度 / 文本上限、动作参数、表格 / 列表 / 选项形状。

它不替代 Aurora 仓库里的权威校验；在 Aurora 源码环境中请再跑：

```bash
pnpm build:packages
node scripts/verify-plugin.mjs <插件目录|zip>
```

安装到 Aurora 时，宿主会用同一份 zod schema 再校验一次；失败信息以安装弹窗为准。
`check-plugin.mjs` 的**警告**（如清单里的未知字段）不会导致安装失败，但通常意味着拼写错误。

`tools/pack-plugin.mjs` 默认先跑校验，不通过就不产出 zip；`--no-check` 可跳过（不推荐）。
产物可直接走「安装插件包」，或上传到 Aurora Center 插件市场（同版本不可覆盖，重发先下架旧版本）。

## 更新工具包（v0.5.8 → v0.5.9）

工具包是 Aurora 仓库的**整目录快照**，不要只拷贝其中一两个文件；升级时整体替换：

1. 从 Aurora 仓库的 `v0.5.9` tag 取整包（推荐先备份旧目录）：

```powershell
# 在 Aurora 源码仓库根目录
git archive v0.5.9 plugin-dev-kit | tar -x -C <你的工作目录>
# 或直接复制当前工作树（注意不要覆盖你自己的插件目录）
Copy-Item -Recurse plugin-dev-kit <你的工作目录>\plugin-dev-kit
```

2. 本次**没有新增清单字段**，不必改 `minAuroraVersion`；要使用新工具（脚手架 / 打包器 / 更严格的校验）
   直接换整包即可。v0.5.9 起 `windowLevel` / `windowMaterial` / `hideCloseButton` 等字段的校验
   已与宿主对齐，旧工具包会把宿主接受的清单误报为错误。

3. 重新校验（旧工具包不会认识新规则，必须用新包）：

```powershell
node <工具包>/tools/check-plugin.mjs <插件目录>
# Aurora 源码环境再加一道权威校验
node <Aurora>/scripts/verify-plugin.mjs <插件目录或 zip>
```

升级后让编码 Agent 重新读一遍 `<工具包>/AGENTS.md` 与 `docs/01-contract.md`；
**不要手工合并 `docs/` 快照**，以整包替换为准。若插件此前已发布，记得同时升插件自身
`version`，并在 README 中说明最低 Aurora 版本。

## 安全边界（必须转告使用者）

插件进程以**当前用户权限**运行，可以直接读写文件、联网、调用子进程。
权限只门控 Aurora API，**不是操作系统沙箱**。安装插件 = 信任其代码；
不要安装来源不明的包。

## 版本

本工具包对应 **Aurora v0.5.9 / 插件 API v1 / 配置 Schema v39**。
Aurora 升级后若 `apiVersion` 变化，以 Aurora 仓库 `docs/14-plugin-system.md` 为准，
并重新生成本目录的 `docs/` 快照。
