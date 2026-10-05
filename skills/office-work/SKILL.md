---
name: office-work
description: 用结构化 Office 工具安全创建、读取和编辑 DOCX / XLSX / PPTX；仅在用户明确要求高级兼容能力时使用 PowerShell COM 兜底
when_to_use: 需要创建、读取、修改、模板填充或批量处理 Office 文档（docx / xlsx / pptx）时
---

# office-work

## 目标

在 Windows 上稳定完成 DOCX / XLSX / PPTX 的创建、读取与常用编辑。产出文件默认保存到
工作模式的工作目录（`modes.work.workspaceDir`）。

## 唯一主路径：结构化 Office 工具

1. 修改已有文件前，先调用 `office_read`。
2. 创建新文件调用 `office_create`；已有文件默认另存，只有用户明确要求覆盖时才传 `overwrite: true`。
3. 常用编辑调用 `office_edit`：
   - DOCX：替换文字、占位符、追加内容、替换 section
   - XLSX：设置单元格、替换文字 / 占位符、增删工作表
   - PPTX：替换文字 / 占位符、增删或替换幻灯片
4. `office_edit` 默认另存为 `<原名>-Aurora-<时间戳>.<扩展名>`；覆盖会先做二进制快照。
5. 不要因为普通创建 / 编辑再调用 `run_command`。

DOCX 内容结构：

- `title` 和 `{ type: 'heading', level, text }` 会生成 Word 大纲标题，可用于导航窗格与目录。
- `{ type: 'bullets', items }` / `{ type: 'numbered', items }` 会生成真实 Word 编号，
  可选 `level: 0..8`；不要自己往文字里塞 `•` 或 `1.`。
- 需要验证结果时回读文件：`office_read`、重新解析包或逐段/逐 XML 核对。
  **stdout 里的中文不能作为校验依据**，控制台回显可能因代码页而串码。

## 失败后的硬边界

- 结构化工具报错或不支持时，如实说明限制并停止；不要降低要求假装成功。
- **不得手写 OOXML / ZIP 作为降级方案**。只有 3 个部件、没有 `styles.xml` / `numbering.xml`
  的文件不是合格的 Word 文档：标题没有大纲级别、列表不能重排、无法可靠导出 PDF。
- 不要因为结构化工具失败就自动改用 COM；也不要并行启动多个 Office COM 实例。

## 模板

- 模板用 `{{name}}` 表示占位符。
- `office_create` 传 `templatePath` + `templateData`；模板中的标题、表格和样式会尽量保留。
- 模板没有占位符时不要假装已替换，改用结构化内容生成或先让用户提供带标记的模板。

## COM 显式兜底（默认不执行）

只有用户**明确要求**旧格式 `.doc` / `.xls` / `.ppt`、宏、复杂 SmartArt / 图表 / 动画或
结构化工具未覆盖的导出，并已理解风险后，才可考虑 COM。它不是失败重试路径。

执行前先向用户确认，并把单次调用限制为**一条、非交互、短超时、可定位步骤**：

1. 先检查 Office 是否安装，以及是否已有残留进程；不要盲目重试。
2. 在 PowerShell 每一步前写 `AURORA_COM_STEP=...` 标记；设置
   `$ErrorActionPreference='Stop'`、关闭弹窗与可见窗口。
3. 用 `timeoutMs` 设置短上限（建议 15–30 秒）。若在 `New-Object -ComObject ...`
   阶段超时就停止，不重试；报告的“最后步骤标记 + 超时 + 目标文件未生成”就是有效诊断。
4. 超时后分别检查目标文件与 Office 进程；不要在用户有未保存文档时强杀 Office。

COM 脚本骨架（变量名和标记必须保留，业务步骤放在中间）：

```powershell
$ErrorActionPreference = 'Stop'
Write-Output 'AURORA_COM_STEP=before-create'
$app = New-Object -ComObject Excel.Application
Write-Output 'AURORA_COM_STEP=after-create'
try {
  $app.Visible = $false
  $app.DisplayAlerts = $false
  Write-Output 'AURORA_COM_STEP=before-save'
  # 打开、修改、保存
  Write-Output 'AURORA_COM_STEP=after-save'
} finally {
  if ($null -ne $app) {
    try { $app.Quit() } catch {}
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app)
    $app = $null
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
```

常见限制：

- Word / Excel / PowerPoint 必须已安装；未安装时不要反复重试。
- 文件被 Office 占用时先提示用户关闭，不硬闯。
- PowerPoint 的 `DisplayAlerts` 要设成 `2`（`ppAlertsNone`）。

## 安全

- 覆盖 / 删除 / 移动文件前必须先说明并等待用户确认。
- 结构化工具另存模式不需要先删目标；不要用“先删后写”模拟覆盖。
- 不确定内容时先 `office_read`，不要凭记忆改文件。
