/**
 * @aurora/center —— Aurora Center 服务器公共入口（docs/12）。
 *
 * CLI（`aurora-center`）入口在 `cli.js`（bin 指向 `bin/aurora-center.js` 启动器）；
 * 这里导出可编程使用面：服务器装配、鉴权 / 客户端 / 文件存储与版本检查。
 */
export { createCenterServer, type CenterServerOptions, type RunningCenterServer } from './server.js'
export {
  AuthStore,
  AuthError,
  hashToken,
  type UserRecord,
  type UserRole,
  type ClientTokenView,
} from './auth.js'
export {
  DeviceAuthStore,
  DEVICE_CHALLENGE_TTL_MS,
  DEVICE_POLL_INTERVAL_MS,
  formatUserCode,
} from './device.js'
export { ClientRegistry, type ClientRecord } from './clients.js'
export {
  FILE_TTL_MS,
  FILE_PRUNE_INTERVAL_MS,
  FileStore,
  FileTooLargeError,
  type FileRecord,
} from './files.js'
export { Hub, type HubDeps, type ClientConn, type WebConn } from './hub.js'
export { JsonStore } from './store.js'
export { createSecretBox, type SecretBox } from './secrets.js'
export {
  ModelServicesStore,
  type ModelServicesStoreOptions,
  type ResolvedOfficialService,
} from './model-services.js'
export { UsageStore, type UsageRecordInput, type UsageStoreOptions } from './usage.js'
export { ReleaseStore, type ReleaseStoreOptions } from './releases.js'
export { ModelGateway, type ModelGatewayOptions } from './model-gateway.js'
export { checkUpdate, compareVersions, type UpdateCheckResult } from './update.js'
export { serverVersion } from './version.js'
export { DEFAULT_DATA_DIR, runCli } from './cli.js'
