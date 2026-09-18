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
pnpm release -- --publish # 再用 gh CLI 上传到 Aurora-releases
pnpm release -- --publish --push   # 顺便把 tag 推到 origin
```

`scripts/release.mjs` 的预检：工作区必须干净（否则用 `--force` 显式承担"把未提交改动打进包"的风险）；
产物校验通过才会打 tag。

### CI 发布

`.github/workflows/release.yml`：推送 `v*` tag 触发 →
`format:check / lint / typecheck / test / build` → 打包 → `verify-update.mjs` →
用 `secrets.RELEASE_TOKEN`（需能写 `Aurora-releases`）执行 `gh release upload`。

> CI 里刻意用 `electron-builder --publish never` + `gh release upload`，
> 因为 electron-builder 的自动发布是往**当前仓库**发的，而我们的产物要去另一个仓库。

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
- `extraResources` 把 `skills/` 放到 `resources/skills`（SKILL.md 包不能进 asar）；
- `signAndEditExecutable: false`：**不签名、也不改 exe 资源**。
  原因见 §4；将来接入证书时置为 `true` 并设置 `CSC_LINK` / `CSC_KEY_PASSWORD` 即可。
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

## 8. 已知限制

- 只出 Windows x64；ARM64 / 便携版（portable）后续按需增加。
- 未签名（见 §4）。
- 差量更新依赖 `*.blockmap`（已随产物上传）；如果上传时漏了它，更新仍可完成，
  但会退化为全量下载。
- `latest.yml` 与安装包的 sha512 必须同时更新（`verify:release` 会拦住这类错误）。
