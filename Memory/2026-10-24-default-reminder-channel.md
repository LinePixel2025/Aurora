---
date: 2026-10-24
title: 默认提醒方式（notifications.channel）落进 NotificationService，以及设置页两处自动接线
tags: [提醒, 通知, 配置, 迁移, 设置页, 探针, 坑, 口径]
source: 模型自动记录
---

# 默认提醒方式（v37）

## 现象

用户要求「加一个提醒设置页，能设置默认提醒方式」。落地时三处不显眼的地方各自会静默出错：

1. 通道切换后**去重行为变了**：同一条提醒在 `both` 下弹两次（系统通知一次、流光一次）。
2. 新建的 `settings-notifications` 截图场景**跑不出来**：`SETTINGS_PAGE_IDS` 里没有 `notifications`，
   于是既没有出图循环，也不会有 `settings-notifications.png`。
3. 探针字符串里写了 `split('\n')`，`capture.probe-strings.test.ts` 立刻报
   `Unterminated string literal` —— 模板层已经把反斜杠吃掉一层。

## 原因

- 提醒的路由如果写在每个调用方（分类管线 / 课前提醒 / `notify_user` 端口）里，去重就会被拆成多份；
  正确的分层是：**去重在通道判定之前、通道判定集中在 `NotificationService.notify` 一处**。
- 截图工具对设置页是「按 `SETTINGS_PAGE_IDS` 循环出图」的：新页不登记就没有场景，
  手写 `plan.push` 又会在同名文件上撞车。
- 探针正文是 `String.raw` / template literal 字符串，`\n` 这类转义在写文件时就被解释掉了。

## 影响

- `both` 下弹两次会被用户当成 bug；而单测若只断言「系统通知收到一次」，这条永远看不见。
- 设置页没有截图场景 = 新页的视觉与 DOM 断言等于零，只能靠人工点一遍。
- 探针字符串里的转义问题只在 `pnpm test` 的探针护栏里暴露一次；平时它会在截图里变成
  `Script failed to execute`，白跑一轮。

## 结论与做法

- `notifications.channel` 四值：`system` / `banner` / `both` / `off`（默认 `system` = 行为与 v37 前一致）。
  它是一个**用户偏好的打扰方式**，不是权限闸门：登记在 `WRITABLE_PATH_OVERRIDES`
  （`notifications.channel`），**不**进 `SETTINGS_READONLY_PREFIXES`；`TOP_LEVEL_GROUPS` 与
  `settings-hint` 要同步加，否则会出现「提示词说能改、`set_setting` 必拒」。
- 路由实现放在 `main/notifications.ts` 的 `notify()`：**先算 dedupeKey 与 recent 表，再读通道**，
  然后按 `wantsSystem` / `wantsBanner` 分别投递、`shown = systemShown || bannerShown`。
  流光载体没注入时 `banner` / `both` **回落系统通知**（不静默丢提醒）；`off` 只记日志并返回 false。
- 语义边界（写进 docs/07 §4）：它只管 Aurora 自己发起的提醒；`notify_banner` 与插件 `ctx.banner`
  是**显式**请求流光，`ask_user` 的旁路播报是定点交互提醒，都不走默认值。
- 「试一下」按钮走 `notifications:test` → 同一个 `notify()`：验证的是真实路由，不是另开一条演示通道；
  不接受调用方传标题 / 正文（防止它变成第四条任意内容通道）。
- **新增设置页要动两处**：渲染层 `settings/App.vue`（`PageId` / `nav` / `navGroups` / `pages`）
  与 `capture.ts` 的 `SETTINGS_PAGE_IDS` + 该页的 `check` 分支（出图循环自动生成 `settings-<id>.png`）。
  只在 `index.ts` 手写 plan 会与循环撞名。
- 探针里**不要写任何反斜杠转义**：要取「说明文字」就 `querySelector('.tiny')` 再量 `textContent`，
  不要 `split('\n')`（模板层会先吃掉一层）。
- v37 迁移：`v36 → v37` 只在缺 `notifications` 时补 `{ channel: 'system' }`；`MIGRATIONS` 与
  `migrations.test.ts` 里三处**硬编码的 applied 列表**要一起加一行（否则单测立刻红）。
- 基线（2026-10-24 实测）：`pnpm test` 199 文件 / 2879 用例；`pnpm verify` 26/26（`version=37`、迁移 37/37）；
  冒烟 **256/256**（新增 5 条：默认 system / 非法值被拒 / banner 下走流光 / off 不投递 / 还原）；
  截图三轮共 **111 条 checks**（新增 `settings-notifications`），唯一恒红项仍是 `chat-model-picker.png`。

## 追加：提醒细节可配置（v38，同一页）

用户要求「提醒界面里能设音效、是否语音朗读、弹窗大小等」。最终落成五项：
`sound`（提示音）/ `volume`（0–100）/ `speak`（朗读）/ `size`（compact 360 / standard 420 /
large 480）/ `durationMs`（2–30s）。

## 口径与踩点

- **`sound` / `speak` 是总闸，不是缺省值**：`payload.sound = prefs.sound && (request.sound ?? true)`。
  写成 `request.sound ?? prefs.sound` 的话，`notify_banner` 显式传 `sound: true` 会**越过**
  用户关掉的提示音 —— 用户关声音就是不想被吵，请求级只能再关、不能开。
- **设置注入从「一个布尔」升级成「一个对象 getter」**：`BannerService` 原先是 `speakDefault: () => boolean`，
  现在是 `preferences: () => { sound, speak, volume, durationMs }`（每次 `show()` 现读）。
  `speak` 由装配层先合成「用户开关 && TTS 已配置」，服务只管总闸语义 —— 判据不要散在两处。
- **`size` 只改窗口宽度，不改高度**：高度仍由渲染层量（`banner:measure`），所以
  `bannerCardWidth()` 是唯一宽度来源，首帧估算的「每行字数」必须按当前宽度折算
  （写死 28 字会让 360px 的紧凑卡估矮、480px 估高）。
- **`volume` 要同时作用于提示音与语音**：提示音在 `playBannerChime(volume)` 里乘峰值增益，
  语音要给 `useTts` 加一个 `volume` ref（创建 `HTMLAudioElement` 时应用）——
  只改音效会让「音量 20%」时语音仍然满音量。
- **设置页在非流光通道下是置灰态**：这是有意的（系统通知没有这些参数），但截图里会像坏掉；
  所以新增的 `settings-notifications-style.png` 场景在 `prepare` 里先把 channel 切成 `banner`
  （capture 的 userData 是隔离的，不用还原）。
- 探针：细节区单列一条（`SETTINGS_NOTIFICATIONS_STYLE_CHECK`），量五个控件存在 / 默认选中
  （标准卡、6 秒）/ 音量滑杆 60 / 每个分段按钮高度 ≥24；`size` 真正生效由**冒烟的原生窗口宽度**
  证（大档 480 + 24 = 504，给 ±6 容差），比只断言配置回读可靠。
- v38 迁移：`v37 → v38` 以默认值为底、已有 `notifications` 在上 —— 用户已选 `channel` 原样保留，
  补出的五项等于 v38 之前写死的行为。`migrations.test.ts` 的 applied 列表同样要加一行。
- 基线（v38 实测）：`pnpm test` 199 文件 / **2881** 用例；`pnpm verify` 26/26（`version=38`、迁移 38/38）；
  冒烟 **262/262**（+6：细节默认值 / 非法音量被拒 / 大档卡片窗真的变宽 / 还原 等）；
  截图三轮共 **112 条 checks**（新增 `settings-notifications-style`）。

