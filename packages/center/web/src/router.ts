/**
 * Aurora Center Web —— 极简 hash 路由（docs/12 §10）。
 *
 * 为什么不用 vue-router：SPA 只有 6 个页面、无嵌套路由、无参数（`#/device?code=` 自己解析
 * query），而 `base: './'` + hash 路由可以让服务器**静态托管 dist-web**、不需要 history fallback。
 */
import { ref } from 'vue'

export type RouteName =
  | 'home'
  | 'login'
  | 'console'
  | 'usage'
  | 'admin'
  | 'files'
  | 'automations'
  | 'device'
  | 'marketplace'
  | 'pluginsAdmin'

export interface Route {
  name: RouteName
  /** `#/device?code=ABCD-1234` 的 query（其余路由为空串） */
  query: URLSearchParams
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const [path = '', search = ''] = raw.split('?')
  const name = (path.split('/')[0] || 'home') as RouteName
  const known: RouteName[] = [
    'home',
    'login',
    'console',
    'usage',
    'admin',
    'files',
    'automations',
    'device',
    'marketplace',
    'pluginsAdmin',
  ]
  return {
    name: known.includes(name) ? name : 'home',
    query: new URLSearchParams(search),
  }
}

export const route = ref<Route>(parse())

window.addEventListener('hashchange', () => {
  route.value = parse()
  // 换页时把滚动位置归零（会话流自身保持吸底，不受影响）
  window.scrollTo(0, 0)
})

export function navigate(name: RouteName, query?: Record<string, string>): void {
  const search = query ? `?${new URLSearchParams(query).toString()}` : ''
  window.location.hash = `#/${name}${search}`
}
