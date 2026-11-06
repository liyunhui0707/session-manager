# Security

This app handles private local conversations. Source access belongs to the Electron main process; the renderer is sandboxed. Session content must never become executable HTML or arbitrary filesystem access.

Please do not publish real transcripts, credentials, exploit payloads containing private data, or unredacted paths in an Issue. Use the repository's **Security → Report a vulnerability** option for confidential reports when available. If private reporting is unavailable, open an Issue requesting a private contact channel without disclosing the vulnerability details.

Include the app version, macOS version, a synthetic reproduction, and the expected security boundary. There is no promised response-time SLA; the current public release is the maintained version.

Current binaries are not Developer ID signed or notarized. Release checksums verify file consistency, not publisher identity. Download only from the project release page; do not disable macOS security globally to run the app.
