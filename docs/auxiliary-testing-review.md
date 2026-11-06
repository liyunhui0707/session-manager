# Second-machine testing and independent review

Use a separate Mac to check a release candidate with an explicitly authorized test window. Host names, credentials and personal infrastructure paths are local maintainer configuration, not part of this repository.

1. Record the exact source revision, package SHA-256, macOS version, CPU architecture and test runtime.
2. Transfer the candidate package and the **whole** `apps/desktop/tools/qa` directory; do not include Git history, personal settings, or chats.
3. Verify the transferred hash against the independently retained local hash. Extract in a private test directory.
4. On an available, unlocked desktop, use Node.js 24 to run `reader-smoke.mjs '/absolute/path/AI Session Manager.app'`. The harness creates invented conversations and an isolated profile.
5. Retain result JSON, exit status and synthetic screenshots. Stop on a preparation failure rather than repeatedly trying new remote-control methods.

A harness pass covers the tested app interactions. It does not prove Finder installation, download quarantine behavior, minimum-OS compatibility, Intel compatibility, or signed auto-update. Record those checks separately, and label untested items.

External reviewers may receive only an explicitly authorized minimal source snapshot, synthetic tests and a bounded resource budget. Never send chats or credentials. Preserve findings and addressed issues; do not equate a model's approval with executed tests.
