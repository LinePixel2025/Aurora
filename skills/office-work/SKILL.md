---
name: office-work
description: 用结构化 OfficeCLI 工具安全创建、读取、编辑、校验和渲染 DOCX / XLSX / PPTX；raw XML 只走独立确认工具
when_to_use: 需要创建、读取、修改、模板填充、批处理、渲染或导出 Office 文档（docx / xlsx / pptx）时
---

# office-work

## 目标

在 Windows 上稳定完成 DOCX / XLSX / PPTX 的创建、读取、元素级编辑、校验、渲染与 PDF 导出。
产出文件默认保存到工作模式的工作目录（`modes.work.workspaceDir`）。

## 唯一主路径：结构化 Office 工具

1. 修改已有文件前，先调用 `office_read`。读取结果里的元素路径（例如
   `/body/p[@paraId=...]`、`/slide[1]/shape[@id=...]`、`/Sheet1/A1`）是后续修改的稳定地址。
2. 对属性名、取值或高级元素不确定时，先调用 `office_help`。不要猜属性名。
3. 创建文件调用 `office_create`；已有文件默认用 `office_edit` 另存，只有用户明确要求覆盖时
   才传 `overwrite: true`。
4. 创建与编辑统一使用 OfficeCLI 命令数组：
   - `{ "command": "set", "path": "...", "props": { ... } }`
   - `{ "command": "add", "parent": "...", "type": "...", "props": { ... } }`
   - `{ "command": "remove", "path": "..." }`
   - `{ "command": "move", "path": "...", "to": "...", "index": 0 }`
   - `{ "command": "swap", "path": "...", "path2": "..." }`
5. 写入会自动执行 OpenXML `validate`；失败时不落盘。需要人工看版式时调用 `office_render`，
   它会直接返回 PNG 图片。
6. 需要 PDF 时调用 `office_pdf`。PDF 是逐页/逐表页面图合成，文字不可选择，这是当前明确口径。

## 高级能力

- 图表、透视表、公式、动画、转场、批注、公式/LaTeX、SmartArt、图片和形状等高级能力，
  通过 `office_help` 查询 L2 类型与属性后使用结构化命令完成。
- `office_raw_edit` 是唯一的 raw XML 工具，只在用户明确要求或确认后使用。普通工具失败时
  **不得自动改用 raw XML**，也不得手写 OOXML / ZIP 冒充成功。
- 不依赖本机 Word / Excel / PowerPoint，不自动启动 COM，不自动转旧格式或导出 PDF。

## 模板

- 模板用 `{{name}}` 表示占位符。
- `office_create` 传 `templatePath` + `templateData`；模板替换覆盖正文、表格、页眉页脚、
  图表标题等文本。
- 模板没有占位符时不要假装已替换；先读取并结构化编辑。

## 验证与安全

- 写后校验由工具自动完成；还要检查内容时用 `office_read` 的 `text` / `issues` / `validate`
  模式或 `office_render`。
- stdout 中文不能作为校验依据，必须回读目标文件 / XML / 渲染结果确认。
- 覆盖、删除、移动文件前必须先说明并等待用户确认。
- 结构化工具另存模式不需要先删目标；不要用“先删后写”模拟覆盖。
- 不确定内容时先 `office_read`，不要凭记忆改文件。
