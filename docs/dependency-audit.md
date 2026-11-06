# Dependency audit — 2026-11-06

The 0.10.2 candidate updates Electron from 43.4.1 to 43.8.7 and
electron-builder from 26.15.7 to 26.18.0, within their existing major versions.
Compatible transitive updates cover brace-expansion, fast-uri, js-yaml and undici.

Electron is an npm development dependency but its runtime **ships in the App**.
`npm audit --omit=dev` alone is not a runtime security assessment. CI and release
checks now run both the production audit and `npm run audit:release`, which
fails on high/critical findings anywhere in the dependency tree. No audit result
is a guarantee that an application is vulnerability-free.

After this update, the registry audit reports **0 high/critical and 6 moderate**
findings; the production-only audit reports 0. Audit databases change: rerun
before each release rather than treating these counts as permanent.

## Remaining build-tool finding

The six moderate entries originate from one
[minimatch pattern-amplification advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249),
propagated through `@electron/universal`, `app-builder-lib`, `dmg-builder`,
`electron-builder-squirrel-windows` and `electron-builder`.

The advisory concerns attacker-controlled glob patterns with
`optimizationLevel >= 2`. The inspected packaging calls use default level 1
(`{ dot: true }` or `{ matchBase: true }`), and this project's packaging patterns
come from reviewed source configuration, not user chats. These build modules
are not application runtime dependencies. This limits the observed exposure;
it does not mark the upstream advisory as fixed.

The registry suggests a breaking downgrade to electron-builder 25.1.0; this
project does not apply that downgrade or force minimatch 11 into consumers that
declare older major versions. Keep the warning visible, use trusted build
configuration, and reevaluate when compatible upstream fixes arrive. Do not
disable audits or run `npm audit fix --force` just to remove the warning count.

References: [Electron 43.8.7 release](https://github.com/electron/electron/releases/tag/v43.8.7),
[Electron preload-cache advisory](https://github.com/electron/electron/security/advisories/GHSA-qmv3-fv6v-rmhq).
