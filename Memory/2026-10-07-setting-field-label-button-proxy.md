---
date: 2026-10-07
title: SettingField 的 label 会把整行 hover / 点击代理给内部按钮
tags: [UI, 表单, Center, 坑]
source: 用户实测
---

# SettingField 标签点击与按钮代理

## 现象

桌面端 Aurora Center 页的「登录账户」按钮，在鼠标没有点到按钮本体时也会响应：
鼠标移到按钮同一行的字段区域时按钮进入 hover；点击标签或说明文字还会触发登录流程。

## 原因

共享 `SettingField.vue` 的根元素是 `<label>`。当字段插槽里的第一个可标注控件是
`<button>` 时，浏览器会把整块 label 的 hover 与 click 默认行为都代理给该按钮。
因此鼠标停在 `.label` / `.hint` 上时按钮表现为 hover，点击它们则等价于点击按钮。

## 影响

所有「只含按钮」的 SettingField 都可能误触发：Center 登录、打开目录、刷新状态、
文件自感知操作等。普通用户会误以为鼠标命中区扩大或按钮自己响应。

## 结论与做法

- 只含按钮的 `SettingField` 必须传 `as="div"`，从结构上断开 label 代理；Center「登录账户」
  字段已按此处理。
- 根 `<label>` 仍保留点击守卫作为 click 侧兜底：若第一个可标注控件是 button，且本次点击目标
  不在任何 button 内，则 `preventDefault()`。
- 输入框 / 选择框 / 文本域仍保留隐式 label 的点击聚焦行为，不能一律改成 div 或无条件
  `preventDefault()`。
- 回归护栏在 capture 的 `SETTINGS_CENTER_FIELDS_SCRIPT`：断言 `center.deviceLogin`
  根节点是 `DIV` 而不是 `LABEL`，并程序化点击字段标签文字，确认不出现
  「请先填写服务器地址」错误。
