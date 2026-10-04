---
name: office-work
description: 用结构化 Office 工具安全创建、读取和编辑 DOCX / XLSX / PPTX；仅在用户明确要求高级兼容能力时使用 PowerShell COM 兜底
when_to_use: 需要创建、读取、修改、模板填充或批量处理 Office 文档（docx / xlsx / pptx）时
---

# office-work

## 目标

在 Windows 上稳定完成 DOCX / XLSX / PPTX 的创建、读取与常用编辑。产出文件默认保存到
工作模式的工作目录（`modes.work.workspaceDir`）。

## 首选：结构化 Office 工具

1. 修改已有文件前，先调用 `office_read`。
2. 创建新文件调用 `office_create`；已有文件默认另存，只有用户明确要求覆盖时才传 `overwrite: true`。
3. 常用编辑调用 `office_edit`：
   - DOCX：替换文字、占位符、追加内容、替换 section
   - XLSX：设置单元格、替换文字 / 占位符、增删工作表
   - PPTX：替换文字 / 占位符、增删或替换幻灯片
4. `office_edit` 默认另存为 `<原名>-Aurora-<时间戳>.<扩展名>`；覆盖会先做二进制快照。
5. 不要因为普通创建 / 编辑再调用 `run_command`。结构化工具报错或不支持时，如实说明限制。

## 模板

- 模板用 `{{name}}` 表示占位符。
- `office_create` 传 `templatePath` + `templateData`；模板中的标题、表格和样式会尽量保留。
- 模板没有占位符时不要假装已替换，改用结构化内容生成或先让用户提供带标记的模板。

## COM 兜底

仅当用户**明确要求**以下能力，并已理解风险后，才可用 `run_command` 走 PowerShell COM：

- 旧格式 `.doc` / `.xls` / `.ppt`
- 宏、复杂 SmartArt、复杂图表 / 动画的专门操作
- 结构化工具未覆盖的导出或转换

COM 脚本必须保持单条、非交互、短时间，使用 `try/finally` 收尾：

```powershell
$app = New-Object -ComObject Excel.Application
try {
  $app.Visible = $false
  $app.DisplayAlerts = $false
  # 打开、修改、保存
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
- 绝不能并行启动多个 COM 实例。

## 安全

- 覆盖 / 删除 / 移动文件前必须先说明并等待用户确认。
- 结构化工具另存模式不需要先删目标；不要用“先删后写”模拟覆盖。
- 不确定内容时先 `office_read`，不要凭记忆改文件。
