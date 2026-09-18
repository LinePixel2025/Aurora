/**
 * 系统感知采集（docs/06 §8、ADR-007）。
 *
 * P1 范围：时间 / 星期（进程内定时器）、电源、网络连通性。
 * 前台窗口、显示器、课程表属 P5；缺失的采集项一律降级为 `unknown`，绝不抛错。
 */
import os from 'node:os'
import { promises as dns } from 'node:dns'
import si from 'systeminformation'
import type { PerceptionSummary } from '@aurora/shared'
import type { Logger } from '@aurora/shared'

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const

export interface PerceptionOptions {
  logger: Logger
  /** 网络探测间隔，默认 30s */
  networkIntervalMs?: number
  /** 电源采集间隔，默认 5min（docs/06 §8.1） */
  powerIntervalMs?: number
  /** 探测使用的 DNS 服务器 */
  dnsTarget?: string
}

export class PerceptionHub {
  private readonly logger: Logger
  private readonly networkIntervalMs: number
  private readonly powerIntervalMs: number
  private readonly dnsTarget: string
  private timers: NodeJS.Timeout[] = []
  private power: PerceptionSummary['battery'] | undefined
  private network: PerceptionSummary['network'] | undefined
  private latestUnknown: string[] = []

  constructor(options: PerceptionOptions) {
    this.logger = options.logger
    this.networkIntervalMs = options.networkIntervalMs ?? 30_000
    this.powerIntervalMs = options.powerIntervalMs ?? 300_000
    this.dnsTarget = options.dnsTarget ?? '223.5.5.5'
  }

  start(): void {
    void this.refreshPower()
    void this.refreshNetwork()
    this.timers.push(setInterval(() => void this.refreshPower(), this.powerIntervalMs))
    this.timers.push(setInterval(() => void this.refreshNetwork(), this.networkIntervalMs))
    for (const timer of this.timers) timer.unref?.()
    this.logger.debug('系统感知已启动', {
      networkIntervalMs: this.networkIntervalMs,
      powerIntervalMs: this.powerIntervalMs,
    })
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }

  /** 当前感知摘要（用于上下文注入与 `system-status` Skill）。 */
  async summary(): Promise<PerceptionSummary> {
    const now = new Date()
    const unknown = [...this.latestUnknown]

    if (this.power === undefined) {
      await this.refreshPower()
      if (this.power === undefined) unknown.push('电源状态')
    }
    if (this.network === undefined) {
      await this.refreshNetwork()
      if (this.network === undefined) unknown.push('网络状态')
    }
    unknown.push('前台窗口', '显示器状态', '课程表')

    return {
      timestamp: now.toISOString(),
      localTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      weekday: WEEKDAYS[now.getDay()] ?? '未知',
      ...(this.power === undefined ? {} : { battery: this.power }),
      ...(this.network === undefined ? {} : { network: this.network }),
      unknown: [...new Set(unknown)],
    }
  }

  /** 供系统提示词使用的紧凑摘要（不返回 unknown 细节）。 */
  async contextSummary(): Promise<string> {
    const summary = await this.summary()
    const parts = [`当前时间：${summary.localTime} ${summary.weekday}`]
    if (summary.battery) {
      parts.push(
        summary.battery.hasBattery
          ? `电源：电池 ${summary.battery.percent}%${summary.battery.isCharging ? '（充电中）' : ''}`
          : '电源：已接通交流电',
      )
    }
    if (summary.network)
      parts.push(`网络：${summary.network.online ? '在线' : '离线'}（${summary.network.type}）`)
    parts.push(`主机：${os.hostname()} / ${os.platform()} ${os.release()}`)
    return parts.join('；')
  }

  private async refreshPower(): Promise<void> {
    try {
      const battery = await si.battery()
      this.power = {
        hasBattery: battery.hasBattery,
        percent: Math.round(battery.percent),
        isCharging: battery.isCharging,
      }
      this.latestUnknown = this.latestUnknown.filter((item) => item !== '电源状态')
    } catch (error) {
      this.power = undefined
      this.logger.debug('电源感知不可用，已降级为未知', { error: String(error) })
    }
  }

  private async refreshNetwork(): Promise<void> {
    try {
      const [online, interfaces] = await Promise.all([this.probeDns(), this.readInterfaceType()])
      this.network = { online, type: interfaces }
      this.latestUnknown = this.latestUnknown.filter((item) => item !== '网络状态')
    } catch (error) {
      this.network = undefined
      this.logger.debug('网络感知不可用，已降级为未知', { error: String(error) })
    }
  }

  private async probeDns(): Promise<boolean> {
    const resolver = new dns.Resolver({ timeout: 2000, tries: 1 })
    try {
      resolver.setServers([this.dnsTarget])
      await resolver.resolve4('www.baidu.com')
      return true
    } catch {
      return false
    }
  }

  private async readInterfaceType(): Promise<string> {
    try {
      const stats = await si.networkInterfaceDefault()
      return stats === '' ? '未知' : stats
    } catch {
      return '未知'
    }
  }
}

function pad(value: number): string {
  return `${value}`.padStart(2, '0')
}
