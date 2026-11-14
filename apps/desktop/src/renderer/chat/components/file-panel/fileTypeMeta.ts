/**
 * 文件面板的类型元信息（docs/07 §2.3，2026-11-12）。
 *
 * 只服务右栏「文件」tab：扩展名 → 图标 / 色相 / 中文类型名。
 * **留在桌面本地**而不是 shared —— 这是文件管理器独有的语义，放 shared 会让
 * Center 网页端背一份用不到的导出（图标本身仍在 shared/browser/icons.ts 登记）。
 *
 * 色相的实际取值在 `FilePreviewPanel.vue` 的 `.fp` 作用域里集中定义一次
 * （含浅色覆盖），这里只给出 `tone` 名，行内样式一律 `var(--fp-<tone>)`。
 */
import type { Component } from 'vue'
import {
  Code2,
  FileArchive,
  FileAudio,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FolderOpen,
  ImageIcon,
  Presentation,
} from '@aurora/shared/browser'

/** 列表排序键（名称 / 大小 / 修改时间）；默认 name + asc，与主进程列目录口径一致 */
export type FileSortKey = 'name' | 'size' | 'mtime'

export type FileTone =
  | 'folder'
  | 'word'
  | 'excel'
  | 'ppt'
  | 'pdf'
  | 'image'
  | 'code'
  | 'archive'
  | 'media'
  | 'text'
  | 'unknown'

export interface FileTypeMeta {
  icon: Component
  tone: FileTone
  /** 中文类型名（预览头 pill / 信息卡用），例如「Word 文档」 */
  label: string
}

const TONE_ICONS: Record<FileTone, Component> = {
  folder: FolderOpen,
  word: FileText,
  excel: FileSpreadsheet,
  ppt: Presentation,
  pdf: FileText,
  image: ImageIcon,
  code: Code2,
  archive: FileArchive,
  media: FileVideo,
  text: FileText,
  unknown: FileQuestion,
}

const TONE_LABELS: Record<FileTone, string> = {
  folder: '文件夹',
  word: '文字文档',
  excel: '电子表格',
  ppt: '演示文稿',
  pdf: 'PDF 文档',
  image: '图片',
  code: '代码',
  archive: '压缩包',
  media: '音视频',
  text: '文本',
  unknown: '文件',
}

/** 色相分组：同一组共用一个 `--fp-*` 变量（组内再按扩展名给具体类型名） */
const TONE_GROUPS: ReadonlyArray<readonly [FileTone, string]> = [
  ['word', 'docx doc odt rtf'],
  ['excel', 'xlsx xls ods csv'],
  ['ppt', 'pptx ppt odp'],
  ['pdf', 'pdf'],
  ['image', 'png jpg jpeg gif webp svg bmp ico avif tif tiff'],
  [
    'code',
    'ts tsx js jsx mjs cjs vue json jsonc py go rs java kt c h cpp hpp cs rb php sh bash ps1 bat cmd yaml yml toml xml sql html htm css scss less',
  ],
  ['archive', 'zip rar 7z tar gz bz2 xz tgz'],
  ['media', 'mp4 mov avi mkv webm flv wmv mp3 wav flac m4a ogg aac opus'],
  ['text', 'txt md markdown log ini cfg conf env gitignore editorconfig'],
]

const TONE_OF = new Map<string, FileTone>()
for (const [tone, list] of TONE_GROUPS) {
  for (const ext of list.split(' ')) TONE_OF.set(ext, tone)
}

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus'])

/** 常见扩展名的准确类型名；没登记的回落到色相组名（如「代码」）或「XXX 文件」 */
const LABELS: Record<string, string> = {
  docx: 'Word 文档',
  doc: 'Word 文档（旧格式）',
  odt: 'OpenDocument 文本',
  rtf: 'RTF 文档',
  xlsx: 'Excel 工作簿',
  xls: 'Excel 工作簿（旧格式）',
  ods: 'OpenDocument 表格',
  csv: 'CSV 表格',
  pptx: 'PowerPoint 演示文稿',
  ppt: 'PowerPoint（旧格式）',
  odp: 'OpenDocument 演示',
  pdf: 'PDF 文档',
  md: 'Markdown',
  markdown: 'Markdown',
  txt: '纯文本',
  log: '日志',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  xml: 'XML',
  html: '网页',
  htm: '网页',
  css: '样式表',
  ts: 'TypeScript',
  tsx: 'TypeScript (JSX)',
  js: 'JavaScript',
  jsx: 'JavaScript (JSX)',
  vue: 'Vue 组件',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  cs: 'C#',
  sh: 'Shell 脚本',
  ps1: 'PowerShell 脚本',
  sql: 'SQL',
  zip: 'ZIP 压缩包',
  rar: 'RAR 压缩包',
  '7z': '7-Zip 压缩包',
  tar: 'TAR 归档',
  gz: 'GZip 压缩包',
  png: 'PNG 图片',
  jpg: 'JPEG 图片',
  jpeg: 'JPEG 图片',
  gif: 'GIF 图片',
  webp: 'WebP 图片',
  svg: 'SVG 矢量图',
  bmp: 'BMP 图片',
  ico: '图标',
  mp4: 'MP4 视频',
  mov: 'QuickTime 视频',
  mkv: 'Matroska 视频',
  webm: 'WebM 视频',
  mp3: 'MP3 音频',
  wav: 'WAV 音频',
  flac: 'FLAC 音频',
}

/** 取扩展名（不含点、小写）；无扩展名 / 以点开头（`.gitignore`）时按整名查表 */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return base.startsWith('.') ? base.slice(1).toLowerCase() : ''
  return base.slice(dot + 1).toLowerCase()
}

export function fileTypeMetaOf(name: string, kind: 'dir' | 'file' = 'file'): FileTypeMeta {
  if (kind === 'dir') return { icon: FolderOpen, tone: 'folder', label: '文件夹' }
  const ext = extensionOf(name)
  const tone = TONE_OF.get(ext) ?? 'unknown'
  const icon = tone === 'media' && AUDIO_EXTENSIONS.has(ext) ? FileAudio : TONE_ICONS[tone]
  const label = LABELS[ext] ?? (tone === 'unknown' ? unknownLabel(ext) : TONE_LABELS[tone])
  return { icon, tone, label }
}

function unknownLabel(ext: string): string {
  return ext === '' ? '文件' : `${ext.toUpperCase()} 文件`
}

/** 人类可读大小（列表与预览头共用；`formatExactCount` 那套千分位裸字节数留给元信息明细） */
export function formatFileBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 1 : 0)
  return `${text.replace(/\.0$/, '')} ${units[unit]}`
}

/** 修改时间：`YYYY-MM-DD HH:mm`（本地时区；缺省时间戳回空串，由调用方决定要不要占位） */
export function formatFileTime(mtimeMs: number | undefined): string {
  if (mtimeMs === undefined || !Number.isFinite(mtimeMs) || mtimeMs <= 0) return ''
  const date = new Date(mtimeMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
