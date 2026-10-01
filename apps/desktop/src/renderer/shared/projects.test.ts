/**
 * 「添加项目」共享逻辑的单测（`apps/desktop/src/renderer/**` 下的纯逻辑，vitest 以 node 环境跑）。
 *
 * 守护的是**两处入口的唯一口径**（docs/07 §2.3，2026-10-01）：
 * 设置页与主界面左栏都必须「加入 list + 设为当前项目」——此前左栏只追加 list、不动
 * `current`，用户报「在左栏加完项目并没有真正添加」（加了但没生效）。
 */
import { describe, expect, it } from 'vitest'
import type { ProjectConfig, ProjectsSettings } from '@aurora/shared'
import { appendProject, folderNameOf, newProjectId, pickProjectEntry } from './projects.js'

const base: ProjectsSettings = {
  current: 'proj-old',
  list: [{ id: 'proj-old', name: '旧项目', root: 'D:\\old' }],
  maxAgentsBytes: 32768,
}

const entry: ProjectConfig = { id: 'proj-new', name: '新项目', root: 'D:\\new' }

describe('folderNameOf', () => {
  it('取末段（同时兼容反斜杠与正斜杠、忽略末尾分隔符）', () => {
    expect(folderNameOf('C:\\Users\\me\\Documents')).toBe('Documents')
    expect(folderNameOf('C:/Users/me/Documents/')).toBe('Documents')
    expect(folderNameOf('D:\\ProTest\\Web_Game_Cater')).toBe('Web_Game_Cater')
  })

  it('UNC 路径取共享名；盘根回落成路径原文', () => {
    expect(folderNameOf('\\\\server\\share')).toBe('share')
    expect(folderNameOf('C:\\')).toBe('C:')
  })
})

describe('newProjectId', () => {
  it('带 proj- 前缀且两次生成不重复（id 只在本机标识，够随机即可）', () => {
    const a = newProjectId()
    const b = newProjectId()
    expect(a.startsWith('proj-')).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('appendProject', () => {
  it('追加到 list 末尾并把它设为当前项目（与设置页同款口径）', () => {
    const next = appendProject(base, entry)
    expect(next.list.map((item) => item.id)).toEqual(['proj-old', 'proj-new'])
    expect(next.current).toBe('proj-new')
  })

  it('保留 projects 子树的其它键（顶层浅合并下少带一个键就丢配置）', () => {
    expect(appendProject(base, entry).maxAgentsBytes).toBe(32768)
  })

  it('不改动入参（调用方拿的是 store 里的 reactive 对象）', () => {
    const before = JSON.stringify(base)
    appendProject(base, entry)
    expect(JSON.stringify(base)).toBe(before)
    expect(base.current).toBe('proj-old')
  })
})

/**
 * 选择框三态（2026-10-01 修「点了添加项目什么都没发生」）：注入 `pick`。
 *
 * ⚠️ 这三条是**防止静默失败回归**的主要护栏 —— 原生选择框探针驱动不了，
 * 若有人把「出错」并回「取消」分支（旧行为：两者都是 null → 调用方静默 return），
 * 除了这里没有任何测试会红。
 */
describe('pickProjectEntry', () => {
  it('选中：返回 picked，id 与默认名由共享规则生成', async () => {
    const outcome = await pickProjectEntry(async () => ({
      ok: true,
      value: 'C:\\Users\\me\\Documents',
    }))
    expect(outcome.kind).toBe('picked')
    if (outcome.kind !== 'picked') return
    expect(outcome.entry.root).toBe('C:\\Users\\me\\Documents')
    expect(outcome.entry.name).toBe('Documents')
    expect(outcome.entry.id.startsWith('proj-')).toBe(true)
  })

  it('用户取消：返回 canceled（不是错误，调用方按 no-op 处理）', async () => {
    const outcome = await pickProjectEntry(async () => ({ ok: true, value: null }))
    expect(outcome).toEqual({ kind: 'canceled' })
  })

  it('主进程报错：带出 message，不再被当成"用户取消"', async () => {
    const outcome = await pickProjectEntry(async () => ({
      ok: false,
      code: 'E_UNKNOWN',
      message: '选择框打不开',
    }))
    expect(outcome).toEqual({ kind: 'error', message: '选择框打不开' })
  })

  it('IPC 抛错：同样按错误上报（不静默）', async () => {
    const outcome = await pickProjectEntry(async () => {
      throw new Error('channel closed')
    })
    expect(outcome).toEqual({ kind: 'error', message: 'channel closed' })
  })
})
