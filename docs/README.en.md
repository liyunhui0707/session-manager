# AI Session Manager

A quiet, local reader for your Codex conversations on macOS.

[Download](https://github.com/liyunhui0707/session-manager/releases/latest) · [中文](../README.md)

Read prompts and final replies, open at the latest message, search across conversations, keep favorites, and choose a comfortable text size and theme. Known background tasks and archived conversations are hidden. Existing Codex and Claude Markdown export libraries are also supported; native Claude integration is not included.

No app account, AI service, analytics, or chat upload is required. Browsing and searching leave source conversations unchanged. Explicit Markdown **Refresh imports** is a separate action that writes exported Markdown files.

## Install

The downloadable build supports Apple Silicon Macs running macOS 12 or later. Download the DMG from GitHub Releases and drag AI Session Manager into Applications. Intel users can build from source; an accepted Intel binary is not currently offered.

**The release is not Developer ID signed or notarized.** macOS may block the first launch. Only if you trust this repository, use the system's Privacy & Security → Open Anyway option. Do not disable Gatekeeper globally. See [Apple's instructions](https://support.apple.com/en-us/102445).

First launch tries `~/.codex`; later launches restore your source selection. Updates are manual: quit the app, download the newer version, and replace the application. In-app update installation is not available yet.

## Build

Requires macOS, Node.js 24, and Apple Command Line Tools.

```sh
git clone https://github.com/liyunhui0707/session-manager.git
cd session-manager/apps/desktop
npm ci
npm run dev
npm run test:ci
npm run audit:prod
npm run dist:mac
```

Build on the target CPU architecture. The native scanner and Electron runtime must match. See [contributing](../CONTRIBUTING.md), [privacy](privacy.md), and [release procedure](releasing.md).

## Scope

First opens and uncached searches scan the conversation. Resource limits and corrupt records produce visible incomplete-read warnings. Local static PNG/JPEG references are supported up to 8 MiB and 24 megapixels; remote and inline encoded images are not loaded, and deleted temporary images cannot be recovered.

Please report problems using synthetic examples, without chats, local paths, or credentials. This is an independent project, not affiliated with OpenAI or Anthropic. [MIT licensed](../LICENSE).
