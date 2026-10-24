# Aurora 插件模板

最小可用插件：清单 + 一个 `ping` 工具。复制本目录到仓库外即可开始开发。

## 三步开始

1. 改 `manifest.json`：`id`（反向域名、全小写）、`name`、`version`、`description`；
2. 改 `main.js` 的 `invokeTool`（工具名与清单一致，不带 `plugin.` 前缀）；
3. 在 Aurora「设置 → 插件 → 开发」把这个目录加入开发目录 —— 改文件会自动重启。

## 校验与打包

```bash
# 在 Aurora 仓库根目录（需先 pnpm build:packages）
node scripts/verify-plugin.mjs examples/plugins/_template

# 打包（Windows PowerShell；zip 根目录必须直接是 manifest.json）
cd examples/plugins/_template
Compress-Archive -Path manifest.json,main.js,types -DestinationPath hello-plugin.zip -Force
```

打包后在「设置 → 插件 → 已安装」用「安装插件包」选择 zip 即可。

## 目录

```
manifest.json              清单：贡献与权限（唯一事实来源）
main.js                    处理器：activate / invokeTool / …（全部可选）
types/aurora-plugin.d.ts   契约类型（编辑器补全用）
```

完整字段、权限表、面板 schema 与页面 RPC 见 `docs/15-plugin-development-guide.md`。

插件以你的用户权限运行，安装即信任；只安装可信来源的插件。
