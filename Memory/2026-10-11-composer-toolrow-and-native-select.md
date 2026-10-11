---
date: 2026-10-11
title: 输入卡工具行的 flex 下限口径，与原生 select 弹出列表反色的唯一解
tags: [UI, chat, composer, flex, CSS, 原生下拉, 探针, 坑]
source: 模型自动记录
---

# 工具行重合 + 原生下拉反色（2026-10-11）

用户在同一个 Issue 里报了两条：拉伸左侧栏后权限钮与其他组件重合；暗色下按钮的弹出选项框没反色。

## 一、工具行重合：`min-width: 0` 会把容器压到子元素 min-content 以下

- 现象：左栏拖宽 → 主区被夹到下限 420px → 「完全权限」四字完整、**它自己的箭头被来源下拉盖住**。
- 根因：`.perm { flex: 0 1 auto; min-width: 0 }` 让这个 flex 项能被压到比**子元素 min-content** 还窄，
  而 `.perm-btn` 是 `display: inline-flex`（行内级盒，shrink-to-fit，下限 = 自身 min-content ≈ 95px），
  带 `overflow: visible` 就直接画到邻居身上。`.composer-bar` 的 `overflow: hidden` 只管卡片边缘，
  **管不了同一行内两个控件互相压**。
- 修法（四处）：
  1. `.perm { flex: 0 0 auto }`（权限是档位闸门入口，**不参与收缩**）+ `.perm-btn { display: flex }`
     （块级盒按容器宽度铺满，`max-width` 触发的省略号在按钮内收敛）；去掉 `min-width: 0`。
  2. `.model-picker-group` 从 `min-width: 0` 改成**显式 `min-width: 140px`**。
     ⚠️ **不能用 `min-width: min-content`**：原生 `<select>` 的固有宽度是**最宽的那个 option**
     （实测「Center 官方 / deepseek-v4-pro」加起来 220px），`min-content` 等于「不收缩」，
     实测整行溢出输入卡 53px（`chat-composer-narrow` 探针就是这么抓到的）。
  3. 下限：来源 68 / 模型 68（= 140 − 4 间距）/ 思考 56，发送 32 不收缩；
     让位顺序写进 `chat/App.vue` 的 `.composer-picker.model-picker-group { flex-shrink: 3 }` /
     `.composer-picker.thinking-level { flex-shrink: 2 }` / `.picker-hint { flex-shrink: 4 }`。
  4. 主区下限 420px 时输入卡内容宽实测约 **354px**，下限合计 346px（最坏是「变更前确认」档）。
- 探针 `chat-composer-narrow.png`（capture.ts）：`act` 把左栏把手拖到夹取上限，
  `check` 量五枚控件矩形 —— 两两不相交、都在 `.composer-box` 内、各自不小于下限、权限文案不截断，
  并**断言 `mainWidth <= 440`**（没压到下限时「零相交」是恒真的假 PASS）。

## 二、原生 `<select>` 的弹出列表：只设 `color-scheme` 不够，必须给 `option` 上底色

- 现象：暗档下弹出列表是**白底**，未选中项还是从控件继承来的 `--text-muted` 灰字 → 读不出来。
- 关键证据：**未选中项显示的是我们的灰字**（不是系统的黑字）→ 说明页面 CSS 的颜色能到达弹出列表，
  只是我们从来没给过底色。
- 修法（`packages/shared/src/browser/theme.css`，桌面与 Center Web 共用）：
  ```css
  select option { background-color: var(--bg-raised); }
  select option:checked { background-color: var(--selection-fill); }
  ```
  **刻意不声明 `color`**：收起态显示的就是选中项文字，给 `option` 设颜色会把工具行四枚芯片的
  静息灰字（`--text-muted`）顶成正文色 —— 比原问题更明显。护栏见 `theme-css.test.ts`
  （规则在 + 不含 `color:` 声明）。选中行高亮仍由系统 accent 绘制，不接管。
- 用户实机确认：**已是深底浅字**。

## 三、顺带记下的两条

- `packages/shared/src/browser/**` 是桌面 + Center Web 单源 → 改完两端都要跑截图（本次 Center
  `verify:web` 88/88 未受影响）。
- 全量截图基线从 93 涨到 **94**（新增 `chat-composer-narrow.png`）；`chat-model-picker.png`
  是既存恒红、`chat.png` 是本机固有抖动的自动滚底，判断「是不是我搞红的」要用同码基线跑。
