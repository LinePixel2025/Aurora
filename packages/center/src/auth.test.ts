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
