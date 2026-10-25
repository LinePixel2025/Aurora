/**
 * 页面型插件面板的托管支持（docs/12 §6.5）。
 *
 * 页面来自**已发布到本 Center 的市场包**（服务器解压后按需读文件），跑在
 * `sandbox="allow-scripts"` 的 iframe 里：opaque origin、无 Node、无父页访问、
 * `connect-src 'none'`。页面唯一的外联通道是注入的 `window.auroraPlugin`
 * （`postMessage` → 父页 `PluginPageFrame` → `plugin.panelData`）。
 *
 * 这里的两个纯函数分别负责：把桥注入 HTML（脚本必须先于页面自己的脚本执行）、
 * 构造 CSP（sandbox 文档里 `'self'` 不可靠，因此显式放行请求 Host 的 http/https 源）。
 */

import { CENTER_PLUGIN_PAGE_HOST_SOURCE, CENTER_PLUGIN_PAGE_SOURCE } from '@aurora/shared'

/** 页面与父页的 postMessage 标识（定义在 shared，网页端 `PluginPageFrame` 用同一份） */
export const PLUGIN_PAGE_SOURCE = CENTER_PLUGIN_PAGE_SOURCE
export const PLUGIN_PAGE_HOST_SOURCE = CENTER_PLUGIN_PAGE_HOST_SOURCE

/**
 * 注入给页面的桥：与桌面 preload 的 `window.auroraPlugin` 同形
 * （`request(method, params)` / `onEvent(listener)`），底层走 postMessage。
 */
export const PLUGIN_PAGE_SHIM = `(function () {
  var PAGE_SOURCE = '${PLUGIN_PAGE_SOURCE}'
  var HOST_SOURCE = '${PLUGIN_PAGE_HOST_SOURCE}'
  var sequence = 0
  var pending = new Map()
  var listeners = []
  function post(message) {
    try { window.parent.postMessage(message, '*') } catch (error) { /* 父页已销毁 */ }
  }
  window.auroraPlugin = {
    request: function (method, params) {
      if (typeof method !== 'string' || method === '' || method.length > 64) {
        return Promise.reject(new Error('method 必须是 1–64 字符的字符串'))
      }
      var id = 'p' + (++sequence)
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject })
        post({ source: PAGE_SOURCE, kind: 'request', id: id, method: method, params: params })
      })
    },
    onEvent: function (listener) {
      if (typeof listener !== 'function') return function () {}
      listeners.push(listener)
      return function () {
        var index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    }
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || typeof data !== 'object' || data.source !== HOST_SOURCE) return
    if (data.kind === 'response') {
      var call = pending.get(data.id)
      if (!call) return
      pending.delete(data.id)
      if (data.ok === true) call.resolve(data.result)
      else call.reject(new Error(typeof data.error === 'string' ? data.error : '插件请求失败'))
      return
    }
    if (data.kind === 'event' && typeof data.event === 'string') {
      for (var i = 0; i < listeners.length; i += 1) {
        try { listeners[i](data.event, data.payload) } catch (error) { /* 页面自己的回调异常 */ }
      }
    }
  })
})()`

const SHIM_TAG = `<script>${PLUGIN_PAGE_SHIM}</script>`

/**
 * 把桥插到 `<head>` 开头（页面自己的脚本之前）。没有 head 时退到 `<html>` 之后，
 * 再没有就前置 —— 三种情况都保证桥先于页面脚本定义。
 */
export function injectPluginPageBridge(html: string): string {
  const head = /<head[^>]*>/i.exec(html)
  if (head !== null) {
    const at = head.index + head[0].length
    return `${html.slice(0, at)}${SHIM_TAG}${html.slice(at)}`
  }
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag !== null) {
    const at = htmlTag.index + htmlTag[0].length
    return `${html.slice(0, at)}${SHIM_TAG}${html.slice(at)}`
  }
  return `${SHIM_TAG}${html}`
}

/**
 * 请求 Host 净化：只允许域名 / IPv4 / IPv6 字面量与端口。
 * 非法值回落 `localhost`（CSP 会变得只放行 localhost，页面资源被拦 —— 但不会注入任意源）。
 */
export function sanitizeRequestHost(raw: string | undefined): string {
  const host = (raw ?? '').trim()
  if (host === '' || host.length > 255) return 'localhost'
  return /^[a-zA-Z0-9.\-:[\]]+$/.test(host) ? host : 'localhost'
}

/**
 * 页面 CSP：
 * - `sandbox allow-scripts`：opaque origin（无 `allow-same-origin`），脚本仍可跑；
 * - `script-src` / `style-src` 显式放行请求 Host 的 http/https 源（sandbox 下 `'self'` 不可靠）；
 * - `connect-src 'none'`：页面不能自己发网络请求，只能经桥回 Center；
 * - `form-action` / `base-uri` 关死，`frame-ancestors` 只认本 Center。
 */
export function pluginPageCsp(host: string): string {
  const origins = `http://${host} https://${host}`
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${origins}`,
    `style-src 'unsafe-inline' ${origins}`,
    `img-src ${origins} data:`,
    `font-src ${origins} data:`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${origins}`,
    'sandbox allow-scripts',
  ].join('; ')
}
