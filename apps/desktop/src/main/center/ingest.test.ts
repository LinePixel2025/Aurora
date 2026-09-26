import { describe, expect, it } from 'vitest'
import { CenterUploadError, httpOriginOf } from './ingest.js'

describe('httpOriginOf · 服务器地址折算', () => {
  it('ws(s)/http(s) 都折算成 HTTP origin；非法地址返回 undefined', () => {
    expect(httpOriginOf('ws://10.0.0.2:8787')).toBe('http://10.0.0.2:8787')
    expect(httpOriginOf('wss://center.example.com')).toBe('https://center.example.com')
    expect(httpOriginOf('http://center.example.com/')).toBe('http://center.example.com')
    expect(httpOriginOf('https://center.example.com/base')).toBe('https://center.example.com')
    expect(httpOriginOf('not-a-url')).toBeUndefined()
    expect(httpOriginOf('ftp://center.example.com')).toBeUndefined()
  })
})

describe('CenterUploadError · 错误码', () => {
  it('携带结构化错误码供日志与回执区分', () => {
    const error = new CenterUploadError('未配置', 'E_NOT_CONFIGURED')
    expect(error.code).toBe('E_NOT_CONFIGURED')
    expect(error.message).toBe('未配置')
  })
})
