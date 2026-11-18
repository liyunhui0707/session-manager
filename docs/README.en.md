# Threadleaf

A quiet, local reader for your Codex conversations on macOS.

[Download](https://github.com/liyunhui0707/threadleaf/releases/latest) · [中文](../README.md)

Read prompts and final replies, open at the latest message, search across conversations, keep favorites, and choose a comfortable text size and theme. Known background tasks and archived conversations are hidden. Existing Codex and Claude Markdown export libraries are also supported; native Claude integration is not included.

No app account, AI service, analytics, or chat upload is required. Browsing and searching leave source conversations unchanged. Explicit Markdown **Refresh imports** is a separate action that writes exported Markdown files.

## Install

The downloadable build supports Apple Silicon Macs running macOS 12 or later. Download the DMG from GitHub Releases and drag Threadleaf into Applications. Intel users can build from source; an accepted Intel binary is not currently offered.

Threadleaf 0.13.0 succeeds AI Session Manager and displays native inline image attachments. Quit the old app, install Threadleaf alongside it and verify your settings before removing the old app.

The reader hides recognized tool-question exchanges from Codex reading, pagination, message counts and search, while retaining prompts typed in the normal input box and final replies. Independent reader windows let you place conversations on different macOS desktops.

**The release is not Developer ID signed or notarized.** macOS may block the first launch. Only if you trust this repository, use the system's Privacy & Security → Open Anyway option. Do not disable Gatekeeper globally. See [Apple's instructions](https://support.apple.com/en-us/102445).

First launch tries `~/.codex`; later launches restore your source selection. Updates are manual: quit the app, download the newer version, and replace the application. In-app update installation is not available yet.

## Multiple windows

Use **⌘N**, the sidebar **+** button, or **File → New Window** to open another reader with the same source. Right-click a conversation to open it in a new window. Sources, navigation, search and reading positions are independent; favorites and appearance are shared. Move windows to different desktops using macOS Mission Control.

Closing a window leaves the others open; quitting closes all windows. The next launch restores the source, not the previous window layout.

## Build

Requires macOS, Node.js 24, and Apple Command Line Tools.

```sh
git clone https://github.com/liyunhui0707/threadleaf.git
cd threadleaf/apps/desktop
npm ci
npm run dev
npm run test:ci
npm run audit:prod
npm run audit:release
npm run dist:mac
```

Build on the target CPU architecture. The native scanner and Electron runtime must match. See [contributing](../CONTRIBUTING.md), [privacy](privacy.md), and [release procedure](releasing.md).

`dist:mac` prepares and checksum-validates Electron automatically. The first
download needs network access. Move existing same-version DMG/ZIP artifacts
aside before rebuilding. The full audit includes Electron, even though npm
classifies it as a development dependency; see [remaining build-tool findings](dependency-audit.md).

## Scope

Unknown or incompletely recognized message formats remain readable to avoid hiding ordinary text. Source files are unchanged.

First opens and uncached searches scan the conversation. Resource limits and corrupt records produce visible incomplete-read warnings. Local references and Codex inline static PNG/JPEG attachments are loaded on demand, up to 8 MiB and 24 megapixels. Remote images are not fetched; deleted local images without an embedded copy cannot be recovered.

Please report problems using synthetic examples, without chats, local paths, or credentials. This is an independent project, not affiliated with OpenAI or Anthropic. [MIT licensed](../LICENSE).
