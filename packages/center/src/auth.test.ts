import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthError, AuthStore, hashToken } from './auth.js'

async function makeAuth(): Promise<{ auth: AuthStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-center-auth-'))
  const auth = new AuthStore({ dataDir: dir })
  await auth.init()
  return { auth, dir }
}

describe('AuthStore · 用户账户', () => {
  it('创建用户、密码哈希不落明文、验证成功与失败', async () => {
    const { auth } = await makeAuth()
    const user = await auth.createUser({ username: 'alice', password: 'secret-123', role: 'admin' })
    expect(user.passHash).not.toContain('secret-123')
    expect(user.passSalt).not.toBe('')

    const verified = await auth.verifyPassword('alice', 'secret-123')
    expect(verified.id).toBe(user.id)
    await expect(auth.verifyPassword('alice', 'wrong')).rejects.toMatchObject({
      code: 'E_BAD_CREDENTIALS',
    })
    await expect(auth.verifyPassword('nobody', 'x')).rejects.toBeInstanceOf(AuthError)
  })

  it('重名用户与短密码被拒绝', async () => {
    const { auth } = await makeAuth()
    await auth.createUser({ username: 'bob', password: 'secret-123', role: 'user' })
    await expect(
      auth.createUser({ username: 'bob', password: 'secret-456', role: 'user' }),
    ).rejects.toMatchObject({ code: 'E_USER_EXISTS' })
    await expect(
      auth.createUser({ username: 'carol', password: '123', role: 'user' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGUMENT' })
  })

  it('删除最后一个管理员 / 删除自己被拒绝', async () => {
    const { auth } = await makeAuth()
    const admin = await auth.createUser({ username: 'root', password: 'secret-123', role: 'admin' })
    const user = await auth.createUser({ username: 'u', password: 'secret-123', role: 'user' })
    await expect(auth.deleteUser(admin.id, admin)).rejects.toMatchObject({ code: 'E_LAST_ADMIN' })
    await auth.deleteUser(user.id, admin)
    expect(auth.getUser(user.id)).toBeUndefined()
  })

  it('重置密码后旧密码失效', async () => {
    const { auth } = await makeAuth()
    const user = await auth.createUser({ username: 'dave', password: 'first-123', role: 'user' })
    await auth.resetPassword(user.id, 'second-456')
    await expect(auth.verifyPassword('dave', 'first-123')).rejects.toBeInstanceOf(AuthError)
    await expect(auth.verifyPassword('dave', 'second-456')).resolves.toBeTruthy()
  })

  it('ensureAdmin：无管理员时创建（返回一次性密码），有则跳过', async () => {
    const { auth } = await makeAuth()
    const first = await auth.ensureAdmin('admin')
    expect(first.created).toBe(true)
    expect((first.password ?? '').length).toBeGreaterThanOrEqual(6)
    const second = await auth.ensureAdmin('admin', 'explicit-pass')
    expect(second.created).toBe(false)
    expect(second.password).toBeUndefined()
  })
})

/**
 * 密码校验异步化（P2-15）：`scryptSync` 每次登录阻塞事件循环约 32ms，公网穷举
 * 30 req/s 就能让 WS 心跳被误判超时。回归点两条 —— ① 事件循环在校验期间不被阻塞；
 * ② 换异步之后**错误密码仍然被拒**（漏 await 的话拿到的是 Promise 对象 = 恒真，
 * 认证被静默绕过，这是本步最危险的失效模式）。
 */
describe('AuthStore · 密码校验异步化（P2-15）', () => {
  it('校验期间事件循环不被阻塞（scrypt 交给线程池）', async () => {
    const { auth } = await makeAuth()
    await auth.createUser({ username: 'busy', password: 'secret-123', role: 'user' })
    const verification = auth.verifyPassword('busy', 'secret-123').then(() => 'verified')
    // 同步版在这行之内就跑完了（~32ms）；异步版要等线程池回调，1ms 定时器必然先到
    const tick = new Promise<string>((resolve) => setTimeout(() => resolve('tick'), 1))
    expect(await Promise.race([verification, tick])).toBe('tick')
    await expect(verification).resolves.toBe('verified')
  })

  it('正确密码 resolve、错误密码 / 不存在的用户 reject（异步化不得让校验恒真）', async () => {
    const { auth } = await makeAuth()
    await auth.createUser({ username: 'async-user', password: 'secret-123', role: 'user' })
    await expect(auth.verifyPassword('async-user', 'secret-123')).resolves.toMatchObject({
      username: 'async-user',
    })
    await expect(auth.verifyPassword('async-user', 'wrong-pass')).rejects.toMatchObject({
      code: 'E_BAD_CREDENTIALS',
    })
    await expect(auth.verifyPassword('ghost-user', 'secret-123')).rejects.toBeInstanceOf(AuthError)
    // 创建 / 改密也走同一条异步哈希：改密后新密码生效、旧密码失效
    const created = await auth.createUser({
      username: 'async-reset',
      password: 'first-123',
      role: 'user',
    })
    await auth.resetPassword(created.id, 'second-456')
    await expect(auth.verifyPassword('async-reset', 'first-123')).rejects.toBeInstanceOf(AuthError)
    await expect(auth.verifyPassword('async-reset', 'second-456')).resolves.toBeTruthy()
  })
})

describe('AuthStore · 自助注册', () => {
  it('注册成功：固定 role:user，密码可验证', async () => {
    const { auth } = await makeAuth()
    const user = await auth.registerUser('newbie_1', 'long-enough-8')
    expect(user.role).toBe('user')
    expect(user.passHash).not.toContain('long-enough-8')
    await expect(auth.verifyPassword('newbie_1', 'long-enough-8')).resolves.toBeTruthy()
  })

  it('用户名 3–32 位字母数字下划线连字符；密码至少 8 位', async () => {
    const { auth } = await makeAuth()
    await expect(auth.registerUser('ab', 'long-enough-8')).rejects.toMatchObject({
      code: 'E_INVALID_ARGUMENT',
    })
    await expect(auth.registerUser('bad name!', 'long-enough-8')).rejects.toMatchObject({
      code: 'E_INVALID_ARGUMENT',
    })
    await expect(auth.registerUser('a'.repeat(33), 'long-enough-8')).rejects.toMatchObject({
      code: 'E_INVALID_ARGUMENT',
    })
    await expect(auth.registerUser('carol', 'short7')).rejects.toMatchObject({
      code: 'E_INVALID_ARGUMENT',
    })
    await expect(auth.registerUser('ok-name_1', 'long-enough-8')).resolves.toBeTruthy()
  })

  it('重名被拒绝（含与管理员重名）', async () => {
    const { auth } = await makeAuth()
    await auth.createUser({ username: 'taken', password: 'secret-123', role: 'admin' })
    await expect(auth.registerUser('taken', 'long-enough-8')).rejects.toMatchObject({
      code: 'E_USER_EXISTS',
    })
  })
})

describe('AuthStore · 客户端令牌', () => {
  it('账号登录颁发：创建即绑定 clientId，同 clientId 复用合法，异 clientId 拒绝', async () => {
    const { auth } = await makeAuth()
    const admin = await auth.createUser({ username: 'root', password: 'secret-123', role: 'admin' })
    const { token } = await auth.mintClientToken(admin.id, 'client-a', '账号登录')

    const bound = await auth.verifyClientToken(token, 'client-a')
    expect(bound).toBeDefined()
    const again = await auth.verifyClientToken(token, 'client-a')
    expect(again).toBeDefined()
    const hijack = await auth.verifyClientToken(token, 'client-b')
    expect(hijack).toBeUndefined()
    expect(auth.activeOwnerOfClient('client-a')).toBe(admin.id)
  })

  it('令牌哈希只存 SHA-256，明文不出现在列表里', async () => {
    const { auth } = await makeAuth()
    const admin = await auth.createUser({ username: 'root', password: 'secret-123', role: 'admin' })
    const { token, record } = await auth.mintClientToken(admin.id, 'client-hash', '')
    expect(hashToken(token)).toBe(hashToken(token))
    expect(auth.listClientTokens().some((entry) => entry.id === record.id)).toBe(true)
    expect(JSON.stringify(auth.listClientTokens())).not.toContain(token)
    expect(auth.listClientTokens()[0]).not.toHaveProperty('tokenHash')
  })

  it('同 clientId 重新登录吊销旧令牌：旧令牌失效、新令牌可用', async () => {
    const { auth } = await makeAuth()
    const user = await auth.createUser({ username: 'u', password: 'secret-123', role: 'user' })
    const first = await auth.mintClientToken(user.id, 'client-r', '第一次')
    const second = await auth.mintClientToken(user.id, 'client-r', '第二次')
    expect(await auth.verifyClientToken(first.token, 'client-r')).toBeUndefined()
    expect(await auth.verifyClientToken(second.token, 'client-r')).toBeDefined()
  })

  it('旧数据里未绑定令牌的首连属主护栏：他人 clientId 拒绑、空闲 clientId 放行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-legacy-token-'))
    const first = new AuthStore({ dataDir: dir })
    await first.init()
    const owner = await first.createUser({
      username: 'root',
      password: 'secret-123',
      role: 'admin',
    })
    const other = await first.createUser({
      username: 'mallory',
      password: 'secret-123',
      role: 'user',
    })
    // owner 已有绑定 client-bound 的有效令牌（账号登录路径）
    await first.mintClientToken(owner.id, 'client-bound', '登录')
    // 手工种一条旧版「未绑定」令牌（手动配对令牌功能面已删，这是 tokens.json 里的历史数据）
    const legacyToken = 'ac-legacy-unbound-token'
    const existing = await first.tokens.load()
    await first.tokens.save([
      ...existing,
      {
        id: 't-legacy',
        userId: other.id,
        tokenHash: hashToken(legacyToken),
        label: '',
        clientId: '',
        createdAt: new Date().toISOString(),
      },
    ])
    const second = new AuthStore({ dataDir: dir })
    await second.init()
    // mallory 的未绑定令牌试图首连绑定 owner 的设备 → 拒绝
    expect(await second.verifyClientToken(legacyToken, 'client-bound')).toBeUndefined()
    // 绑定空闲设备 → 正常首连绑定
    expect(await second.verifyClientToken(legacyToken, 'client-fresh')).toBeDefined()
  })
})

describe('AuthStore · 网页会话', () => {
  it('createWebSession → verifyWebSession 往返；未知令牌拒绝；drop 后失效', async () => {
    const { auth } = await makeAuth()
    const user = await auth.createUser({ username: 'eve', password: 'secret-123', role: 'admin' })
    const token = auth.createWebSession(user.id)
    expect(auth.verifyWebSession(token)?.id).toBe(user.id)
    expect(auth.verifyWebSession('deadbeef')).toBeUndefined()
    auth.dropWebSession(token)
    expect(auth.verifyWebSession(token)).toBeUndefined()
  })

  it('用户与令牌跨实例持久化（重启后登录与配对仍可用）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-persist-'))
    const first = new AuthStore({ dataDir: dir })
    await first.init()
    await first.createUser({ username: 'root', password: 'secret-123', role: 'admin' })
    const { token } = await first.mintClientToken(
      first.getUser('root', 'username')!.id,
      'client-p',
      '持久',
    )

    const second = new AuthStore({ dataDir: dir })
    await second.init()
    await expect(second.verifyPassword('root', 'secret-123')).resolves.toBeTruthy()
    expect(await second.verifyClientToken(token, 'client-p')).toBeDefined()
  })
})

/**
 * 会话表清扫与上限（P2-12）：过期会话原先只在被查询时顺带删 —— 而真实会话一旦过期就
 * 再也没人查它，那批条目会一直留在内存里（7 天 TTL 内无上界）。
 */
describe('AuthStore · 会话表清扫与上限（P2-12）', () => {
  it('createWebSession 时清扫过期会话（不用等谁来查询它）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-session-sweep-'))
    let current = 1_700_000_000_000
    const auth = new AuthStore({ dataDir: dir, now: () => current })
    await auth.init()
    const user = await auth.createUser({
      username: 'sweeper',
      password: 'secret-123',
      role: 'admin',
    })
    const expiring = auth.createWebSession(user.id)
    expect(auth.sessionCount).toBe(1)

    current += AuthStore.SESSION_TTL_MS + 1
    const fresh = auth.createWebSession(user.id)
    // 过期的那条在创建新会话时就被清掉了（不是"留在表里等验证"）
    expect(auth.sessionCount).toBe(1)
    expect(auth.verifyWebSession(expiring)).toBeUndefined()
    expect(auth.verifyWebSession(fresh)?.id).toBe(user.id)
  })

  it('超过上限时淘汰最旧，表长不再无界', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-session-cap-'))
    const auth = new AuthStore({ dataDir: dir, maxSessions: 3 })
    await auth.init()
    const user = await auth.createUser({
      username: 'capped',
      password: 'secret-123',
      role: 'admin',
    })
    const tokens = [0, 1, 2].map(() => auth.createWebSession(user.id))
    expect(auth.sessionCount).toBe(3)
    const newest = auth.createWebSession(user.id)
    expect(auth.sessionCount).toBe(3)
    expect(auth.verifyWebSession(tokens[0] as string)).toBeUndefined()
    expect(auth.verifyWebSession(tokens[2] as string)?.id).toBe(user.id)
    expect(auth.verifyWebSession(newest)?.id).toBe(user.id)
  })
})
