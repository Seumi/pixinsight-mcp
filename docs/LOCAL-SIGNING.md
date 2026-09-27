# 本地签名与更新渠道

## 两个渠道不能混淆

| 分支 | 地址 | 来源与信任 |
|---|---|---|
| `dist-local` | `https://raw.githubusercontent.com/Seumi/pixinsight-mcp/dist-local/` | 自己的源码构建，由本地 PixInsight 身份签名；仅相应许可证且已配置本地身份的安装可使用 |
| `dist` | `https://raw.githubusercontent.com/Seumi/pixinsight-mcp/dist/` | 原样镜像上游已签名产物，签名发布者仍为 OfirPardo，不代表 Seumi 重新构建或签名 |

不要同时启用同一模块的多个更新源。`dist-local` 不是面向其他许可证用户的公开 CPD 发行。当前版本是 MCP Watcher **1.3.5**，只发布 macOS 通用二进制（arm64 + x86_64），使用 PixInsight 1.9.5 的 PCL 构建，更新范围为 1.9.5–1.9.99。编译和完整性检查不等于所有系统版本均已实机验证。

源码提交、分发提交及 SHA256 记录在 [distribution/local-release.json](../distribution/local-release.json)。上游镜像固定于 `ef4161b4fc6fa1711459f87f9392fb4fe8e14d47`，不会自动跟随上游重写的 `dist` 分支。

## 创建本地身份（PixInsight 1.9.5）

1. `Script > Development > SigningKeys`：选择 Generate Signing Keys，勾选 Local signing identity。
2. 将 `.xssk` 保存到 Git 仓库之外，并设置强密码。
3. `Edit > Local Signing Identity...`：选择该文件、输入密码，勾选 Make the local signing identity persistent。

该身份与 PixInsight 软件许可证绑定，不需要申请 CPD，但不会在其他许可证用户的机器上自动获得信任。公开发行需要独立申请相应的 CPD 身份，不能仅更改 developerId。

## 安全边界

- `.xssk` 包含加密的私钥；不要提交到 Git，不要发送给聊天模型。
- 密码只在 PixInsight 的对话框中输入，不放进命令行、脚本、环境变量或构建日志。
- 本地流程不运行 `module/export-signing-key.js`，不产生明文 `signing-key.json`，不向 GitHub Secrets 上传私钥。
- `.xsgn` 是可分发的公开签名，`updates.xri` 含嵌入式签名。它们会携带签名身份标识，但不是私钥。
- 本文是可选的本地人工签名流程，不替代原有 Node/CI 自动签名实现；后者仍见 [SIGNING.md](SIGNING.md)。不要为了使用本流程而导出解密密钥。

## 正确的构建、签名顺序

在仓库根目录：

```text
npm run module:pcl
npm run module:build
```

构建工具、跨平台环境和目录说明见 [dev-setup.md](dev-setup.md)。macOS 先完成两个架构的合并和系统层 ad-hoc codesign，再做 PixInsight 签名；之后不能再修改二进制。系统层 codesign 不等于 PixInsight 的 `.xsgn` 签名。

1. 用 `Script > Development > CodeSign` 签署 `module/build/MCPWatcher-pxm.dylib`，选择自己的 `.xssk` 并在 PI 中输入密码。其它平台对应 `.dll` / `.so`，须另行构建和验证。
2. 同目录应出现 `MCPWatcher-pxm.xsgn`。
3. 运行 `npm run repo:build`，生成 `pi-repo/`。
4. **签清单之前**完成自用发布元数据：注明本地签名范围、来源仓库和当前构建所用的 PI 最低版本。默认打包工具仍使用上游通用描述与版本范围，不会自动套用本次自用发布的定制文字。当前清单的最终内容可在 `dist-local` 分支查看。
5. 核对 ZIP 只包含目标模块和它的 `.xsgn`，与本机文件字节一致，清单中的包校验和正确。
6. 再开 CodeSign，清空上一批列表，**只签署 `pi-repo/updates.xri`**。这次签名写入 XML 自身，不会另生成 `.xsgn`。
7. 此后不要再编译、重签模块、打包或修改清单。任何改变都需要重新走后续打包/签名步骤。
8. 发布只允许清单与明确列出的 ZIP 文件；不要把工作区、密钥目录、构建目录或整个源码树当作分发目录上传。

本地签名文件从不会作为公开 CPD 认证的替代品。安装时必须由 PixInsight 验证签名；遇到错误请排查身份和产物，不要关闭签名验证。

## 当前发布验证范围

- 模块的两个 Mach-O 架构和系统签名已检查。
- 模块与清单的签名格式、同一签名身份、清单正文未变已检查。
- ZIP CRC、模块/签名字节、清单的 SHA1 和 HTTP 下载的 SHA256 已检查。
- 没有读取或导出私钥。没有在外部声称完成独立的签名密码学验证；最终信任判断属于目标 PixInsight。
- 还须在目标 PI 中安装、加载并查询工作区，才能确认端到端连通。

签名后的 XRI 含根元素及独立的顶层 Signature。检查正文规范化摘要时，应仅在内存中分离签名元素；**不要修改磁盘上的已签名文件**，也不要把只接受单根元素的解析器错误当成签名失效。

## 安装并连接

1. 保存工作区，确认本地签名身份已持久化。
2. `Resources > Updates > Manage Repositories` 添加 `dist-local` 地址。
3. 检查更新，在签名被 PI 正常接受后安装并重启。
4. `Process > Utilities > MCP Watcher > Start`。
5. pi coding agent 中检查 `/pixinsight status`，然后只读查询工作区。暂不需要开启写权限。

源码分支始终保持在 `master`。分发使用单独的 `dist-local` 分支，发布不应切换当前加载着 pi 扩展的源码工作区。本次首次发布只创建分支，没有 force-push 或覆盖原 `dist`。
