# 安全策略

Aurora 是一款**系统级**桌面 Agent：它能读文件、跑命令、操作 Office、开浏览器、执行自动化和
Computer Use，凭据保存在本机。因此安全问题会被严肃对待，也请**不要**在公开 Issue 中披露细节。

---

## 支持版本

| 版本 | 支持状态 |
|---|---|
| 最新发布版（当前 `0.6.x`） | ✅ 接受报告并修复 |
| 更早的次版本 / 预发布版 | ❌ 请先升级到最新版再确认问题 |

只维护最新的桌面发行线；Aurora Center 的版本线独立，见 [docs/12](./docs/12-aurora-center.md)。

---

## 报告漏洞

**优先使用 GitHub 的私密漏洞报告**：

<https://github.com/LinePixel2025/Aurora/security/advisories/new>

如果该入口不可用，也可以私信仓库维护者 [@LinePixel2025](https://github.com/LinePixel2025)，
或通过其 GitHub 主页上的公开联系方式联系。**不要**先开公开 Issue。

为了尽快定位，请在报告中尽量包含：

- Aurora 版本（设置页或安装包名）、Windows 版本、是否启用只读档 / Computer Use
- 受影响的子系统（Agent 内核 / IPC / 文件工具 / 插件 / Aurora Center / 更新链路 …）
- 复现步骤或最小 PoC，以及实际影响（数据泄露、任意命令执行、权限绕过 …）
- 是否已在别处公开、是否希望匿名致谢

**响应预期**（单人维护，尽力而为）：

- 7 天内确认收到并给出初判
- 初步定性后 30 天内给出修复计划或缓解建议
- 修复随常规发布上线，并在 release notes 中致谢（除非你要求匿名）

---

## 在范围内

- **凭据与隐私**：`safeStorage` 加密、`config.json` 密文字段、`settings:get` / `settings:changed`
  只回传标记、日志与「导出脱敏配置」的脱敏完整性
- **进程边界**：preload 白名单、`contextIsolation` / `sandbox`、IPC 参数校验、跨 IPC 的 Proxy 克隆问题
- **文件与命令**：项目根边界（realpath 前缀校验）、写前快照、`edit_file` 改前必读守卫、
  MCP 以 argv 数组启动不经 shell、`sensitivity: 'confirm'` 的确认链路
- **插件系统**：清单权限、`plugin.<id>.<name>` 命名、页面型插件沙箱（`aurora-plugin://`）、
  面板 / 小组件事件推送的主进程校验、Center 上插件面板的属主校验
- **Computer Use**：三层门控（注册 / 请求 / 执行）、受保护目标（Aurora 自身 / 终端 / 任务管理器 / UAC / 锁屏）、
  坐标与命中测试
- **Aurora Center**：认证与令牌、远程会话授权、`ownerUserId` 隔离、上传校验、CSP 与静态托管
- **更新链路**：`latest.yml` / blockmap / sha512 一致性、更新源回退顺序、双投

## 不在范围内

- 未签名安装包触发的 Windows SmartScreen / 杀软误报（项目当前不购买代码签名证书，见 [docs/09](./docs/09-packaging-release.md)）
- 用户自行配置的模型服务商、MCP 服务器、插件与 Skill 脚本的行为（**安装即信任**）
- 需要本机管理员权限或物理接触的攻击，以及社会工程
- 仅影响已停止维护版本的缺陷
- 依赖项自身已公开披露、且仓库尚未升级的问题（欢迎顺带提一个依赖升级 PR）

---

## 用户侧加固建议

- 只安装来自 [Releases](https://github.com/LinePixel2025/Aurora/releases) 或你自建 Aurora Center 的安装包
- 只安装你审查过源码的插件；插件进程不是 OS 沙箱
- API Key 交给系统安全存储；不要把 `config.json` 或 `logs/` 提交到任何仓库
- 高风险场景使用只读档，Computer Use 用完即停
- 保持自动更新开启，或定期手动升级到最新版

---

## 披露政策

- 修复发布前不公开细节；修复发布后可在报告中致谢（默认匿名）。
- 不提供漏洞赏金，但会明确记录你的贡献。
