# Contributing

Thank you for helping make conversations easier to revisit.

## Setup

Use macOS, Node.js 24, and Apple Command Line Tools. From `apps/desktop`, run `npm ci` and `npm run dev`. The build compiles the native catalog helper for the host architecture.

## Changes

Start a focused branch from the public repository's `main`. Keep one behavior change per pull request, include a short problem statement and relevant verification. Do not add editing, AI rewriting, or cloud synchronization to this read-only reader without a separate design discussion.

Use synthetic data only. Never attach or commit real chats, credentials, local configuration, dependencies, or build output. Existing importer fixtures are deliberately invented. Screenshots should use demo conversations.

```sh
cd apps/desktop
npm run test:ci
npm run audit:prod
npm run pack
```

For release tools and website changes, also run `node --test tools/release/*.test.mjs` from the repository root. Before publishing, run `python3 tools/release/audit-public-tree.py` from the repository root and review its filenames-only report. Automated scanning reduces risk; it is not a guarantee that all sensitive information has been detected.

User-visible changes need a packaged smoke test using the entire `apps/desktop/tools/qa` directory and a fresh synthetic profile. See [test checklist](docs/test-manual.md) and [second-machine testing](docs/auxiliary-testing-review.md).

## Documentation and releases

Keep Chinese README and English overview accurate. Describe actual user behavior rather than internal development history. State meaningful limitations plainly. Follow [release procedure](docs/releasing.md) and [repository discipline](docs/repository-maintenance.md).

The `design/session-reader` folder is an isolated visual reference with fictional content, not the shipping app. The production interface is in `apps/desktop`. Historical reader code under `tools/legacy-reader` supports regression tests and is excluded from the app package.

Contributions are under the project's MIT license. Do not include personal data in commit messages; a GitHub noreply address can protect your email privacy.
