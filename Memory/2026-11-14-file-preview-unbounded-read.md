# 文件预览整份 readFile：点 .mov / .mp3 卡死主界面

- 日期：2026-11-14
- 标签：文件面板, 预览, readFile, 内存, 卡死, 二进制, 误判文本, shell.openPath, 超时, 坑

## 用户现象

2026-11-14 用户实测：在右栏「文件」里点 `.mp3` / `.mov` 这类媒体文件，**打不开，且整个主界面卡死**。

## 根因（两处叠加）

`apps/desktop/src/main/file-preview.ts` 旧的分流顺序是：

```
if (stat.size > 2 MB) { readFile(整份) → kind: 'text' + truncated }
const buffer = await readFile(整份)
if (buffer.subarray(0, 8192).includes(0)) → unsupported
```

1. **整份读盘**：非图片 / 非 Office / 非老式 Office 的文件一律 `readFile` 整个文件。
   一个几百 MB 的 `.mov` 就是几百 MB 的 Buffer 进主进程 —— I/O + 分配 + GC，主进程长时间不可用。
2. **大二进制被判成文本**：`> 2 MB` 的分支在 NUL 探测**之前**就 return 了，
   于是 2 MB 二进制垃圾被当成 `text` 送进渲染层的 `<pre>`（往往是超长单行，没有换行），
   渲染层跟着卡；而且因为 `kind !== 'unsupported'`，**不会**触发「交给系统默认程序」。

`shell.openPath` 不是元凶：用 Electron 探针量过（Notepad 打开 `.txt`），
主线程最大停顿 `maxGap = 25 ms`（正常抖动），只是 Promise 要 834 ms 才结算。

## 修法

- 先 `readHead(path, 8192)` **只读头部**判 NUL；二进制 → `unsupported`，**不再整份读**。
- 文本路径：超过 2 MB 也只读前 2 MB（`readHead`），`truncated: true`。
- `readHead` 用 `fs.open` + `handle.read`，按 `handle.stat().size` 截断，任何体积都安全。
- 探针夹具 `二进制.bin` 改成 **64 MB 稀疏文件**：旧实现会落到「文本」分支 → 信息卡不出现 →
  `chat-file-office` 直接红，等于把这个回归永久钉住（不依赖计时断言）。

## 附带修的：`shell.openPath` 可能永不返回

无关联扩展名（如 `.mov`）点开会弹 Windows「选取应用」模态，实测这个 Promise
**可以一直不回来**（`.bin` 那次 `opening` 卡了 4.5 s+ 还在等），面板的「打开」按钮就一直禁用。
`file-open.ts` 加了 `OPEN_TIMEOUT_MS = 10s`，超时按失败报出「可在资源管理器中手动打开」。

## 别踩回去

- 不要为了「顺便识别编码」或「统计行数」而恢复整份 `readFile`——预览只需要头部。
- NUL 探测必须在任何「按大小截断当文本」的分支**之前**。
