/**
 * Center 服务端密钥封装（docs/12 §12.1）。
 *
 * 上游 API Key 不以明文落盘。主密钥来自 `AURORA_CENTER_SECRET`，经 HKDF-SHA256 派生出
 * 固定的 AES-256-GCM key；密文格式为 `v1.<iv>.<tag>.<ciphertext>`（base64url）。
 * 主密钥缺失时服务端照常运行，但官方模型能力视为未配置。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const PREFIX = 'v1'
const HKDF_SALT = 'aurora-center:model-services:v1'
const HKDF_INFO = 'aurora-center:upstream-api-key'

export interface SecretBox {
  available: boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

export function createSecretBox(secret: string | undefined): SecretBox {
  const master = (secret ?? '').trim()
  if (master === '') {
    return {
      available: false,
      encrypt: () => {
        throw new Error('AURORA_CENTER_SECRET 未配置，无法加密上游 API Key')
      },
      decrypt: () => {
        throw new Error('AURORA_CENTER_SECRET 未配置，无法解密上游 API Key')
      },
    }
  }
  const key = Buffer.from(
    hkdfSync('sha256', Buffer.from(master, 'utf8'), Buffer.from(HKDF_SALT), HKDF_INFO, 32),
  )
  return {
    available: true,
    encrypt(value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return [PREFIX, iv, tag, ciphertext]
        .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
        .join('.')
    },
    decrypt(value) {
      const parts = value.split('.')
      if (parts.length !== 4 || parts[0] !== PREFIX) {
        throw new Error('密文格式不受支持')
      }
      const iv = Buffer.from(parts[1] as string, 'base64url')
      const tag = Buffer.from(parts[2] as string, 'base64url')
      const ciphertext = Buffer.from(parts[3] as string, 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    },
  }
}

export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim()
  if (trimmed === '') return ''
  if (trimmed.length <= 8) return '***'
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-3)}`
}
