---
name: office-work
description: 用 PowerShell COM 自动化操作 Word / Excel / PowerPoint（生成、读取、转换、汇总）的要点与常见坑
when_to_use: 需要读写、转换、合并或汇总 Office 文档（docx / xlsx / pptx / pdf），或批量处理表格数据时
---

# office-work

## 目标

在 Windows 上完成 Office 文档的生成、读取、转换与汇总；产出文件默认保存到
工作模式的工作目录（`modes.work.workspaceDir`）。

## 首选：PowerShell + COM 自动化

用 `run_command` 执行 PowerShell，通过 COM 驱动本机已安装的 Office：

```powershell
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$wb = $excel.Workbooks.Open('D:\工作目录\报表.xlsx')
$ws = $wb.Worksheets.Item(1)
$ws.Cells.Item(1, 1).Value2 = '合计'
$wb.SaveAs('D:\工作目录\报表-新.xlsx', 51)   # 51 = xlsx
$wb.Close($false)
$excel.Quit()
```

三个应用对应的 COM 类名：Excel → `Excel.Application`，Word → `Word.Application`，
PowerPoint → `PowerPoint.Application`。

常见坑（每条都踩过）：

- **COM 对象必须收尾**：`Quit()` 之后对每个用到的对象执行
  `[System.Runtime.InteropServices.Marshal]::ReleaseComObject($obj) | Out-Null`，最后置 `$null`；
  否则 `EXCEL.EXE` / `WINWORD.EXE` / `POWERPNT.EXE` 残留后台进程，越积越多。
- **文件被占用**：打开 / 保存报 `0x800A03EC` 一类错误时，先确认文件没有正被 Office 打开；
  无法确认时提示用户关闭文件后再试，不要反复重试硬闯。
- **保存格式枚举值**：xlsx=51、docx=16、pptx=24；导出 PDF 用
  `ExportAsFixedFormat`（Excel），或 `SaveAs` 指定 17（Word 的 wdFormatPDF）/ 32（PowerPoint 的 ppSaveAsPDF）。
- **弹窗会卡死无人值守的自动化**：Excel / Word 设 `DisplayAlerts = $false`、`Visible = $false`；
  PowerPoint 的 `DisplayAlerts` 要设枚举值 `2`（ppAlertsNone）。
- **路径用绝对路径**，保存前确认目标目录存在；批量处理时顺序执行，
  不要并发多个 COM 实例（COM 是单线程套间，并发只会互相卡死）。

## 备选：Python（若用户环境已有）

- 表格用 `openpyxl`（xlsx），文档用 `python-docx`，演示文稿用 `python-pptx`，PDF 用 `pypdf`。
- 这些包未安装时**不要擅自 pip install**，先询问用户。
- 纯文本 / CSV / Markdown 直接用 `read_file` / `write_file` 处理即可，不必动 COM。

## 安全与兜底

- **大文件先备份**：修改前先 `Copy-Item 原文件 原文件.bak`，失败可回退；
  覆盖 / 删除 / 移动文件前必须先向用户确认（工作模式的安全约束）。
- Office 未安装时 COM 方案整体不可用——如实说明并改走 Python / 纯文本方案，不要反复报错重试。
