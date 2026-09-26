#!/usr/bin/env node
/**
 * `aurora-center` 启动器：定位编译产物 `dist/cli.js` 并执行 `runCli`。
 * 全局安装（npm i -g）与工作区内直接 node 运行都适用。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const candidate = join(here, '..', 'dist', 'cli.js')

if (!existsSync(candidate)) {
  process.stderr.write('找不到 dist/cli.js —— 请先在包根目录执行构建（pnpm build）。\n')
  process.exit(1)
}

const { runCli } = await import(pathToFileURL(candidate).href)
runCli({ argv: process.argv.slice(2) }).then((code) => process.exit(code))
