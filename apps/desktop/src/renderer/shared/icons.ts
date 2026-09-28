/**
 * 图标清单（docs/07 §5 视觉方向）。
 *
 * 全部图标统一取自 [lucide](https://lucide.dev)（`lucide-vue-next`，ISC）：
 * 24×24 视框、纯描边、`stroke: currentColor`、圆头圆角 —— 与 Aurora 此前的
 * 手写内联 SVG 同一套语言，但形状统一、无需逐枚重画，也省掉了各窗口各自维护
 * `viewBox` / 描边宽度的漂移（此前提示条用 12/16 视框、caption 用 10，粗细不一）。
 *
 * 约定：
 * - **只在这里登记用到的图标**（具名再导出）。lucide 是 ESM 且 `sideEffects: false`，
 *   具名导入会被 Vite 摇树，未登记的图标不进产物；
 * - 尺寸走组件的 `size` 属性（默认继承 `currentColor` 与 `1.75` 描边宽）；
 *   需要与文字基线对齐的场合用 `.icon` 工具类（theme.css）约束 `flex: 0 0 auto`；
 * - 语义优先：同一动作在不同窗口必须用同一枚图标（例如「设置」一律 `Settings`）。
 */

export {
  // 窗口与导航
  PanelLeft,
  PanelRight,
  Settings,
  House,
  LayoutGrid,
  SlidersHorizontal,
  AudioLines,
  Cpu,
  Minus,
  Square,
  X,
  ChevronRight,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  // 对话与输入
  Sparkles,
  SquarePen,
  Zap,
  Mic,
  Trash2,
  Copy,
  Check,
  Volume2,
  // 会话归档（左栏会话项 hover 按钮 / 归档分组，2026-09）
  Archive,
  ArchiveRestore,
  // 输入框工具行（2026-09 输入框重做）：权限模式 / 上下文详解 / 斜杠命令
  ShieldCheck,
  ShieldOff,
  Paperclip,
  Gauge,
  Command,
  CornerDownLeft,
  // 状态与进度
  Circle,
  LoaderCircle,
  CircleCheck,
  CircleX,
  Clock,
  // 工具卡片语义图标
  Wrench,
  Terminal,
  FileText,
  FilePenLine,
  FolderOpen,
  Globe,
  Bell,
  ClipboardCopy,
  Image as ImageIcon,
  ListChecks,
  // 搜索层（grep / glob，v12）
  Search,
  FolderSearch,
  // 子代理（独立页面）
  Bot,
  // 自动化（独立页面，docs/13）：入口 / 编辑器 / 历史 / 启停
  Workflow,
  History,
  Play,
  Pencil,
  Plus,
  Power,
  Timer,
  BellRing,
  FolderOpenDot,
  // ClassIsland 联动
  School,
  CalendarClock,
  // 技能与扩展
  Puzzle,
  MessageSquare,
  // Aurora Center（设置页导航，docs/12）
  MonitorSmartphone,
} from 'lucide-vue-next'
