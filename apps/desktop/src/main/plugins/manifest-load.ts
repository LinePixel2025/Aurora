/**
 * 插件目录的清单加载与路径校验（docs/14 §3、docs/15 §3）。
 *
 * 安装器、开发目录扫描与「安装前预览」都走这里：清单解析只有一份口径，
 * 所有声明路径（main / skills / panels / icon）都必须落在插件根内。
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  isManifestTooLarge,
  parsePluginManifest,
  satisfiesMinVersion,
  type PluginManifest,
} from '@aurora/shared'

export interface LoadedPlugin {
  manifest: PluginManifest
  root: string
  manifestPath: string
  isDev: boolean
}

export interface ManifestLoadResult {
  ok: boolean
  plugin?: LoadedPlugin
  errors: string[]
  warnings: string[]
}

/** 相对路径 → 绝对路径；越出插件根时返回 null。 */
export function resolvePluginPath(root: string, relativePath: string): string | null {
  const base = resolve(root)
  const target = resolve(base, relativePath)
  const rel = relative(base, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return target
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 读取并校验一个插件目录。
 * `hostVersion` 用于 `minAuroraVersion`；`isDev` 只影响返回对象上的来源标记。
 */
export async function readPluginManifest(
  root: string,
  options: { hostVersion: string; isDev: boolean },
): Promise<ManifestLoadResult> {
  const errors: string[] = []
  const warnings: string[] = []
  const manifestPath = join(root, 'manifest.json')

  let raw: string
  try {
    const stat = await fs.stat(manifestPath)
    if (!stat.isFile()) {
      return { ok: false, errors: ['manifest.json 不是文件'], warnings }
    }
    if (isManifestTooLarge(stat.size)) {
      return { ok: false, errors: ['manifest.json 超过 64 KB'], warnings }
    }
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch {
    return { ok: false, errors: ['插件根缺少 manifest.json'], warnings }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return { ok: false, errors: [`manifest.json 不是合法 JSON：${String(error)}`], warnings }
  }

  const parsed = parsePluginManifest(json)
  if (!parsed.ok || parsed.manifest === undefined) {
    return { ok: false, errors: parsed.errors, warnings }
  }
  const manifest = parsed.manifest

  if (manifest.minAuroraVersion !== undefined) {
    if (!satisfiesMinVersion(options.hostVersion, manifest.minAuroraVersion)) {
      errors.push(
        `插件要求 Aurora ≥ ${manifest.minAuroraVersion}，当前版本为 ${options.hostVersion}`,
      )
    }
  }

  const mainPath = resolvePluginPath(root, manifest.main)
  if (mainPath === null) {
    errors.push(`main 路径越出插件根：${manifest.main}`)
  } else if (!(await exists(mainPath))) {
    errors.push(`main 入口不存在：${manifest.main}`)
  }

  for (const skillDir of manifest.contributes.skills) {
    const absolute = resolvePluginPath(root, skillDir)
    if (absolute === null) {
      errors.push(`Skill 目录越出插件根：${skillDir}`)
      continue
    }
    if (!(await isDirectory(absolute))) {
      errors.push(`Skill 目录不存在：${skillDir}`)
      continue
    }
    if (!(await exists(join(absolute, 'SKILL.md')))) {
      errors.push(`Skill 目录缺少 SKILL.md：${skillDir}`)
    }
  }

  for (const panel of manifest.contributes.panels) {
    const file = panel.schema ?? panel.entry
    if (file === undefined) continue
    const absolute = resolvePluginPath(root, file)
    if (absolute === null) {
      errors.push(`面板「${panel.id}」文件越出插件根：${file}`)
    } else if (!(await exists(absolute))) {
      errors.push(`面板「${panel.id}」文件不存在：${file}`)
    }
  }

  if (manifest.icon !== undefined) {
    const icon = resolvePluginPath(root, manifest.icon)
    if (icon === null) errors.push(`icon 路径越出插件根：${manifest.icon}`)
    else if (!(await exists(icon))) warnings.push(`icon 不存在：${manifest.icon}`)
  }

  if (errors.length > 0) return { ok: false, errors, warnings }
  return { ok: true, plugin: { manifest, root, manifestPath, isDev: options.isDev }, errors, warnings }
}
