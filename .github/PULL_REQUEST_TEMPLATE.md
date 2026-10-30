## 变更内容

<!-- 一句话说明改了什么、为什么改；对应文档章节与 commit 列表 -->

## 高风险类别（至少勾一项）

- [ ] 配置 Schema 迁移（`CONFIG_VERSION` / `config/schema.ts` / `migrations.ts`）
- [ ] IPC 契约（`packages/shared/src/ipc/channels.ts` / `apps/desktop/src/preload/channels.ts`）
- [ ] 两端共享渲染资产（`packages/shared/src/browser/**`）
- [ ] 发布流程（`scripts/release*.mjs` / `electron-builder.yml` / `.github/workflows/**` / `docs/09`）

## 自审清单

- [ ] 文档先行：受影响文档已同步（08 §1 / 02 / 07 / 09 等）
- [ ] 配置迁移：`pnpm verify` 通过（`v0 → 当前版本` 迁移条数符合预期）
- [ ] IPC：shared 与 preload 两侧通道均已同步，`pnpm typecheck` 双向断言通过
- [ ] shared/browser：桌面与 Center Web 两端截图 / `verify:web` 都跑过（附结果）
- [ ] 本地全量：`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿
- [ ] 冒烟：`AURORA_SMOKE=1 pnpm dev` 断言全绿（当前基线 266/266；不适用的写明原因）
- [ ] 回滚：单个功能一个 commit，本 PR 整体 revert 不夹带无关改动

## 验证记录

<!-- 命令、结果或截图路径；失败项与原因 -->

## 合并方式

squash 合并并删除分支：`gh pr merge --squash --delete-branch`
