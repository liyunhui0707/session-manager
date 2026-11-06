# 安装与手动更新

## 选择安装包

在 [GitHub Releases](https://github.com/liyunhui0707/session-manager/releases/latest) 下载当前版本。`arm64` 表示 Apple Silicon（M 系列芯片）。可在 Apple 菜单 → 关于本机中确认芯片。

下载 DMG 后，将 App 拖入“应用程序”，推出磁盘映像，再从“应用程序”启动。也可将 ZIP 解压后拖入“应用程序”。无需 Node、终端或开发工具。

当前提供 Apple Silicon 包；最低系统版本 macOS 12。仅在列出的测试平台上完成了实际验证，最低版本声明不等于逐个系统版本都已实测。Intel 暂无已验收下载包。

## macOS 首次打开提示

当前安装包未使用 Developer ID 签名，未通过 Apple 公证。macOS 的安全提示是这一分发方式的限制，不是要求你购买会员；使用者不需要 Apple 开发者会员。

确认下载来源与校验和后，尝试打开 App，再进入“系统设置 → 隐私与安全性”，按系统提供的“仍要打开”流程确认。具体文字随 macOS 版本变化，参见 [Apple 官方说明](https://support.apple.com/en-us/102445)。

如果系统提示已知恶意软件、文件损坏，或没有允许打开的选项，请停止并反馈，不要执行来源不明的终端命令，也不要全局关闭 Gatekeeper。

可选校验：在下载目录运行以下命令，将结果与同版本 `SHA256SUMS-arm64.txt` 比较：

```sh
shasum -a 256 AI-Session-Manager-0.10.2-mac-arm64.dmg
```

校验和用于检测下载损坏或文件不一致，不替代 Apple 身份签名。

## 首次使用

首次运行尝试打开 `~/.codex`。没有记录时，用左下角的本地来源按钮选择 Codex 根文件夹。自定义 `CODEX_HOME` 的用户请手动选择相应根目录；应用随后会记住该位置。

## 更新

1. 查看 [发行记录](https://github.com/liyunhui0707/session-manager/releases)。
2. 下载适合本机的新版本，正常退出正在运行的 App。
3. 使用新 App 替换“应用程序”中的旧 App，再次打开。

聊天记录仍由 Codex 管理；替换 App 不会删除聊天源文件。阅读设置、来源路径与收藏保留在本机应用数据中。可以保留上一版安装包用于回退。当前不提供自动下载、后台替换或应用内一键升级。

## 卸载

正常退出 App，将其移到废纸篓即可。此操作不会删除 Codex 记录。应用偏好数据可按需另行清理，但不要将 Codex 原始数据目录当作应用缓存删除。
