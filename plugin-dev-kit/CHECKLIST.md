# 插件提交前检查清单

## 清单

- [ ] `manifest.json` 在包根，≤ 64 KB，JSON 合法
- [ ] `id` 反向域名、全小写、≤ 40；`version` 为 `x.y.z`；`apiVersion: 1`
- [ ] `permissions` 覆盖所有贡献，且没有多余权限
- [ ] `main` 入口存在且在包内
- [ ] 工具 ≤ 32，名称合法，最终名 `plugin.<id>.<name>` ≤ 64，参数是 `type: "object"`
- [ ] 面板 ≤ 8，`schema` / `entry` 二选一，引用文件存在
- [ ] 小组件 ≤ 4，`slot` 正确；提示条只有 `schema`、没有 `defaultSize`
- [ ] 桌面小组件若声明窗口层级 / 材质：`windowLevel` 取 `floating`（默认）/ `normal` / `desktop`，
      `windowMaterial` 取 `none`（默认）/ `acrylic`；提示条不得声明非默认值
- [ ] `hideCloseButton` 必须是布尔值；提示条不得声明 `true`
- [ ] 用到 `windowLevel` / `windowMaterial` / `hideCloseButton` 时，`minAuroraVersion` 已设为支持它们的宿主版本
- [ ] 图标在 `PLUGIN_PANEL_ICONS` 白名单内（否则回落 `Puzzle`）
- [ ] 所有路径都是包内相对路径，没有 `..`、盘符、UNC、绝对路径

## 声明式界面

- [ ] 只用白名单节点；`image.src` 是包内相对路径
- [ ] 节点 ≤ 500、深度 ≤ 20、整份 JSON ≤ 256 KB
- [ ] `select.options` 非空；`table.columns` 非空
- [ ] 按钮 `action.method` 在处理器里真的实现了
- [ ] 输入控件 `bind` 的值从 `params.values[bind]` 读取

## 运行期

- [ ] 工具返回 `{ content, isError?, summary? }`，content 只有文本且 ≤ 100 KB
- [ ] 长任务监听 `ctx.signal`；超时由清单 `timeoutMs` 或宿主默认兜底
- [ ] 存储键合法（`[a-zA-Z0-9_.:-]{1,128}`），单值 ≤ 256 KB、总量 ≤ 5 MB
- [ ] 网络只经 `ctx.net.fetch`；私网访问同时声明 `net.private`
- [ ] 推送目标都在清单内；事件名合法；payload ≤ 64 KB；频率 ≤ 20/s
- [ ] `invokePanel` / `invokeWidget` 处理 `method === 'event'` 并返回新 schema
- [ ] 页面只有 `window.auroraPlugin`，无内联脚本 / 外部 CDN / `fetch`

## 安全与文案

- [ ] 不读取 / 外发 Aurora 凭据与用户文件
- [ ] 有副作用的动作走 confirm（工具默认；按钮可用 `action.confirm`）
- [ ] README / 安装说明写明：插件不是 OS 沙箱，安装即信任
- [ ] 没有宣称「沙箱隔离」「不会访问文件系统」等不实描述

## 验证

- [ ] `node <工具包>/tools/check-plugin.mjs <插件目录>` 退出码 0
- [ ] （在 Aurora 源码环境）`node scripts/verify-plugin.mjs <目录|zip>` 通过
- [ ] 真机安装：设置 → 插件 → 开发 / 安装插件包，状态为「运行中」
- [ ] 面板、桌面小组件、提示条小组件、推送刷新各试一次；声明了层级 / 毛玻璃的 widget 在真机确认实际表现
- [ ] 停用 / 卸载后对应小组件窗口与面板正确关闭
