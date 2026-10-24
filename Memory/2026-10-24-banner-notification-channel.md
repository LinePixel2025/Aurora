---
date: 2026-10-24
title: 流光提醒（Banner Notification）通道：窗口几何、内容高度回报与三条来源
tags: [流光提醒, banner, Electron, 窗口, IPC, TTS, 探针, 坑, 口径]
source: 模型自动记录
---

# 流光提醒（Banner Notification，2026-10-24）

## 现象

新增的「屏幕顶端流光 + 置顶卡片」通道落地时踩了两个**静默**问题，两者都只能在截图里看出来：

1. 卡片窗是 `444×112`，页面里量到的视口却是 `446×112` / 更早是 `436×64`，卡片右边、底部各差几像素
   —— 屏幕上表现为卡片脚下一条**看不见却挡点击**的透明带（透明窗口的整个矩形都吃鼠标）。
2. 卡片文字被压扁：标题高度量到 `6px`、正文 `12px`。窗口高度是按「字符数估算」算的，
   估算值小于真实内容高度时，flex 子项被压缩（没有裁切，只是全部挤在一起）。

## 原因

- **窗口矩形 ≠ 页面视口**：Windows 上无边框窗口的 `getBounds()` 比 `getContentBounds()` 多出几个像素
  （实测差 8px：4px/边）；而页面里 `width: 100vw` + 默认 `#app { height: 100% }` 一旦比视口大一点点，
  就会自己造出滚动条，视口再少 8px（`clientWidth` 与 `100vw` 从此不一致）。
  两件事叠加，就得到「卡片按 layout viewport 摆、探针按 clientWidth 量」的错位。
- **估算高度必然有误差**：正文换行取决于字体回退与中英混排，主进程按「一行 28 字」估算，
  中英混排时就会偏小。窗口是透明的，所以「窗口比卡片高」在视觉上完全看不出来。

## 影响

- 透明窗口多出来的每一像素都在**偷点击**（屏幕顶端正中那块区域点不动下面的窗口）；
- 文字被压扁或正文被裁掉，探针如果只断言「标题存在」会全绿 —— 这类问题只有量矩形能抓到；
- 若只在截图路径上补几何，真实链路（Agent 工具 / 插件 / 提问）仍然会错位。

## 结论与做法

- **卡片高度由渲染层量、主进程调**：卡片 CSS 用 `height: auto`（内容驱动），渲染层把
  `offsetHeight` 经 `banner:measure` 回报（用 `offsetHeight` 而不是 `getBoundingClientRect()`，
  后者会把入场动画的 `transform: scale` 算进去）；主进程把窗口设成
  「卡片高度 + 24px 外边距 + `bounds.height - contentBounds.height`（自校准边框差）」。
  主进程侧的字符数估算只用于**首帧**的初始尺寸，不再作为最终值。
- **页面必须 `position: fixed; inset: 0` + `html/body { overflow: hidden }`**：不要用 `100vw/100vh`
  撑满浮层，否则滚动条会让视口与窗口对不上（`awareness-glow` 用 `inset: 0` 正是因此没踩到）。
- **截图路径不要重设卡片几何**：`showBannerForCapture` 只 `show`，一旦它也按估算 `setBounds`，
  就会把渲染层刚量好的高度覆盖回估算值（本轮实测就是这样白跑了两轮）。
- **高度回报要做 id 校验**：有正在显示的那一条时只认它的 `id`（迟到的上报会把新卡片按旧高度裁切）；
  没有正在显示的（`?preview=1` 截图）时只做高度钳制 —— 预览载荷自带 `banner-preview` 这种 id，
  用「空串才算预览」的写法会把截图路径整个拦掉。
- **两扇窗而不是一扇**：`banner-glow` 覆盖整块显示器 + `setIgnoreMouseEvents(true, { forward: true })`，
  `banner-card` 不穿透（关闭按钮要能点）。合成一扇要么挡住整屏点击，要么卡片点不到。
  显示顺序先光带、后卡片，否则光带会盖住卡片顶部。
- **三条来源只走一个 `BannerService.show()`**（Agent `notify_banner` / 插件 `ctx.banner` /
  `ask_user` 的旁路播报）：排队、去重（3s，`dedupeKey`）、时长钳制（2–30s，缺省 6s）、
  超时兜底（`durationMs + 1500ms`）因此只有一份实现；失败一律折成 `{ ok: false, reason }` 不抛。
  `ask_user` 的播报必须在 `present()` **之前**判定「交互窗是否在前台」——`present()` 会把它拉到前台，
  放在之后判定就永远为真（提醒等于不发）。
- **探针**：卡片探针量「四边各留 8–16px」（= 窗口与卡片同大的证据）、标题单行 ≤26px、
  正文/关闭按钮在卡片内；光带探针量顶边贴合 + 横向 ≥95% 视口 + 厚度 ≤120px + 600ms 前后
  `background-position` 真有变化。`pass` 直接取 `conditions` 表的乘积，失败时报告能指出是哪一条。
- **不要在探针 / 冒烟脚本的 template literal 里写反引号**：这次又踩了一次
  （`capture.ts` 的探针注释与 `smoke.ts` 的脚本注释里写 `` `app:smokeBanner` `` 直接把模板截断，
  `electron-vite` 报 `Expected ";" but found ...`）。注释里一律用「」。
- 基线（2026-10-24 实测）：`pnpm test` 198 文件 / 2868 用例；冒烟 **248/248**；
  截图全量 **110 条 checks**（新增 `banner-card` / `banner-glow`），唯一恒红项仍是范围外的
  `chat-model-picker.png`。TTS 就绪判据抽到 `renderer/shared/tts-config.ts`，
  对话窗朗读按钮与卡片朗读共用同一份（没配置就静默跳过，不报错不重试）。
