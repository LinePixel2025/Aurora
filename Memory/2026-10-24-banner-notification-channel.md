---
date: 2026-10-24
title: 流光提醒（Banner）：窗口几何、来源与动效
tags: [提醒, 流光, 窗口, IPC, 探针]
source: 模型自动记录
---

# 流光提醒（Banner Notification）

## 现象

- 屏幕顶端「流光 + 置顶卡片」通道落地时踩了两个静默问题，只能在截图里看出来：卡片窗与页面视口差几像素，屏幕上多出一条看不见却挡点击的透明带；正文按字符数估算高度被压扁（标题量到 6px、正文 12px）。
- 卡片代码里写了 `opacity 0 → 1` + `translate -12px → 0` 的 transition，实际却「啪一下出现」，没有动画。

## 原因

- Windows 无边框窗口的 `getBounds()` 比 `getContentBounds()` 多几个像素（实测差 8px：4px/边）；页面里 `width: 100vw` + 默认 `#app { height: 100% }` 一旦比视口大一点就会造出滚动条，视口再少 8px。两件事叠加，卡片按 layout viewport 摆、探针按 `clientWidth` 量。透明窗口多出来的每一像素都吃鼠标。
- 主进程按「一行 28 字」估算正文高度，中英混排与字体回退下必然偏小；透明窗口看不出「窗口比卡片高」，只会把 flex 子项压扁。
- 卡片是 `<article v-if="payload">`，终态 `is-visible` 在 `payload` 落地同一帧绑定，元素插入时没有样式变化，CSS transition 一次都不跑；主进程原先「先 `webContents.send` 再 `showInactive()`」，窗口还藏着时渲染层拿不到绘制帧。

## 影响

- 屏幕顶端正中区域点不动下面的窗口；标题 / 正文被压或裁掉，探针只断言「标题存在」会全绿。
- 只在截图路径补几何时，真实链路（Agent 工具 / 插件 / 提问）仍然错位；无动画让提醒显得突兀。

## 结论与做法

- 卡片高度由渲染层量、主进程调：卡片 CSS 用 `height: auto`，渲染层用 `offsetHeight`（不用 `getBoundingClientRect()`，后者把入场 `transform: scale` 算进去）经 `banner:measure` 回报；主进程 `resizeBannerCard` 设成「卡片高度 + 24px 外边距（上下各 12）+ `bounds.height - contentBounds.height` 自校准边框差」。字符估算只用于首帧，不再作为最终值。
- 窗口 = 卡片 + 12px 外边距（`BANNER_CARD.margin: 12`）；宽度按 `notifications.size` 三档。**2026-11-01 起这条已改写**：宽度按显示器 DIP 比例取、字号 `cqw` 流体放大，见文末修订段（旧值 compact 360 / standard 420 / large 480 已废）。
- 页面必须 `position: fixed; inset: 0` + `html/body { overflow: hidden }`，不要用 `100vw/100vh` 撑满浮层，否则滚动条会让视口与窗口对不上（`awareness-glow` 用 `inset: 0` 同理）。
- 截图路径 `showBannerForCapture` 只 `show`，不按估算 `setBounds`，否则会把渲染层刚量好的高度覆盖回估算值。
- 高度回报要做 id 校验：有正在显示的那一条时只认它的 `id`（迟到的上报会把新卡片按旧高度裁切）；没有正在显示的（`?preview=1`）时只做高度钳制；预览载荷自带 `banner-preview` 这种 id，不能用「空串才算预览」把截图路径整个拦掉。
- 两扇窗：`banner-glow` 覆盖整块显示器 + `setIgnoreMouseEvents(true, { forward: true })`；`banner-card` 不穿透（关闭按钮要能点）。合成一扇要么挡住整屏点击，要么卡片点不到；显示顺序先光带、后卡片，否则光带会盖住卡片顶部。
- 三条来源只走一个 `BannerService.show()`：Agent `notify_banner` / 插件 `ctx.banner` / `ask_user` 的旁路播报；排队、去重（3s，`dedupeKey`）、时长钳制（2–30s，缺省 6s）、超时兜底（`durationMs + 1500ms`）只有一份实现；失败一律折成 `{ ok: false, reason }` 不抛。`ask_user` 的播报必须在 `present()` **之前**判定「交互窗是否在前台」，放在之后会永远为真。
- 动效：入场 / 退场一律走 Vue `<Transition>`（插入后强制一帧初始态再切终态）。卡片 enter 从 `translate3d(0, -26px, 0) scale(0.93)` + 淡入（540ms `--ease-spring`），文字晚 60ms；leave 320ms 缩回淡出。主进程必须**先 `showInactive()` 再 `send`**；退场到 `durationMs - 320ms` 把载荷置空（播 leave）+ 光带淡出，`durationMs` 再回执关窗；用户点关闭也先等 320ms 再回执。
- 探针：卡片量「四边各留 8–16px」（窗口与卡片同大的证据）、标题单行、正文 / 关闭按钮在卡片内；光带量顶边贴合 + 横向 ≥95% 视口 + 厚度 ≤120px + 600ms 前后 `background-position` 真有变化；`pass` 取 `conditions` 表的乘积。动效只查声明（样式表能找到 `banner-card-enter-active` / `leave-active`，光带根 `transition-duration` 含 `0.32s`），`?preview=1` 首帧就有载荷、`<Transition>` 不播 appear，不能断言「真的在动」。**2026-11-01 增补**：字号 ≥20/17px、卡宽 ≥440px、关闭按钮 ≥28px（数值见文末修订段）。
- 探针 / 冒烟脚本的 template literal 里不要写反引号（注释一律用「」），否则会截断模板，`electron-vite` 报 `Expected ";" but found ...`。
- 基线：`pnpm test` 199 文件 / 2928 用例；冒烟 263/263；全量截图 113 条 checks（含 `banner-card` / `banner-glow`），唯一恒红项仍是范围外的 `chat-model-picker.png`。TTS 就绪判据抽到 `renderer/shared/tts-config.ts`，对话窗朗读按钮与卡片朗读共用同一份（没配置就静默跳过，不报错不重试）。

## 2026-11-01 修订：大屏字号与提示音可靠性

### 现象

- 教室投影 / 大屏上「提醒框和字太小，后排看不清」（用户点名两条诉求之一）。
- 提示音「有时不响」，且响的时候「不明显」。现场没有任何报错，卡片与朗读都正常。

### 原因

- **字号**：卡片宽固定 360/420/480，标题 13.5px、正文 12.5px —— 在 1920 投影上题目量级只有旧桌面提醒大小。
- **不响**：`new AudioContext()` 每次新建，且音符排在 `currentTime`（上下文挂起时是 0）。窗口刚 `showInactive` 时上下文常常还是 `suspended`，等它恢复，音符已经"在过去"，浏览器直接不播 —— 这就是「有时」。
- **不明显**：每音峰值 `0.05 × 音量`，默认 60% 下 ≈ 0.03（−30dBFS 量级），笔记本 / 投影喇叭上几乎听不见；频率还是两个裸 `sine`。
- 顺带核对：Electron 44 的 `webPreferences.autoplayPolicy` 默认已是 `no-user-gesture-required`（`electron.d.ts` 明写），所以这不是自动播放策略问题；但显式钉住可以防将来默认变化。

### 结论与做法

- **宽度按显示器比例、字号跟宽度流体联动**：`main/banner-geometry.ts`（纯逻辑、有 `banner-geometry.test.ts`）按 `resolveBannerCardWidth(size, displayWidth)` 取宽（紧凑 0.24 / 标准 0.36 / 宽大 0.46，夹取 460–700 / 640–1000 / 780–1280，且 `displayWidth - 40`）；`BannerCard.vue` 的根节点是 `container-type: inline-size`，字号 / 内边距 / 关闭按钮全用 `cqw` clamp（标题 3.3cqw 19–34px、正文 2.8cqw 16–28px、关闭 30–40px）。**主进程不要再写一套字号**，`cqw` 保证与宽度同源。
- **首帧高度不再按字符估算**：窗口先用 `BANNER_CARD.initialHeight: 240` 占位，渲染层 `banner:measure` 量完立刻收缩（透明死区只存在约 1–2 帧）。字符估算与流体字号必然漂移，删掉比调参省事。
- **提示音**：`renderer/shared/chime.ts`（从 `banner/chime.ts` 移出，设置页「试听」与卡片共用）——模块级**复用**一个 `AudioContext`，播放前 `state !== 'running'` 就 `await resume()`，从 `currentTime + 40ms` 调度；三音三角波（A5–C#6–E6）、峰值 `0.26 × volume^0.7`、compressor(−12dB / ratio 8) 防削波、失败静默。`playBannerChime` 返回 Promise 且支持注入上下文，`chime.test.ts` 用假上下文钉住「resume 先于 start」「起点在 currentTime 之后」「60% 音量峰值 > 0.12」。
- 卡片窗 `webPreferences` 显式 `autoplayPolicy: 'no-user-gesture-required'`；顺手把关闭按钮从「相对根浮层定位的 20/20」改成锚定卡片（`.banner-card { position: relative }`），不再靠入场 transform 时的巧合。
- **冒烟不要再写死卡宽像素**：宽度随显示器变，`smoke.ts` §2.4 改成「紧凑档 vs 宽大档」两次测量（紧索引区间 + 宽度差 ≥120px）。
- **注入到渲染层的字符串是纯 JS**（`smoke.ts` / `capture.ts` 的 template literal）：写 `async (): Promise<number> =>` 这类 TS 语法会让整段脚本在渲染层解析失败，冒烟只报一句 `Script failed to execute` —— 定位时先看这段字符串有没有类型标注。

> 修订说明：2026-11-01 同日改写本文件的卡片尺寸 / 提示音 / 探针三段旧口径（原文保留为历史）。

