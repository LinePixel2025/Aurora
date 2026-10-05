---
date: 2026-10-03
title: 工具权限档与项目根边界的真实语义（两层判定 + 会话级唯一口径）
tags: [权限, 安全, 工具, 坑]
source: 模型自动记录
---

# 工具权限档与项目根边界

## 现象

1. `agent.permissionMode` 有三档 `readonly` / `confirm` / `auto`（**默认 `auto` = 完全权限**，
   2026-09-29 起出厂档；镜像的老开关 `advanced.confirmSensitiveTools` 出厂同为 `false`）。
2. **项目根边界分两层**，两层判据不同：
   - `confirm` 档"**要不要弹卡**"用**字符串级判定**（含 `..` 段的、取不到目标路径的工具一律按越界）；
   - "**能不能真碰**"由主进程对**已存在的最近父目录**做 realpath 前缀校验
     （`file-port.resolveWithin`，越界即 `E_PATH_OUTSIDE_WORKSPACE`，六个文件类入口与 `run_command.cwd` 都走它）。
3. `agent.tools.workspaceDir` 常被当成安全边界，实际只是"默认 cwd / 搜索根"。
4. 确认判定曾是"逃逸"的来源：机器放行也会置位 `approvedByUser`。

## 原因

- 设计目标是"减少打扰 + 挡住越界"，不是 OS 级隔离：`confirm` 档在**当前项目根之内**写文件免确认、
  越界仍逐次确认；`auto` 完全权限档不再弹卡；`readonly` 档**不注册**写入 / 执行类工具
  （含 `todo_write`，保留 `todo_read`）。
- 缺省工作目录 / 搜索根的回落链是 docs/06 §5.1 的 `effectiveWorkspaceDir`，**工具执行链的唯一口径**：
   当前项目根（配置了当前项目时）> `agent.tools.workspaceDir` > 用户主目录。
- 会话级项目的唯一解析口径在 `apps/desktop/src/main/tools/session-project.ts` 的
  `createSessionProjectResolver`，回落链是：**会话绑定项目（`SessionMeta.projectId`）>
  会话空间目录（Agent → `桌面\Aurora`，Work → 模式工作目录）> 激活模式目录 >
  `agent.tools.workspaceDir` > 主目录**（全局 `projects.current` 一级已于 v25 **整体退役**）。

## 影响

- 把 `workspaceDir` 当护栏、把 `openPath` 的 `kind: 'workspace'` 当成项目根，都是错的；
  按"每客户端/每项目"的直觉理解边界，会写出错误的判据与错误的"修复"。
- 在执行链上另写一套项目根解析，会让工具缺省 cwd、file-port 边界、`confirmTool` 的免确认分支三者不一致。
- 把这两层说成"沙箱"是错的：**没有作业对象 / 容器 / 受限令牌**，`run_command` 仍是当前用户权限。

## 结论与做法

- **只有配置了当前项目时这条边界才生效**：无项目时行为与 v12 之前完全一致；真正的安全边界是
  **「当前项目根」**，`workspaceDir` 不是。
- `readonly` / `confirm` / `auto` 的既有放宽（v0.2.4，Codex 式，docs/06 §11.2）别再改回去：
  `center_send_file` **直接发送不逐次确认**（闸门在配置层 `center.enabled` / `allowFileTransfer` / `maxFileMb`），
  `confirm` 档下 `write_file` / `edit_file` 落在会话边界根内**免确认**（`run_command` 等仍逐次）。
- 确认判定是四态 decision，`approvedByUser` **仅当用户当次卡片批准 / 首次「总是允许」置位**，
  机器放行不置位；realpath 兜底保留（根内链接指向根外时，在机器放行路径下被 realpath 拒绝且不弹卡）。
- 工具缺省 cwd / 搜索根、file-port 边界、`confirmTool` 的 confirm 档根内免确认、
  AGENTS.md 指令注入**全部按会话现解析**（getter 注入，同 `agent.loop` 上限套路）——
  **不要在执行链上再写第二套项目根解析**。
- 会话项目是**会话数据**：别塞回全局设置或 CONFIG_VERSION 迁移链；也**别把「当前项目」当回落位或入口加回来**
  （字段随 v24→v25 删除、设置页「设为当前」与左栏「当前」徽标已删、`openPath kind:'project'` 已删）。
- 设置页「打开工作目录」（`openPath kind:'workspace'`）已接同一条链，解析抽在
  `apps/desktop/src/main/tools/workspace-target.ts` 纯函数里；配了项目时打开项目根，与命令缺省落地目录一致。
- Work 模式 systemPrompt 描述的就是这条链（docs/05 §4.1），**别在提示词里另立「工作目录」口径**。
- **子代理（`task`，docs/06 §19.2）**：工具执行链的取值经 `adaptForSubagent` 视图 ——
  缺省 cwd / 搜索根 / 边界根用 `parentSessionIdOf` 把 `-sub` 剥回**父会话**再解析（2026-10-02 修复：
  此前恒落 Agent 空间）；todo 清单等状态隔离仍按 `-sub`，别整体换 id。

## 2026-10-05 更新：完全权限不再弹卡

- `auto`（界面名「完全权限」）从「根内免确认、越界弹卡」改成**真正完全权限**：
  `createConfirmTool` 在 readonly 检查后立即返回 `true`，不解析项目根、不访问
  `ProactiveScheduler`，也不再受 `absolute path` 启发式分流影响。
- 返回 `true` 的原因是内核会把 `ctx.approvedByUser` 透成端口层 `allowOutside`；这样
  `auto` 下项目根外也能执行。若仍返回 `'machine'`，只会“不弹卡但执行被 realpath 拒绝”，
  不是完全权限。`'machine'` 继续只代表 `allowPatterns` / 已记住 `'always'` 的历史机器放行。
- 项目根仍然决定缺省 cwd / 搜索根，并继续服务 `confirm` 档的「根内免确认」；realpath
  兜底只对未获用户批准的 `confirm` / machine 路径继续生效。
- UI、docs/06 §11.2、docs/08、smoke 2.3 必须保持同一口径：完全权限 = 不弹卡；
  confirm 档 = 旧 auto 语义：无项目直接放行；有项目时根内免卡、越界仍问；命令含绝对路径回卡。
