/**
 * 凭据加密：把 Electron safeStorage 适配为 shared 的 `CryptoPort`（docs/08 §2）。
 *
 * safeStorage 不可用（部分 Linux 环境 / 未登录密钥环）时返回 `nullCrypto` 语义：
 * 凭据只驻留内存，绝不落盘明文。
 */
import { safeStorage } from 'electron'
import type { CryptoPort } from '@aurora/shared'

export interface SafeStorageAdapter extends CryptoPort {
  /** 不可用原因，便于设置页提示 */
  unavailableReason?: string
}

export function createSafeStorageCrypto(): SafeStorageAdapter {
  let available = false
  try {
    available = safeStorage.isEncryptionAvailable()
  } catch {
    available = false
  }

  if (!available) {
    return {
      isAvailable: () => false,
      encrypt: () => '',
      decrypt: () => '',
      unavailableReason:
        '当前系统未提供可用的安全存储（safeStorage），API Key 将只保留在本次运行的内存中',
    }
  }

  return {
    isAvailable: () => {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encrypt: (plain: string) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipher: string) => {
      if (cipher === '') return ''
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    },
  }
}
