# 文件面板 capture 探针三坑：脱离文档的 emit、文本身份键、真拉系统程序

- 日期：2026-11-14
- 标签：capture, 探针, 文件面板, Vue, emit, 坑, 系统打开, OpenWith, OfficeCLI

## 1. 脱离文档的旧行点击：内联 `@click` 会响，子组件 `emit` 不响

`chat-file-project` 探针里 `const wideRow = rowNamed('宽内容.md')` 只取一次，之后点它。
列表 ↔ 预览切换会把整棵列表**卸载重挂**，那个节点已经脱离文档。

- 旧实现（`<button @click="activate(entry)">`）照样能触发 —— 监听器挂在元素自身上，
  `element.click()` 不要求它在文档里。
- 拆成子组件后（`FilePanelList.vue` 里 `@click="emit('activate', entry)"`）**静默失效**：
  Vue 的 `emit()` 开头就是 `if (instance.isUnmounted) return`。

于是「宽内容预览」那一屏直接没打开 → `wideShown:false` + `toolbarInView:false`（`exit` 钮不存在）。

**口径**：探针每次点击都重新查询目标行（`clickRow(name)`），不缓存 DOM 引用。

## 2. 收尾别用整行文本当身份键

`SessionRow` 的行文本含相对时间（「刚刚」→「1 分钟前」），跨分钟就失配。
仓库里早就有稳定锚点：`.nav-row` 上的 `data-session-id`。

注意 `data-session-id` 在**外层 `.nav-row`**，不在 `button.nav-item` 上 ——
选择器要写 `.nav-row[data-session-id="…"] button.nav-item`。
act 侧记录用 `.nav-row.active`（`.nav-item` 上也有 `active` 类，但外层才是带 id 的那个）。

## 3. `.bin` 一点就真的拉起系统程序（Windows「选取应用」模态）

用户要求「不支持预览的类型直接交给系统默认程序」，所以 `activate()` 对 `kind === 'unsupported'`
会自动调 `preview:open`。实测点 `.bin` 会弹出 `OpenWith.exe`（「选取应用」）**抢焦点**，
后续截图场景全废，并且它会把探针里的两枚动作钮一直压在 `opening` 态（`cardEnabled:false`）。

**口径**：capture 里只换掉链路**最后一步** —— `prepare` 调 `interceptSystemOpen()`
把 `shell.openPath` / `shell.showItemInFolder` 换成记录器，`nativeCheck` 断言调用序列后还原
（`restoreSystemOpen?.()`）。渲染层 → IPC → `assertPreviewPath` → lstat → 软链拒绝 → isFile
全部照常跑，只是不真的执行。

断言形状（`chat-file-office`）：
`calls === ['default:二进制.bin', 'reveal:二进制.bin']` —— 自动打开一次 + 手动「在资源管理器中显示」一次；
可预览的 docx 一次都不该有（防「顺手把所有点击都当系统打开」）。

## 4. 附带：本机 Edge headless 起不来，Center 网页端验收走 Chrome

2026-11-14 实测 `puppeteer.launch({ executablePath: msedge.exe, headless: true })`
稳定报 `Failed to launch the browser process!`（手工起 `--headless --dump-dom` 也拿不到输出），
而同一时刻 `chrome.exe` 正常。`verify:web` 用 `AURORA_CWEB_BROWSER` 指到 Chrome 即可：

```bash
AURORA_CWEB_BROWSER='C:\Program Files\Google\Chrome\Application\chrome.exe' \
  pnpm --filter @aurora/center verify:web
```

排障时先看 `Get-CimInstance Win32_Process` 里有没有上一轮残留的
`--user-data-dir=…puppeteer_dev_chrome_profile…` 的 headless 进程（会锁 profile 目录，清理后仍复现才是真问题）。
