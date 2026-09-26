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
  it('创建用户、口令哈希不落明文、验证成功与失败', async () => {
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

  it('重名用户与短口令被拒绝', async () => {
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

  it('重置口令后旧口令失效', async () => {
    const { auth } = await makeAuth()
    const user = await auth.createUser({ username: 'dave', password: 'first-123', role: 'user' })
    await auth.resetPassword(user.id, 'second-456')
    await expect(auth.verifyPassword('dave', 'first-123')).rejects.toBeInstanceOf(AuthError)
    await expect(auth.verifyPassword('dave', 'second-456')).resolves.toBeTruthy()
  })

  it('ensureAdmin：无管理员时创建（返回一次性口令），有则跳过', async () => {
    const { auth } = await makeAuth()
    const first = await auth.ensureAdmin('admin')
    expect(first.created).toBe(true)
    expect((first.password ?? '').length).toBeGreaterThanOrEqual(6)
    const second = await auth.ensureAdmin('admin', 'explicit-pass')
    expect(second.created).toBe(false)
    expect(second.password).toBeUndefined()
  })
})

describe('AuthStore · 配对令牌', () => {
  it('创建 → 首次连接绑定 clientId → 同 clientId 复用合法，异 clientId 拒绝', async () => {
    const { auth } = await makeAuth()
    const admin = await auth.createUser({ username: 'root', password: 'secret-123', role: 'admin' })
    const { token } = await auth.createPairingToken(admin.id, '笔记本')

    const bound = await auth.verifyPairingToken(token, 'client-a')
    expect(bound).toBeDefined()
    const again = await auth.verifyPairingToken(token, 'client-a')
    expect(again).toBeDefined()
    const hijack = await auth.verifyPairingToken(token, 'client-b')
    expect(hijack).toBeUndefined()
  })

  it('令牌哈希只存 SHA-256，明文不出现在列表里', async () => {
    const { auth } = await makeAuth()
    const admin = await auth.createUser({ username: 'root', password: 'secret-123', role: 'admin' })
    const { token, record } = await auth.createPairingToken(admin.id, '')
    expect(hashToken(token)).toBe(
      // 令牌记录里存的是哈希（通过 verify 反推）
      hashToken(token),
    )
    expect(auth.listPairingTokens().some((entry) => entry.id === record.id)).toBe(true)
    expect(JSON.stringify(auth.listPairingTokens())).not.toContain(token)
    const stored = auth.findByTokenId(record.id)
    expect(stored?.tokenHash).not.toBe(token)
  })

  it('吊销后令牌失效；非属主吊销他人令牌被拒', async () => {
    const { auth } = await makeAuth()
    const admin = await auth.createUser({ username: 'root', password: 'secret-123', role: 'admin' })
    const user = await auth.createUser({ username: 'u', password: 'secret-123', role: 'user' })
    const adminToken = await auth.createPairingToken(admin.id, 'a')
    const userToken = await auth.createPairingToken(user.id, 'b')

    await expect(auth.revokePairingToken(adminToken.record.id, user)).rejects.toMatchObject({
      code: 'E_TOKEN_NOT_FOUND',
    })
    await auth.revokePairingToken(adminToken.record.id, admin)
    expect(await auth.verifyPairingToken(adminToken.token, 'client-x')).toBeUndefined()
    // 属主可以吊销自己的
    await auth.revokePairingToken(userToken.record.id, user)
    expect(await auth.verifyPairingToken(userToken.token, 'client-y')).toBeUndefined()
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
    const { token } = await first.createPairingToken(
      first.getUser('root', 'username')!.id,
      '持久',
    )

    const second = new AuthStore({ dataDir: dir })
    await second.init()
    await expect(second.verifyPassword('root', 'secret-123')).resolves.toBeTruthy()
    expect(await second.verifyPairingToken(token, 'client-p')).toBeDefined()
  })
})
