# OfficeCLI 截图分页只认 `--page`，`--start/--end` 被静默忽略

- 日期：2026-11-14
- 标签：OfficeCLI, office-worker, 版式预览, 截图, 分页, office_render, office_pdf, 文件面板, 坑

## 现象

文件面板「版式」预览翻页时，页码从「第 1 / 3 页」走到「第 2 / 3 页」，但**页图字节完全不变**；
`chat-file-layout` 探针的 `secondSrcChanged` 当场判红。

同一份代码路径也影响 `office_render`（Agent 办公工具按 `maxPages` 取多页）与 `office_pdf`
（把每页 PNG 合成 PDF）—— 它们都会得到 N 份第 1 页。

## 根因

`apps/desktop/src/main/office-worker.ts` 的 `resolveRenderPages()` 原来给每页拼的是

```
view <file> screenshot --render html --screenshot-width 1600 --start N --end N -o out.png
```

但 OfficeCLI v1.0.153 的 `view --help` 写得很清楚：

- `--start/--end <start>` = **Start line/paragraph number**（text 模式的段落过滤）
- `--page <page>` = Page filter；**screenshot mode: default=1**

截图模式不读 `--start/--end`，于是每次都拍第 1 页，而且**不报错**（静默忽略最难发现）。

实测证据（同一份 3 页 docx）：

| 参数 | SHA256 前 8 位 | 大小 |
| --- | --- | --- |
| 无分页参数（默认 page=1） | 70d18b9a | 342334 |
| `--start 1 --end 1` | 70d18b9a | 342334 |
| `--start 2 --end 2` | 70d18b9a | 342334 |
| `--page 2` | aa80007b | 52924 |
| `--page 3` | a62379db | 8392 |

（`--page 1` 与无参数完全一致，确认「默认 1」的语义。）

## 修法

- `resolveRenderPages()` 的逐页 args 改成 `['--page', String(page)]`；
  留了注释说明 `--start/--end` 是 text 模式口径、截图时会被吞掉。
- `pageRangeArgs()`（`--grid` 缩略图拼版用）同样改成 `--page`：
  单页写 `"3"`，区间写 `"1-3"`（CLI 支持 `2-5` 这种写法）。
- `office-worker.test.ts` 里原来断言 `--start === '2'` 的那条**把 bug 钉成了契约**，
  改成断言 `--page === '2'` 且 `not.toContain('--start')`。

## 相关但不同的一条

xlsx 的 `pageIndex` 走的是**工作表切片**（`--range '<sheet>'`），完全不理 `pageStart/pageEnd`；
那条一直是好的，改分页参数时别顺手把它也换成 `--page`。
