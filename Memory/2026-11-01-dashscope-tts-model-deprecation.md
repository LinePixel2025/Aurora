---
date: 2026-11-01
title: DashScope TTS 模型下架潮：qwen-tts 已消失、qwen3-tts-flash 是唯一 HTTP 可用模型，端点要容忍 compatible-mode 粘尾巴
tags: [语音, TTS, dashscope, 模型下架, 端点, 坑, 口径]
source: 模型自动记录
---

# DashScope TTS 模型下架潮：qwen-tts 已消失、qwen3-tts-flash 是唯一 HTTP 可用模型

## 现象

2026-10-31 起 TTS（朗读）持续 404：日志 `TTS 合成失败 {"provider":"Qwen","status":404}`。
用户配置经排查有两层问题：① baseUrl 粘着 `/compatible-mode/v1`（后来用户自己又改成了
少 `/v1` 的 `…/compatible-mode`）——TTS 端点构建器（v0.6.0）不容忍这些尾巴，拼出
`…/compatible-mode/services/aigc/multimodal-generation/generation` 这类不存在的路由 → 404 空响应体；
② 模型是 `qwen-audio-3.0-tts-plus`（用户从模型列表里选的），换成 2026-09 口径的
`qwen-tts` 也回 `Model not exist`。

## 原因

用真实密钥实测（2026-11-01，qianwenai 网关 + 官方 dashscope 双侧）：

- **模型下架潮**：网关模型目录从 518 缩到 **371**；`qwen-tts` / `qwen-tts-latest` /
  `qwen3-tts-plus` 一律 404 `Model not exist`（网关与官方同报）；**唯一走 HTTP
  multimodal-generation 端点的 TTS 模型只剩 `qwen3-tts-flash`**（网关与官方都实测 200，
  内置音色 Cherry 可用）。
- **端点族不变**：`qwen-audio-3.x-tts-*` / CosyVoice / Sambert 系列仍只走 WebSocket 实时，
  HTTP 一律 400 `url error`；官方与网关**依旧没有** OpenAI 兼容 `/audio/speech`（404）。
- 用户拿到的网关 key 本质是**官方 DashScope key**（打官方端点能过鉴权），所以错误提示
  可以建议「换官方服务根」。
- 报错现场（404）与真因（模型下架 + baseUrl 粘尾巴）不在同一处：404 看着像「接口没了」，
  实际是「路径拼错 + 模型没了」叠加。

## 影响

- 不容忍 `/compatible-mode`（长短两截）粘尾巴，用户从 LLM / 生图那几栏照抄 baseUrl 就 404，
  且每次轮到这类配置都会复发（本次就是 STT/LLM 配置习惯带过来的）。
- 不做模型级失效处理的话，平台下次再下架模型就是「又失效了」第三次上门——
  2026-09 一轮（qwen-tts 可用）、2026-11 一轮（qwen-tts 下架），同一类问题第二次出现。

## 结论与做法

- **端点容错**（`tts.ts` / `stt.ts`，2026-11 起）：`dashscopeEndpoint()` 与
  `dashscopeAsrEndpoint()` 都把 `/compatible-mode/v1` / `/compatible-mode` / `/api/v1` / `/api`
  尾巴**整段换成** `/api/v1/services/aigc/multimodal-generation/generation`（TTS）或
  `DASHSCOPE_ASR_PATH`（STT）；Center 网关 base（`…/api/model-gateway/tts`）拼出来是
  `…/tts/api/v1/services/...`，恰好匹配 Center `routeKind` 接受的 rest——dashscope 型
  Center TTS 因此从「必然 404」变为可用。`normalizeDashscopeBaseUrl()`（modelsEndpoint 用）
  同步容忍 `/compatible-mode` 两截尾巴。
- **模型级失效自动回退**（`tts.ts` `runDashscopeSynthesis`）：404 + `Model not exist` 或
  400 + `url error` → 自动改用 `qwen3-tts-flash` 重试一次（只换模型，音色不动）；
  成功即 `settings.mutate()` 把 provider 的 model 写回（设置页可见）；重试也失败则报
  两段原因。鉴权 / 限流 / 网络类失败**不**回退；openai-compat **不**回退（各网关模型空间不同）。
- **给用户的模型口径**：dashscope TTS 现在就填 `qwen3-tts-flash` + 内置音色（Cherry 等）；
  复刻音色（`longanlufeng` / `loongstella` 等）在 HTTP 合成上依旧不可用，别再按 2026-09
  记忆把 `qwen-tts` 当可用模型写进提示词。
- **排障手法**：解密凭据探真实端点 —— 仓库 electron 直跑临时脚本
  （`app.setName('Aurora')` + `app.setPath('userData', %APPDATA%/Aurora)` 后
  `safeStorage.decryptString`），密钥只在内存、只打印状态码与错误体；
  electron.exe 在 `node_modules/.pnpm/electron@*/node_modules/electron/dist/electron.exe`
  （根 `node_modules/.bin/electron` 在 Git Bash 下 env 调用会 ENOENT）。
- 测试坑：`sequenceFetch` 越界会**回放最后一个 Response 对象**，而 Response body 只能读一次
  —— 「重试后再读错误体」的用例必须给足独立 Response，否则重试读到空 body。

相关：[2026-10-24-banner-notification-channel.md](2026-10-24-banner-notification-channel.md)（TTS 播放侧）。
