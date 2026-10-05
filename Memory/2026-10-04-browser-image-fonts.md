---
date: 2026-10-04
title: 内置浏览器、对话图片与 HarmonyOS Sans 的接线口径
tags: [浏览器, 图片, 字体, Center, 打包]
source: 模型自动记录
---

# 内置浏览器、对话图片与 HarmonyOS Sans

## 内置浏览器

- `agent.tools.open.urlMode`（配置 v27）只控制模型发起的 `open_path` / `show_preview` 打开
  `http(s)` 时的去向：`internal`（默认，右栏浏览器标签）/ `external`（系统浏览器）。
- 本地文件预览、自动化 `open-url`、设备授权登录和用户手动入口**不读取**该设置；
  `mailto:` 与本地路径继续走系统默认程序。
- 内置模式复用 `preview:show`，不要再造第二条“右栏打开 URL”通道。

## 对话图片

- 工具契约是 `show_image { path, caption? }`；`generate_image` 成功后也自动写入同一
  `displayImages` 通道。两者共用 `ImageDisplayPort`，不要保留工具行内旧的小图预览。
- 展示元数据是 `ChatDisplayImage { id, name, mime, caption? }`；真实 `path` 只存在于
  会话文件（`StoredToolCall.displayImages`，v5 引入该字段；当前版本见
  `SESSION_FILE_VERSION`），绝不跨 IPC / Center。
- 桌面按 `chat:readDisplayImage`、Center 按 `session.readImage` 现场读字节；Center
  服务端不缓存图片。原文件移动 / 删除、客户端离线时展示“图片不可用”回退，不伪造成功。
- `show_image` 与 `show_preview` 都属扩展工具组，不受 `agent.tools.enabled` 门控；图片路径
  允许会话边界根与 Aurora 自有的 generated / screenshots / clipboard 目录。

## HarmonyOS Sans

- 随包字体：Latin `HarmonyOS Sans` 与简体中文 `HarmonyOS Sans SC` 的 Regular / Medium / Bold
  原始 TTF；不得转换、改名或修改字体文件。许可文件必须随包保留。
- 字体资产在 `packages/shared/src/browser/assets/fonts/`，`@aurora/shared` 的 build
  会递归复制到 `dist/browser/assets`；Center 静态服务必须认识 `.ttf`。
- `--font-ui` / `--font-display` 使用 HarmonyOS Sans；`--font-mono`、代码块和终端
  保持等宽，不要为了“全站统一”牺牲对齐。
