/**
 * 客户端登记表（docs/12 §2.2 clients.json）。
 *
 * 在线状态不落盘 —— 它是连接层的实时事实；这里只持久化"这台机器曾经来过"的
 * 身份与属主关系，离线后仍可展示（灰点）并保留会话归属。
 */
import type { ModeId } from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import { JsonStore } from './store.js'

export interface ClientRecord {
  clientId: string
  name: string
  ownerUserId: string
  version: string
  platform: string
  lastMode: ModeId | string
  firstSeenAt: string
  lastSeenAt: string
  revokedAt?: string
}

export interface ClientRegistryOptions {
  dataDir: string
  logger?: Logger
}

export class ClientRegistry {
  private readonly store: JsonStore<ClientRecord[]>
  private records: ClientRecord[] = []
  private readonly logger?: Logger

  constructor(options: ClientRegistryOptions) {
    this.logger = options.logger
    this.store = new JsonStore<ClientRecord[]>(
      `${options.dataDir}/clients.json`,
      () => [],
      this.logger,
    )
  }

  async init(): Promise<void> {
    this.records = await this.store.load()
  }

  /** 登记 / 更新一次"见到客户端"（hello 或 status 时调用）。 */
  async upsert(input: {
    clientId: string
    name: string
    ownerUserId: string
    version: string
    platform: string
    mode: string
  }): Promise<ClientRecord> {
    const now = new Date().toISOString()
    const existing = this.records.find((record) => record.clientId === input.clientId)
    if (existing !== undefined) {
      // 属主跟随当前有效令牌（v0.2.1 账号登录语义）：设备换账号登录后 hello 即换归属，
      // 否则新属主在 Web 端永远看不到本机。安全性前提：能走到 upsert 的连接已通过
      // verifyPairingToken（令牌与 clientId 绑定一致），且首次绑定/登录换绑都有属主护栏。
      existing.ownerUserId = input.ownerUserId
      existing.name = input.name
      existing.version = input.version
      existing.platform = input.platform
      existing.lastMode = input.mode
      existing.lastSeenAt = now
      await this.store.save(this.records)
      return existing
    }
    const record: ClientRecord = {
      clientId: input.clientId,
      name: input.name,
      ownerUserId: input.ownerUserId,
      version: input.version,
      platform: input.platform,
      lastMode: input.mode,
      firstSeenAt: now,
      lastSeenAt: now,
    }
    this.records.push(record)
    await this.store.save(this.records)
    this.logger?.info('新客户端已登记', { clientId: input.clientId, name: input.name })
    return record
  }

  get(clientId: string): ClientRecord | undefined {
    return this.records.find((record) => record.clientId === clientId)
  }

  list(): ClientRecord[] {
    return [...this.records]
  }

  /** 属主用户可见的客户端（管理员用 `list()` 全量）。 */
  listFor(ownerUserId: string): ClientRecord[] {
    return this.records.filter((record) => record.ownerUserId === ownerUserId)
  }

  /** 解除登记（管理员操作）：客户端配置里的 clientId 仍在，但需重新配对才能上线。 */
  async remove(clientId: string): Promise<boolean> {
    const before = this.records.length
    this.records = this.records.filter((record) => record.clientId !== clientId)
    if (this.records.length !== before) {
      await this.store.save(this.records)
      return true
    }
    return false
  }

  /** 按属主清理（删除用户时调用）。 */
  async removeByOwner(ownerUserId: string): Promise<void> {
    this.records = this.records.filter((record) => record.ownerUserId !== ownerUserId)
    await this.store.save(this.records)
  }
}
