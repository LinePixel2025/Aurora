/**
 * 插件宿主用量统计（`ctx.usage`，docs/14 §4.1、docs/15 §4.1.2）。
 *
 * 这是**本机**的只读聚合，不是 Aurora Center 的账号用量：数据由主进程在每轮
 * LLM `usage` 事件与服务成功返回处按本地日期计数，**不包含提示词 / 回复 / 图片 /
 * 音频 / 文件名 / 凭据**。历史会话没有逐日时间戳，因此不回溯。
 *
 * 纯类型 + 常量，无 Node 依赖：插件进程与主进程共用同一份口径。
 */

/** 查询窗口（天）：缺省 30，下限 1，上限 90（账本保留 90 天）。 */
export const PLUGIN_USAGE_DAYS = {
  default: 30,
  min: 1,
  max: 90,
} as const

/** 一段时间内的 Token 计数（与 Agent 内核的 `TokenUsage` 同名同义）。 */
export interface PluginUsageTokenTotals {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 缓存命中量；provider 没回传缓存字段的轮次按 0 计入 */
  cachedTokens: number
  /** 已累计的 LLM 轮次（provider 未回传 usage 的轮次不计） */
  rounds: number
}

/** 带命中率的 Token 统计（汇总与 `daily` 共用）。 */
export interface PluginUsageTokenStats extends PluginUsageTokenTotals {
  /** `cachedTokens / promptTokens`，0–1；没有数据时为 0 */
  cacheHitRate: number
}

export interface PluginUsageVoiceCounts {
  /** TTS 合成成功次数 */
  tts: number
  /** 实际送出的合成字符数合计 */
  ttsChars: number
  /** STT 识别成功次数 */
  stt: number
  /** 识别结果字符数合计 */
  sttChars: number
}

/** 单日计数（本地日期分桶）。 */
export interface PluginUsageDay {
  /** 本地日期 `YYYY-MM-DD` */
  date: string
  tokens: PluginUsageTokenStats
  /** 成功生图次数 */
  images: number
  voice: { tts: number; stt: number }
}

/** `ctx.usage.summary()` 的返回。 */
export interface PluginUsageSummary {
  /** 实际生效的窗口天数（已夹取到 1–90） */
  days: number
  /** 窗口首日（本地日期，含） */
  from: string
  /** 窗口末日（本地日期，含，即今天） */
  to: string
  tokens: PluginUsageTokenStats & {
    /** 其中后台自感知分析消耗的部分（同样含四个 Token 字段与轮次） */
    background: PluginUsageTokenTotals
  }
  images: { generated: number }
  voice: PluginUsageVoiceCounts
  /** 逐日序列：窗口内每一天都出现（无数据则为 0），适合直接画图 */
  daily: PluginUsageDay[]
}

/** `ctx.usage.summary(query?)` 的入参。 */
export interface PluginUsageQuery {
  /** 最近多少天（含今天）；缺省 30，夹取到 1–90 */
  days?: number
}
