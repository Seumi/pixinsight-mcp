# pi-pixinsight（MVP）

面向 **pi coding agent 0.87.1+** 的 PixInsight 适配包，不是另一个聊天程序。源码仓库为 [Seumi/pixinsight-mcp](https://github.com/Seumi/pixinsight-mcp)，上游为 [pardovot/pixinsight-mcp](https://github.com/pardovot/pixinsight-mcp)。复用 MCP server / 原生 Watcher，增加 pi 工具、工作区缓存、确认对话框、图像结果和不确定操作恢复锁。

## 安装 pi 侧

需要 Node 22+。先在仓库根目录安装并构建本地 server（不要换成未经核对的全局 npm server，本分支包含预览安全修复）：

```text
git clone https://github.com/Seumi/pixinsight-mcp.git
cd pixinsight-mcp
npm ci --ignore-scripts
npm run build
cd integrations/pi-agent
npm ci --ignore-scripts
npm run check
npm test
npm run smoke
pi install .
```

已有 pi 会话运行 `/reload`；新会话直接可用。也可不安装，只试一次：

```text
pi --extension ./src/extension.ts --skill ./skills/pixinsight
```

包安装只修改 pi coding agent 的资源配置；不安装 PI 原生模块、不重启 PixInsight、不修改图像。卸载使用 `pi remove <本目录绝对路径>`。

## 安装 PixInsight 侧（需要用户操作）

先保存自己的工作。PixInsight 中：

1. `Resources > Updates > Manage Repositories` 添加上游仓库：
   `https://raw.githubusercontent.com/pardovot/pixinsight-mcp/dist/`
2. `Resources > Updates > Check for Updates`，核对发布者和签名后安装、重启。
3. `Process > Utilities > MCP Watcher > Start`。
4. 回到 pi：`/pixinsight status`。检查 heartbeat.live，而不只是 mcpConnected。

以上更新地址仍是**上游**签名模块，不是本 fork 自己的发布源。`Seumi/pixinsight-mcp` 当前用于源码与适配器开发，尚未发布自己的 `dist/updates.xri`；不能直接替换 URL 的账号名。自有模块发布需要自己的 PixInsight 签名身份及配置，见仓库根目录 `docs/RELEASING.md`。

这些是第三方原生模块，拥有 PI 进程权限。此适配包不代表对其全部代码的安全审计。版本不兼容须按上游指引升级，不能绕过 handler revision 检查。

## 使用

```text
/pixinsight status
/pixinsight watch on
看看我当前 PixInsight 工作区有什么，先不要处理。
分析主视图 Light_RGB 的统计，必要时请求查看预览。
/pixinsight writes on
在我已创建的 Light_RGB_copy 上尝试拉伸，先查询参数并给出解释。
/pixinsight writes off
/pixinsight watch off
```

工具：

| pi 工具 | 功能 |
|---|---|
| pixinsight_status | MCP 连接、固定实例、heartbeat、写锁 |
| pixinsight_workspace | 当前视图、尺寸、STF、蒙版、历史索引 |
| pixinsight_inspect | 主视图信息和逐通道统计 |
| pixinsight_parameters | 安装的 Process 参数和默认值 |
| pixinsight_preview | 缩略图或裁剪图，确认后作为图片送给模型 |
| pixinsight_process | 白名单 Process、明确主视图、逐次确认 |

扩展内部会调用固定的只读 PJSR 工作区查询，但**不把任意脚本入口开放给模型**。不转发上游的关闭、保存、全局执行和实例切换工具。运行某 Process 前仍必须安装并授权对应插件。

## 安全与恢复边界

- 默认不能处理图像。`writes on` 只能由用户命令开启，当前会话有效，且每次弹框确认。print/JSON 无 UI 时拒绝写操作及图像上传。
- **当前版本直接处理指定目标，不自动创建副本/检查点。先手动在 PI 复制图像。** 不保证所有 Process 可撤销，也不保证只改变一个窗口。
- 预览 PNG 经单独确认后会进入 pi 会话，可能发送到云端模型；后台监视只采集元数据，没有隐式图像上传或后台模型请求。
- 工作区监视是默认 5 秒的低频轮询，不是原生事件推送。PI 忙时 heartbeat 可能过期；禁止把旧缓存当作实时数据。
- 每次写前重新检查目标描述，但 historyIndex **不是内容哈希/原子版本号**。跨其它客户端、手工操作的竞争不能完全排除；处理时不要同时修改该目标。
- 所有本适配器请求串行。写前使用跨会话的原子恢复锁，确认成功后才清除；错误、超时、取消会保留锁，后续处理被阻止。
- **取消等待只取消客户端请求，不会终止 PI 中的操作。** 上游超时也不保证撤回命令。禁止自动重试。先检查 PI 中任务已经结束/停止、结果状态和桥接 commands 队列，再由用户运行 `/pixinsight recover`；队列有 JSON 命令时拒绝解锁。不要盲目删除队列文件。
- 本包不是沙箱：pi 自带 bash、其它 MCP 客户端和对桥接目录的写权限仍能绕过这些护栏。桥接目录必须用户私有，不可共享/同步给其它用户。
- 上游统计工具会重置源图像的选区/通道选择；不改源像素。预览安全修复保留源选区，并避免关闭用户已有的 `mcp_render_tmp` 窗口。

## 配置

只读取启动 pi 时的环境变量；不读项目内任意 JSON，不执行模型指定的命令或 shell。默认锁定实例 1，不自动跳转到其它 PI 实例。

| 环境变量 | 默认 |
|---|---|
| PIXINSIGHT_MCP_SERVER | 本仓库 `build/index.js` 的绝对路径 |
| PIXINSIGHT_MCP_INSTANCE | `1` |
| PIXINSIGHT_MCP_BRIDGE_DIR | `~/.pixinsight-mcp/bridge`；实例 N>1 为 `bridge-N` |
| PIXINSIGHT_MCP_TIMEOUT_MS | `300000`；SDK 比它多等待 10 秒 |
| PIXINSIGHT_AGENT_WATCH_MS | `5000`，最少 `2000` |
| PIXINSIGHT_AGENT_STATE_DIR | `~/.pi/agent/pixinsight` |

自定义桥接目录须与原生模块配置一致。路径必须是绝对路径或 `~/...`。切换实例须停止监视并重启/重新加载扩展，避免在执行期间改路由。所有路径通过 Node 派生；macOS/Windows/Linux 共用代码。

本地状态目录内：`*.pending.json` 为未确认完成的操作，`operations.jsonl` 为操作日志，`artifacts/` 为图像和大输出。目录权限默认 0700，写入文件默认 0600（Windows ACL 仍需自行管理）。图像可能含敏感信息；产物不会自动清理，请在不用时自行删除。

## 验证

```text
npm run check
npm test
npm run smoke
npm run smoke -- --live
```

- 仓库根目录 `npm test` 仅运行 MCP / 模块测试；本目录 `npm test` 独立运行适配器测试，均不依赖另一套测试的开发依赖。
- 本目录 `test`：模拟协议、串行、确认、失败/取消、恢复锁、pi 工具注册和 SDK stdio 连接，不处理真实图像。
- `smoke`：对仓库真实 MCP server 做握手及工具发现，桥接目录隔离在临时目录，不投递图像处理命令。
- `smoke -- --live`：检查真实 heartbeat 并只读获取工作区；没有 Watcher 时退出失败。**只有这一步成功才代表真实连通**，它不验证真实图像处理效果。

暂未实现：完整元数据克隆、原生事件同步、可靠像素 revision、自动保存/恢复工作流、原生模块自动安装及全部 Process。不要把模拟测试通过当成这些能力已经可用。
