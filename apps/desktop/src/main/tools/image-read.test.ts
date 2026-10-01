/**
 * `view_image` 读盘策略纯逻辑的单测（图像工具，docs/06 §25）。
 *
 * 两条判定各自钉住：**app 自有目录**（决定要不要跳过项目根边界）与**扩展名**（决定该不该
 * 让这次调用继续走到读盘）。它们都是字符串逻辑，因此可以在这里穷举边界，
 * 而不必去跑 Electron 或真实磁盘。
 */
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { OWNED_IMAGE_SUBDIRS, isWithinAnyDir, unsupportedFormatNote } from './image-read.js'

const USER_DATA = 'C:\\Users\\u\\AppData\\Roaming\\Aurora'
const OWNED = OWNED_IMAGE_SUBDIRS.map((name) => `${USER_DATA}\\${name}`)

describe('OWNED_IMAGE_SUBDIRS', () => {
  it('三个目录名与落盘实现一致（名单漂移的症状是"读不了自己刚存的图"）', () => {
    // generated = 生图、screenshots = 截屏、clipboard = 剪贴板图片
    expect([...OWNED_IMAGE_SUBDIRS]).toEqual(['generated', 'screenshots', 'clipboard'])
  })
})

describe('isWithinAnyDir', () => {
  it('目录内的文件与子目录都算命中', () => {
    expect(isWithinAnyDir(`${USER_DATA}\\screenshots\\1-a.png`, OWNED)).toBe(true)
    expect(isWithinAnyDir(`${USER_DATA}\\generated\\nested\\x.png`, OWNED)).toBe(true)
  })

  it('目录外（含换到别的盘、平级目录）不算命中', () => {
    expect(isWithinAnyDir('D:\\photos\\cat.png', OWNED)).toBe(false)
    expect(isWithinAnyDir(`${USER_DATA}\\logs\\a.png`, OWNED)).toBe(false)
    // 前缀相似但不同名：`screenshots-old` 不是 `screenshots`
    expect(isWithinAnyDir(`${USER_DATA}\\screenshots-old\\a.png`, OWNED)).toBe(false)
  })

  it('`..` 逃逸不算命中（归一到目录之外）', () => {
    expect(isWithinAnyDir(`${USER_DATA}\\screenshots\\..\\..\\..\\Windows\\a.png`, OWNED)).toBe(
      false,
    )
  })

  it('命中目录本身不算命中（那是目录，不是文件；交给读盘去如实报错）', () => {
    expect(isWithinAnyDir(`${USER_DATA}\\screenshots`, OWNED)).toBe(false)
  })

  it('相对路径先按当前工作目录归一（与 file-port 的 resolve 口径一致）', () => {
    expect(isWithinAnyDir(resolve(`${USER_DATA}\\screenshots\\a.png`), OWNED)).toBe(true)
  })
})

describe('unsupportedFormatNote', () => {
  it('六种图片扩展名放行（大小写不敏感）', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']) {
      expect(unsupportedFormatNote(`C:\\a.${ext}`)).toBeUndefined()
      expect(unsupportedFormatNote(`C:\\a.${ext.toUpperCase()}`)).toBeUndefined()
    }
  })

  it('文本 / 未知扩展名：给出可操作提示（指向 read_file）', () => {
    const note = unsupportedFormatNote('C:\\proj\\AGENTS.md')
    expect(note).toContain('.md')
    expect(note).toContain('read_file')

    expect(unsupportedFormatNote('C:\\proj\\data.json')).toContain('read_file')
    // tif / svg 归分类管线的图片类型，但不属于"能作为图片分片下发"的子集
    expect(unsupportedFormatNote('C:\\a.tif')).toContain('read_file')
    expect(unsupportedFormatNote('C:\\a.svg')).toContain('read_file')
  })

  it('没有扩展名也拒绝（不说"格式不支持"这种误导话）', () => {
    const note = unsupportedFormatNote('C:\\proj\\LICENSE')
    expect(note).toContain('没有扩展名')
    expect(note).toContain('read_file')
  })
})
