import { describe, expect, it, vi } from 'vitest'
import { createMemoryLogger, type SessionPlan } from '@aurora/shared'
import type { PlanFileStore } from './files.js'
import { PlanModeError, createPlanService, type PlanStorePort } from './service.js'

function storeOf(initial: SessionPlan = { active: false }): {
  port: PlanStorePort
  current: () => SessionPlan
  setPlan: ReturnType<typeof vi.fn>
} {
  let value = initial
  const setPlan = vi.fn(async (_sessionId: string, next: SessionPlan | null) => {
    value = next ?? { active: false }
  })
  return {
    port: {
      planOf: async () => value,
      planOfSync: () => value,
      setPlan,
    },
    current: () => value,
    setPlan,
  }
}

function filesOf(): PlanFileStore & {
  write: ReturnType<typeof vi.fn>
  setStatus: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  deleteSession: ReturnType<typeof vi.fn>
} {
  return {
    write: vi.fn(async (input: { planId: string; markdown: string }) => ({
      id: input.planId,
      title: '实施计划',
      createdAt: '2026-11-21T10:00:00.000Z',
      status: 'pending' as const,
    })),
    setStatus: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    read: vi.fn(async () => ({
      id: 'c1',
      title: '实施计划',
      createdAt: '2026-11-21T10:00:00.000Z',
      status: 'pending' as const,
      markdown: '# P',
    })),
    remove: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
  }
}

const PLAN = '# 实施计划\n\n1. 改 A'

function setup(initial?: SessionPlan, busy = false) {
  const store = storeOf(initial)
  const files = filesOf()
  let now = Date.parse('2026-11-21T10:00:00.000Z')
  const service = createPlanService({
    sessions: store.port,
    files,
    isBusy: () => busy,
    logger: createMemoryLogger(),
    clock: () => new Date((now += 1000)),
  })
  return { service, store, files }
}

describe('PlanService（docs/06 §29 计划模式状态机）', () => {
  it('setActive(true/false)：运行中拒绝；退出时待批准记录标 exited 并同步文件', async () => {
    const record = {
      id: 'c1',
      markdown: PLAN,
      status: 'pending' as const,
      createdAt: '2026-11-21T09:00:00.000Z',
      updatedAt: '2026-11-21T09:00:00.000Z',
    }
    const busy = setup({ active: false, record }, true)
    await expect(busy.service.setActive('main', true)).rejects.toMatchObject({ code: 'E_BUSY' })

    const { service, store, files } = setup({ active: true, record })
    const next = await service.setActive('main', false)
    expect(next.active).toBe(false)
    expect(next.record?.status).toBe('exited')
    expect(store.current().active).toBe(false)
    expect(files.setStatus).toHaveBeenCalledWith('main', 'c1', 'exited')
  })

  it('setActive 幂等：同状态不重复写盘', async () => {
    const { service, store } = setup({ active: false })
    expect((await service.setActive('main', false)).active).toBe(false)
    expect(store.setPlan).not.toHaveBeenCalled()
    const active = setup({ active: true })
    expect((await active.service.setActive('main', true)).active).toBe(true)
    expect(active.store.setPlan).not.toHaveBeenCalled()
  })

  it('submit：先写文件再写 meta；非计划模式 / 非法正文被拒绝', async () => {
    const inactive = setup({ active: false })
    await expect(
      inactive.service.submit({ sessionId: 'main', planId: 'c1', markdown: PLAN }),
    ).rejects.toMatchObject({ code: 'E_INVALID_STATE' })
    expect(inactive.files.write).not.toHaveBeenCalled()

    const { service, store, files } = setup({ active: true })
    const plan = await service.submit({ sessionId: 'main', planId: 'c1', markdown: PLAN })
    expect(plan.record).toMatchObject({ id: 'c1', status: 'pending' })
    expect(files.write).toHaveBeenCalledWith({
      sessionId: 'main',
      planId: 'c1',
      markdown: PLAN,
      status: 'pending',
    })
    expect(store.current().record?.id).toBe('c1')

    await expect(
      service.submit({ sessionId: 'main', planId: 'c2', markdown: '没有标题' }),
    ).rejects.toBeInstanceOf(PlanModeError)
  })

  it('submit：文件写失败不写 meta；meta 写失败回滚文件', async () => {
    const fileFail = setup({ active: true })
    fileFail.files.write.mockRejectedValueOnce(new Error('磁盘满'))
    await expect(
      fileFail.service.submit({ sessionId: 'main', planId: 'c1', markdown: PLAN }),
    ).rejects.toThrow('磁盘满')
    expect(fileFail.store.setPlan).not.toHaveBeenCalled()

    const metaFail = setup({ active: true })
    metaFail.store.setPlan.mockRejectedValueOnce(new Error('会话写失败'))
    await expect(
      metaFail.service.submit({ sessionId: 'main', planId: 'c1', markdown: PLAN }),
    ).rejects.toThrow('会话写失败')
    expect(metaFail.files.remove).toHaveBeenCalledWith('main', 'c1')
  })

  it('submit：旧 pending 被新计划取代时标 superseded（已批准的历史不动）', async () => {
    const old = {
      id: 'old',
      markdown: '# 旧',
      status: 'pending' as const,
      createdAt: '2026-11-21T09:00:00.000Z',
      updatedAt: '2026-11-21T09:00:00.000Z',
    }
    const { service, files } = setup({ active: true, record: old })
    await service.submit({ sessionId: 'main', planId: 'new', markdown: PLAN })
    expect(files.setStatus).toHaveBeenCalledWith('main', 'old', 'superseded')

    const approved = setup({
      active: true,
      record: { ...old, status: 'approved' },
    })
    await approved.service.submit({ sessionId: 'main', planId: 'new', markdown: PLAN })
    expect(approved.files.setStatus).not.toHaveBeenCalledWith('main', 'old', 'superseded')
  })

  it('approve：校验 active / id / pending / 忙；成功后 active=false 并同步文件', async () => {
    const pending = setup({
      active: true,
      record: {
        id: 'c1',
        markdown: PLAN,
        status: 'pending',
        createdAt: '2026-11-21T09:00:00.000Z',
        updatedAt: '2026-11-21T09:00:00.000Z',
      },
    })
    await expect(pending.service.approve('main', 'other')).rejects.toMatchObject({
      code: 'E_INVALID_STATE',
    })
    const approved = await pending.service.approve('main', 'c1')
    expect(approved).toMatchObject({ active: false, record: { id: 'c1', status: 'approved' } })
    expect(pending.files.setStatus).toHaveBeenCalledWith('main', 'c1', 'approved')

    const busy = setup(
      {
        active: true,
        record: {
          id: 'c1',
          markdown: PLAN,
          status: 'pending',
          createdAt: '2026-11-21T09:00:00.000Z',
          updatedAt: '2026-11-21T09:00:00.000Z',
        },
      },
      true,
    )
    await expect(busy.service.approve('main', 'c1')).rejects.toMatchObject({ code: 'E_BUSY' })
  })

  it('restorePending：只回滚同一条 approved 记录', async () => {
    const record = {
      id: 'c1',
      markdown: PLAN,
      status: 'approved' as const,
      createdAt: '2026-11-21T09:00:00.000Z',
      updatedAt: '2026-11-21T09:00:00.000Z',
    }
    const { service, store, files } = setup({ active: false, record })
    await service.restorePending('main', 'c1')
    expect(store.current()).toMatchObject({ active: true, record: { id: 'c1', status: 'pending' } })
    expect(files.setStatus).toHaveBeenCalledWith('main', 'c1', 'pending')

    const other = setup({ active: false, record })
    await other.service.restorePending('main', 'other')
    expect(other.store.setPlan).not.toHaveBeenCalled()
  })

  it('list / read：用 meta 当前记录覆盖文件索引状态；deleteSessionFiles 委托文件存储', async () => {
    const { service, files } = setup({
      active: false,
      record: {
        id: 'c1',
        markdown: PLAN,
        status: 'approved',
        createdAt: '2026-11-21T09:00:00.000Z',
        updatedAt: '2026-11-21T09:00:00.000Z',
      },
    })
    files.list.mockResolvedValueOnce([
      { id: 'c1', title: '实施计划', createdAt: '2026-11-21T09:00:00.000Z', status: 'pending' },
    ])
    expect((await service.list('main'))[0]?.status).toBe('approved')

    files.read.mockResolvedValueOnce({
      id: 'c1',
      title: '实施计划',
      createdAt: '2026-11-21T09:00:00.000Z',
      status: 'pending',
      markdown: PLAN,
    })
    expect((await service.read('main', 'c1')).status).toBe('approved')

    await service.deleteSessionFiles('main')
    expect(files.deleteSession).toHaveBeenCalledWith('main')
  })
})
