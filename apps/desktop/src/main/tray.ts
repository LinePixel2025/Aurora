/**
 * 托盘（docs/02 §2.2、docs/07 §2）：常驻入口 + 模式切换 + 设置 / 引导 / 退出。
 */
import { existsSync } from 'node:fs'
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { MODE_IDS, type Logger, type ModeId } from '@aurora/shared'
import type { DesktopDeps } from './ipc.js'

export interface TrayController {
  refresh(): void
  destroy(): void
  setTooltip(text: string): void
}

export function createTray(deps: DesktopDeps, iconPath: string): TrayController {
  const image = loadIcon(iconPath)
  const tray = new Tray(image)
  tray.setToolTip('Aurora')

  const onModeClick = (id: ModeId): void => {
    void deps.modes.setCurrent(id).then((result) => {
      if (!result.ok) {
        deps.logger.warn('托盘切换模式失败', { mode: id, message: result.message })
        return
      }
      if (result.guideRequired) {
        deps.modes.requestGuideIfNeeded(id, 'tray-switch')
        deps.windows.showChat()
      }
    })
  }

  const buildMenu = (): Menu => {
    const settings = deps.settings.get()
    const modes = deps.modes.list()
    const current = modes.find((mode) => mode.active)
    const needsModel = deps.settings.needsOnboarding()

    const template: MenuItemConstructorOptions[] = [
      {
        label: deps.windows.getState().visible['service-dock']
          ? '隐藏 AI 服务窗'
          : '显示 AI 服务窗',
        click: () => {
          deps.windows.toggle('service-dock')
          refresh()
        },
      },
      { label: '打开对话窗口', click: () => deps.windows.showChat() },
      { type: 'separator' },
      {
        label: '切换到模式',
        submenu: MODE_IDS.map((id) => {
          const summary = modes.find((mode) => mode.id === id)
          return {
            label: `${summary?.displayName ?? id}${summary?.guideCompleted ? '' : '（待引导）'}`,
            type: 'radio' as const,
            checked: settings.modes.current === id,
            click: () => onModeClick(id),
          }
        }),
      },
      {
        label: '重新引导当前模式',
        click: () => {
          if (current) {
            deps.modes.resetGuide(current.id)
            deps.guides.reset(current.id)
            deps.windows.showChat()
          }
        },
      },
      { type: 'separator' },
      { label: '设置…', click: () => deps.windows.show('settings') },
      {
        label: '首次引导向导',
        click: () => {
          deps.windows.show('onboarding')
        },
      },
      { type: 'separator' },
      {
        label: needsModel ? '状态：未配置 AI 模型' : `状态：${current?.displayName ?? '未知模式'}`,
        enabled: false,
      },
      { label: '打开日志目录', click: () => deps.windows.show('settings') },
      { label: '退出 Aurora', click: () => deps.onQuit() },
    ]

    return Menu.buildFromTemplate(template)
  }

  const refresh = (): void => {
    try {
      tray.setContextMenu(buildMenu())
      const current = deps.modes.list().find((mode) => mode.active)
      tray.setToolTip(
        `Aurora · ${current?.displayName ?? '未激活'}${deps.settings.needsOnboarding() ? ' · 未配置模型' : ''}`,
      )
    } catch (error) {
      deps.logger.warn('刷新托盘菜单失败', { error: String(error) })
    }
  }

  tray.on('click', () => {
    deps.windows.toggle('service-dock')
    refresh()
  })

  refresh()

  return {
    refresh,
    setTooltip: (text) => tray.setToolTip(text),
    destroy: () => {
      tray.destroy()
    },
  }
}

function loadIcon(iconPath: string): Electron.NativeImage {
  if (existsSync(iconPath)) {
    const image = nativeImage.createFromPath(iconPath)
    if (!image.isEmpty()) return image
  }
  // 兜底：程序化生成 16×16 的极光绿圆点，避免因图标缺失导致托盘不可见
  return nativeImage.createFromDataURL(FALLBACK_ICON_DATA_URL)
}

/** 16×16 PNG（极光绿圆点），仅作为图标缺失时的兜底 */
const FALLBACK_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAgUlEQVR42mNgYGD4z0AswKanp/8HKmIkVjEjKZoZSdXMSKxmRlI0M5KimZFYzYzEamYkVjMjsZoZSdHMSKxmRmI1M5KimZFYzYzEamYkRTMjsZoZidXMSIpmRmI1MxKrmZEUzYzEamYkVjMjKZoZidXMSKxmAABpLQ0B8O1TYQAAAABJRU5ErkJggg=='

export type { Logger }
