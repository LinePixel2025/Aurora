'use strict'

/**
 * 沙箱页面脚本（docs/15 §7）。
 *
 * 只有 `window.auroraPlugin`：`request(method, params)` 交给宿主中继到插件进程的
 * `invokePanel`，返回值是插件返回的 `{ schema?, toast?, data? }`。
 */

const countEl = document.getElementById('count')

async function refresh() {
  if (countEl === null) return
  countEl.textContent = '读取中…'
  try {
    const result = await window.auroraPlugin.request('status')
    const data = result && typeof result === 'object' ? result.data : undefined
    const count = data && typeof data.count === 'number' ? data.count : 0
    const greeting = data && typeof data.greeting === 'string' ? data.greeting : '你好'
    countEl.textContent = `计数：${count}（${greeting}）`
  } catch (error) {
    countEl.textContent = `请求失败：${error instanceof Error ? error.message : String(error)}`
  }
}

document.getElementById('refresh')?.addEventListener('click', () => {
  void refresh()
})

document.getElementById('toast')?.addEventListener('click', () => {
  void window.auroraPlugin.request('toast')
})

void refresh()
