---
date: 2026-10-31
title: Aurora 开源迁移：单仓库发布、MIT 许可证与 README 图文重写
tags: [发布, 开源, GitHub, 打包, 更新源, 许可证, README, 迁移, 口径]
source: 模型自动记录
---

# Aurora 开源迁移（2026-10-31）

## 现象 / 本轮事实

- `LinePixel2025/Aurora` 从私有改为**公开**；新增 MIT `LICENSE`；README 重写为图文版
  （`docs/images/hero.png` + `docs/images/screenshots/`，共 9 张产品截图）。
- 发布拓扑从「私有源码仓库 + 公开 `Aurora-releases` 产物仓库」收敛为**单仓库**：
  安装包、`latest.yml`、`*.blockmap` 与源码都发在 `LinePixel2025/Aurora`。
- 已发布的 **v0.5.8 资产只做迁移**（版本与内容不变）：从 `Aurora-releases` 搬到
  `Aurora` 的 GitHub Release；没有重新打包、没有移动 tag。
- `Aurora-releases` 在迁移完成后删除；未来版本只发 `Aurora`。

## 原因

- 开源后源码仓库本身公开，electron-updater 的 GitHub provider 可匿名读取更新清单，
  不再需要「独立公开产物仓库」来避免源码暴露与凭证分发。
- 用户明确要求开源、删除旧产物仓库、V0.5.8 推送、README 图文重写。

## 影响 / 务必记住

1. **v0.5.8 安装包内的 `app-update.yml` 仍指向旧仓库**（因为只迁移资产、没有重打）。
   删除 `Aurora-releases` 后：配置了 Aurora Center 的用户更新不受影响（Center 源优先），
   **未配置 Center 的旧版本 GitHub 回退源会失效**，需要手动下载新安装包覆盖安装。
   下一次发版（0.5.9+）会把 `app-update.yml` 指向 `Aurora`，从该版本起恢复回退。
2. 发布脚本与配置已全部改成 `LinePixel2025/Aurora`：
   `scripts/release.mjs`、`scripts/upload-release.mjs`、`scripts/verify-update.mjs`、
   `apps/desktop/electron-builder.yml`、`apps/desktop/src/main/updater-port.ts`、
   `apps/desktop/src/main/updater.ts`、`.github/workflows/release.yml`（改用自带
   `GITHUB_TOKEN`，不再需要 `RELEASE_TOKEN`）、Center 官网下载回退链接（LandingView）。
3. 删除 GitHub 仓库需要 `delete_repo` scope；当前 `gh auth` 默认 token 只有
   `repo/gist/read:org`，要先 `gh auth refresh -h github.com -s delete_repo`（浏览器确认）。
   仓库删除不可恢复，执行前先确认 v0.5.8 Release 已在新仓库可下载。
4. 开源前做过的检查：当前 tracked 文件无 `.env` / 私钥 / 真实 token；历史里只有测试夹具
   的假密码、以及部署类 Memory 中的服务器 IP / SSH 密钥文件名（不是凭据本身）。
   **git 历史里仍有这些基础设施描述**，若要做彻底清理只能重写历史（本轮未做）。
5. README 截图口径：主界面/提示条/设置页来自 `AURORA_CAPTURE` 真实窗口截图；记忆库、
   自动化、Center、提醒卡、小组件来自 `scripts/promo/assets/shots`。为此临时把
   capture 工作区固定并先用 `chat-stream.png` 场景写入桩模型，让设置页不再显示
   「未配置模型」横幅；**该临时补丁未提交**（`AURORA_SMOKE_WORKSPACE` 仍只对
   `AURORA_SMOKE=1` 生效）。
6. `scripts/promo/`（分镜、帧、ffmpeg）与 `.promo-cache/`、`.agents/` 已加进
   `.gitignore` 与 ESLint ignores；以后不要把宣传片产物或代理工作区提交进仓库。

## 结论与做法

- 新版本发布只发 **`LinePixel2025/Aurora` Releases + Aurora Center 更新源**，不再创建
  任何独立产物仓库。
- 迁移已发布版本时，**先确认新仓库 Release 的三个资产可匿名下载**，再删旧仓库；
  只迁移资产就必须在发布说明/文档里写清「安装包内回退源仍是旧的」。
- 开源仓库的发布 workflow 用 `secrets.GITHUB_TOKEN`（`contents: write`）即可，
  不再需要跨仓库 `RELEASE_TOKEN`。
- README 的本地图片统一放 `docs/images/`，截图必须来自真实窗口；带桩模型/夹具内容的截图
  要在图下注明「开发预览环境」。
