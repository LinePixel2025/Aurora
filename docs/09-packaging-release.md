# 09 · 打包、发布与自动更新

状态：`已定稿`（v1 基线，P6 落地）；对应 [04-roadmap.md](./04-roadmap.md) 的 P6 与 P7。

## 1. 发布拓扑（为什么是两个仓库）

| 仓库 | 可见性 | 内容 |
|---|---|---|
| `LinePixel2025/Aurora` | **私有** | 全部源码、文档、CI |
| `LinePixel2025/Aurora-releases` | **公开** | 仅安装包 + `latest.yml` + `*.blockmap` |

原因：electron-updater 检查更新时需要读取更新清单，**要么匿名可访问，要么在客户端内置凭证**。
把产物放到独立的公开仓库后：

- 源码保持私有；
- 安装包里不需要携带任何 GitHub token（解包也拿不到凭证）；
- 撤销/轮换不存在问题（没有长期凭证）。

> 若将来改为私有分发，需要把 `electron-builder.yml` 的 `publish.provider` 换成
> `generic` 并指向自建服务，或为 GitHub provider 配置 token —— 都会引入凭证分发问题，
> 因此当前不采用。

## 2. 发布流程

### 本地发布

```powershell
pnpm release              # 构建 + 打包 + 校验产物 + 打 tag（不上传）
pnpm release -- --publish --publish-center --center-url <Center 地址> --center-user admin
                          # GitHub Releases + Center 更新源双投（Center 密码经 AURORA_CENTER_PASSWORD 提供）
pnpm release -- --publish --push   # 顺便把 tag 推到 origin
```

`scripts/release.mjs` 的预检：工作区必须干净（否则用 `--force` 显式承担"把未提交改动打进包"的风险）；
产物校验通过才会打 tag。

**发布完成条件（硬规则）**：每次上传安装包时，必须把同一版本的 `Aurora-Setup-<版本>.exe`、
`Aurora-Setup-<版本>.exe.blockmap` 与 `latest.yml` 同时发布到 GitHub Releases 和 Aurora Center。
只上传 GitHub、或只更新 Center 网页包但未同步 release 资产，都不算发布完成；Center 上传失败时，
本次发布按失败处理，修复后把三个资产重新上传再宣布完成。

### CI（按需触发，不自动跑）

两个 workflow 都**只在显式发起时运行**，不跟随 push / PR 自动触发：

| Workflow | 触发 | 用途 |
|---|---|---|
| `ci.yml` | `workflow_dispatch` | 干净环境中跑 `format:check → lint → typecheck → test → build` |
| `release.yml` | `workflow_dispatch` | 云端打包 + GitHub/Center 双投（需 `RELEASE_TOKEN`、`AURORA_CENTER_PASSWORD`，可选 `AURORA_CENTER_URL`） |

手动发起：Actions 页面 → **Run workflow**，或 `gh workflow run ci.yml`。

**为什么默认不自动跑**：单人私有仓库、无 PR 门禁（GitHub 的 branch protection 需 Pro），
本地 `pnpm test`（598 项，约 8s）+ `pnpm build`（约 6s）已覆盖同一套检查；
自动跑只会产生与代码无关的红噪音（典型是下方 `minimumReleaseAge` 的安装期拦截），
拖慢开发节奏。**发布前的权威验证走本地 `scripts/release.mjs`。**

> `release.yml` 需要 `secrets.RELEASE_TOKEN`（能写 `Aurora-releases`）才能真正上传；
> 未配置时它会在上传步骤失败，因此默认不挂在 tag 上。配好 token 后，把 `on:` 恢复为
> `push: { tags: ['v*'] }` 即可实现「推 tag 即发布」。
>
> CI 里刻意用 `electron-builder --publish never` + `gh release upload`，
> 因为 electron-builder 的自动发布是往**当前仓库**发的，而我们的产物要去另一个仓库。
> 上传 GitHub 后还会调用 `aurora-center releases publish` 同步 Center；缺少
> `AURORA_CENTER_PASSWORD` 时步骤会直接失败，避免只发 GitHub 的半成品发布。

### 最小发布年龄（`minimumReleaseAge`，重要）

pnpm 在 **CI 环境**默认按 24 小时窗口校验 lockfile：刚发布的依赖会被判为违规，
`pnpm install --frozen-lockfile` 直接以 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 失败
（即使代码与 lockfile 都没问题，也要干等满 24 小时才自行恢复）。
本机默认值是 0、CI 默认不是，两者不一致会导致**「本地全绿、CI 全红」**。

本仓库在 `pnpm-workspace.yaml` 显式钉 `minimumReleaseAge: 0`，使 CI 与本地一致。
代价是放弃这层「新包冷却」保护——这是有意识的取舍：单人项目 + 镜像源，
其收益低于发布被卡住的成本。要恢复该保护，把该值改为正数（分钟）即可。

### 内网 / 代理环境注意（重要）

electron-builder 首次打包会下载两样东西：Electron 发行包与打包工具链（NSIS、7zip 等）。
在带 TLS 拦截代理的内网里，Node 默认不信任系统证书存储里的代理根证书，
会直接报 `unable to verify the first certificate` 并**打包失败**。本仓库已经处理：

1. `electron-builder.yml` 里 `electronDist: node_modules/electron/dist`，
   复用 pnpm 装好的 Electron 发行包，不再下载（顺带省 150MB+ 流量）；
2. 工具链下载用 `NODE_OPTIONS=--use-system-ca` 让 Node 读取系统证书
   （`scripts/release.mjs` 已内置；GitHub Actions 上无副作用）；
3. 镜像兜底：`ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL`
   可指向 `<镜像>/electron-builder-binaries/<release-name>`（例如
   `https://registry.npmmirror.com/-/binary/electron-builder-binaries/nsis-3.0.4.1`）。

## 3. 打包配置（`apps/desktop/electron-builder.yml`）

- 目标：Windows x64 + **NSIS**（非 oneClick：用户可选安装目录，便于卸载）；
- 产物名 `Aurora-Setup-<version>.exe`（无空格，便于 CI 与脚本处理）；
- `files` 只收 `out/**`（electron-vite 产物）与 `package.json`；
- `extraResources` 把 `skills/` 放到 `resources/skills`（SKILL.md 包不能进 asar）、把
  `resources/tray.png` 放到 `resources/`（托盘图标按 `process.resourcesPath` 查，
  不显式带上就找不到，托盘会退回内置兜底圆点），并把 `HarmonyOS-Sans-LICENSE.txt`
  放到 `resources/licenses/`；Office 结构化工具使用的固定版 OfficeCLI v1.0.153
  （Windows x64，SHA256 固定）和 Apache-2.0 许可证随包放到 `resources/officecli/`
  与 `resources/licenses/`。字体 TTF 由 shared 构建复制后经 Vite 发射进
  `out/renderer/assets`，随 `out/**/*` 一并进入安装包；
- `signExecutable: false`：**只跳过签名，保留 exe 资源编辑**（图标 / 版本信息照常写入）。
  不要退回 `signAndEditExecutable: false` —— 那会连 exe 图标一起跳掉，产物停在任何
  地方都是 Electron 默认图标。将来接入证书时去掉该字段并设置
  `CSC_LINK` / `CSC_KEY_PASSWORD` 即可，原因见 §4。
- `app-update.yml` 由 electron-builder 自动生成并打进包内，指向 `Aurora-releases`。

## 4. 代码签名与 SmartScreen（当前不签名）

未签名安装包功能完全正常，但用户首次运行会看到 Windows SmartScreen
「Windows 已保护你的电脑 / 未知发行者」提示。给用户的说明（同时写入用户文档）：

1. 点击提示里的 **「更多信息」**；
2. 再点 **「仍要运行」**。

安装后应用本身不会再被拦截。要彻底消除提示需要正式代码签名证书（付费），
届时按 §3 的方式启用即可，**不需要改动代码**。

## 5. 自动更新（`update:*`）

### 主进程

- `apps/desktop/src/main/updater.ts` —— `UpdateService` 状态机（纯逻辑、可单测）：
  `disabled → idle → checking → up-to-date | available → downloading → downloaded`，
  以及任意阶段的 `error`（带人话说明，见 `describeUpdateError`）。
- `apps/desktop/src/main/updater-port.ts` —— electron-updater 适配层：
  只有**已打包**应用才可用（`app.isPackaged`），开发态一律 `disabled`（降级为不联网）；
  `autoDownload = false` / `autoInstallOnAppQuit = false`：**由用户决定**何时下载与安装。
  **electron-updater 按需加载**（2026-10-04 性能轮）：静态 require 约 16MB RSS / 190ms，
  未打包的 dev 进程与「还没到 20s 自动检查」的窗口期都不加载它；进度监听先记在适配层，
  等模块真正加载时再挂一条原生监听统一转发。
- 启动后延迟 20s 静默检查一次（失败只记 warn，不打断启动）；
  设置页与托盘菜单提供手动检查/下载/安装入口。

### 渲染层

设置 → 常规 → **更新**：当前版本、更新源、状态、进度条、`检查更新` / `下载更新` / `安装并重启`；
托盘菜单也有对应项（仅在安装版出现）。

### 更新源

打包后由包内 `app-update.yml` 指定（`provider: github`，`owner/repo = LinePixel2025/Aurora-releases`）。
自测可用 `AURORA_UPDATE_FEED` 覆盖为本地 HTTP 服务（仅调试开关，默认不生效）。

## 6. 验证方式

| 命令 | 覆盖内容 | 是否需要网络 |
|---|---|---|
| `pnpm test` | `UpdateService` 状态机 13 项（含错误降级、busy 去重、进度换算） | 否 |
| `pnpm verify:release` | 产物验收 14 项：安装包/`latest.yml` 版本一致、**sha512 与 size 与实际文件一致**、blockmap、asar、内置 skills、`app-update.yml` 指向、无明文密钥 | 否 |
| `pnpm verify:update` | **端到端**：本地起更新源（伪装新版本），启动已打包应用 → 真的报告"发现新版本" | 否（需先打包） |
| `AURORA_SMOKE=1 pnpm dev` | 开发态 `update:getState` 为 `disabled` 且 `check` 安全降级 | 否 |

`pnpm verify:update` 会打印 5 项断言，覆盖"feed 解析 → 版本比较 → 状态事件"全链路，
这是"软件可以正常更新"这一目标的主要证据。

## 7. 首个版本与后续

- 首个可发布版本：**v0.3.0**（P3 完成时的版本）。
- 已安装的旧版本会在下一次自动/手动检查时发现新版本并升级；
  **升级不会丢失配置与会话**（`%APPDATA%/Aurora` 不在安装目录内，
  且卸载时也不删除该目录）。

### Git tag 规范（以后每个版本都适用）

> **适用范围：仅桌面安装包发布。** Aurora Center 自身的更新**不打 tag、不上传 GitHub Releases**，
> 版本线与桌面端独立（只动 `packages/center/package.json`，见 docs/12 §9 与
> `packages/center/deploy/README.md`）。

- 版本 tag 一律使用 **annotated tag**：`git tag -a vX.Y.Z`，不用轻量 tag。
- **每次打包安装包前**，先相对上一版本 tag 汇总差异：

  ```text
  git log --reverse --pretty=format:'%h %s' <上一版本tag>..HEAD
  git diff --stat <上一版本tag>..HEAD
  ```

  差异清单与更新点必须写进 `docs/release-notes/vX.Y.Z.md`，不能只写当前主主题。
- tag message **直接使用同一份 Release Notes 文件**：

  ```text
  git tag -a vX.Y.Z -F docs/release-notes/vX.Y.Z.md --cleanup=verbatim
  ```

  禁止只写 `Aurora vX.Y.Z` 或版本号。
- Release Notes 至少包含：相对上一版本的全部功能更新、修复、性能 / 外观变化、底层依赖变化、
  配置 / 数据迁移、兼容说明、主要验证结果与安装包名。
- `scripts/release.mjs` 已强制要求 `--notes-file`；它会自动识别上一版本 tag、打印提交与 diff，
  并拒绝缺少上一版本对比的 Release Notes。
- commit message 可以简短，但 tag 是发布说明的一部分，不能只写版本号。
- 推送时同时推分支与 tag：`git push origin main && git push origin vX.Y.Z`。

## 8. 已知限制

- 只出 Windows x64；ARM64 / 便携版（portable）后续按需增加。
- 未签名（见 §4）。
- 差量更新依赖 `*.blockmap`（已随产物上传）；如果上传时漏了它，更新仍可完成，
  但会退化为全量下载。
- `latest.yml` 与安装包的 sha512 必须同时更新（`verify:release` 会拦住这类错误）。
- **安装版启动可能弹一次 UAC**（见 §9）：`general.requireAdmin` 为 `true`（出厂默认）
  且当前进程未提权时，应用会用 UAC 以管理员身份重新拉起自己；**开机自启同样会弹一次**
  （没有用计划任务做最高权限自启）。提权被拒**不阻断启动**（以普通权限继续 + 记 warn）。

## 9. 启动提权（`general.requireAdmin`，v0.2.8）

`run_command` 与文件类工具跑在**当前用户权限**下：未提权时写 `C:\Program Files`、
改系统设置、`net session` 这类操作会直接失败，用户看到的是「AI 说做了，其实没做成」。
安装版启动时因此多一步提权（实现 `apps/desktop/src/main/elevation.ts`，
配置字段与只读口径见 docs/08 §1）：

- **时机**：bootstrap 第 2.2 步 —— 配置就绪之后、建窗 / 托盘 / Center 连接**之前**
  （先拿到 `general.requireAdmin` 的真实值，也保证提权重启发生在任何外部连接之前）；
- **探测**：Windows 上先看 `fltmc.exe`（未提权时因访问被拒而失败，退出码 1 = 确定未提权），
  拿不到结论再回落 PowerShell 的 `WindowsPrincipal.IsInRole(Administrator)`；
  **两条都拿不到结论时按「已提权」处理**（能跑优先，探测失败绝不等于启动不了）；
- **重启**：`powershell -Command Start-Process -Verb RunAs` 拉起带 `--aurora-elevated`
  标记的新实例，随后**先 `app.releaseSingleInstanceLock()` 再 `app.quit()`** ——
  先放锁再退，否则子进程会因「已有实例」立刻退出（本进程不放锁 = 提权实例秒退）；
  子进程看到 `--aurora-elevated` 标记就不再尝试提权（反循环的唯一判据）；
- **失败不阻断**：用户拒绝 UAC（powershell 退出码 3）/ 无管理员权限 / 非 Windows 时
  **继续以普通权限启动**并记一条 warn ——「要求管理员」不能变成"配置错了就打不开"；
- **开发态默认不强制**：`pnpm dev` / smoke / capture 的进程常跑在非提权终端里，
  强制提权会让自测每次弹 UAC 甚至卡住；需要验证提权路径时用
  `AURORA_REQUIRE_ADMIN=1` 显式打开（仅该环境变量能打开开发态的提权）；
- **未签名安装包 + UAC 的注意点**：本仓库产物**不签名**（§4），因此提权弹窗里的发行者
  显示为「未知发行者」—— 这与首次运行安装包时的 SmartScreen 提示（§4）是**两件事**：
  UAC 问的是「是否允许本次提权」，SmartScreen 问的是「是否允许运行未签名的安装程序」，
  前者点「是」、后者点「更多信息 → 仍要运行」（用户文档里的说明见 §4）。
- **它不改变权限判定链**：提权只提高"能做什么"，越界要确认 / 项目根边界仍照旧
  （docs/06 §11.2）—— 提权**不是**「不再确认」，别把两者混为一谈。
- **UAC 是「凭据」框时会换账户，已做守卫（v0.2.8 审查修复）**：当前用户**不在管理员组**的
  机器上，UAC 弹的是凭据框；填了管理员账户后子进程以**那个账户**运行，`%APPDATA%` 随之切换 ——
  界面上看起来像"配置 / 会话 / 自动化全丢了"（原数据仍在用户自己的 profile 里）。
  因此提权实例的命令行会带上原用户的配置目录（`--aurora-user-data=<目录>`），
  子进程在**读配置之前**比对：
  - 一致（常规的同账户 UAC，同意框）→ 照常启动；
  - 不一致 → 记 warn、**把原用户配置里的 `general.requireAdmin` 关掉**（自愈，下次启动即正常）、
    弹一条说明后退出 —— 不进入"空配置 + 引导页"的假象。
  同组账户不受影响：这是覆盖面很小的边界情况（企业 / 受管机器），但代价是"用户以为数据丢了"，
  因此按硬错误处理。
- **参数按 Windows 命令行规则加引号**：`Start-Process -ArgumentList` 内部是 `join(' ')`，
  不会替调用方加引号 —— 含空格的参数（开发态 `argv[1]` 是 app 目录、仓库路径可能带空格）
  会被子进程拆成多个参数，Electron 找不到 app 而直接退出。因此传参前先过一遍
  `quoteArgument`（双引号 + 反斜杠按 2n+1 规则转义），再做 PowerShell 单引号字面量转义。
- **配置关闭时不做探测**：`requireAdmin = false` 直接跳过整条流程 —— `probeElevated` 是
  `spawnSync`，在 fltmc 拿不到结论的机器上还要等 PowerShell 起来（实测约 0.5s），
  关掉开关的用户不该白付这段启动延迟。

## 10. Center 自托管更新源（v31）

客户端仍保留 GitHub Releases 作为过渡回落，但正常更新优先走当前配置的 Aurora Center：

- 更新地址由 `center.serverUrl` 推导为 `<http(s)-base>/api/updates`；
- Center 未配置、`latest.yml` 缺失或检查失败时回落到包内 `app-update.yml` 的 GitHub 源；
- Center 明确返回“已是最新”时不回落 GitHub，避免同一版本被两个源反复比较；
- `AURORA_UPDATE_FEED` 仍是最高优先级，仅用于离线验收。

Center 数据目录新增 `releases/`：

| 文件 | 内容 |
|---|---|
| `releases/index.json` | 当前 latest 版本、文件清单、size、sha512 与发布时间 |
| `releases/files/` | `Aurora-Setup-<version>.exe`、blockmap 与 `latest.yml` |

公开下载路由为 `GET /api/updates/latest.yml`、`GET /api/updates/current` 与
`GET /api/updates/:asset`。`/current` 返回当前 `CenterReleaseInfo`（未发布时为
`{ current: null }`），供官网下载区读取版本与安装包元数据；`latest.yml` 与资产路由支持 HEAD、
Content-Length、Range / 206。`latest.yml` 与 `/current` 不缓存，安装包与 blockmap 可长期缓存。
上传 / 发布只允许管理员网页会话，且必须先把完整文件上传到暂存区，再校验
`latest.yml` 的 version / size / sha512 与 blockmap 后原子切换；校验失败不得替换当前 latest。

发布入口有三条：`scripts/release.mjs --publish-center`、`aurora-center releases publish`
与管理网页。CLI 与发布脚本通过管理员账号登录 Center 后调用上传接口，不新增长期发布密钥。
无论使用哪个入口，都必须与同一个版本的 GitHub Release 同步双投；`latest.yml` 的 version、
size 与 sha512 在两端必须一致。Center 发布完成后至少验证
`GET <Center>/api/updates/latest.yml` 返回 200，并确认安装包 Range 请求返回 206。

> 双投的对象是**桌面安装包**这一批产物。Aurora Center 服务器自身（`packages/center`）的升级
> **不适用双投**：不上传 GitHub Releases、不创建 tag、不必与客户端版本号相同 ——
> 只升 `packages/center/package.json` 并按 `packages/center/deploy/README.md` 换装即可
> （docs/12 §9「版本线与桌面端独立」）。

## 11. 插件入口与依赖（v36）

- `electron.vite.config.ts` 新增两个入口：
  - `out/main/plugin-host.js` —— 插件 `utilityProcess` bootstrap（一个启用插件一个进程）；
  - `out/preload/plugin-page.js` —— 插件沙箱页面专用 preload（只暴露 `window.auroraPlugin`）。
- `out/**` 已覆盖新入口；打包后需确认这两个文件存在（见 §6 验证方式）。
- 桌面端运行时依赖新增 **`fflate`**（读取插件 zip；已在 lockfile 中），`electron-builder` 需随包携带。
- **插件本体不随安装包分发**：插件安装 / 开发目录 / 配置 / 日志都在 `<userData>`，升级客户端不会覆盖用户插件；
  示例插件在仓库 `examples/plugins/`（打包产物里不存在，冒烟 / 截图会按其是否存在决定是否跑插件断言）。
- Center 侧新增 `fflate` 依赖（市场上传校验与 CLI 打包）。
