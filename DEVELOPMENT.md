# Development environment

Use macOS, Node.js 24.20.0 and Apple Command Line Tools. The optional `mise.toml`
pins Node without changing the system default:

```sh
mise trust ./mise.toml
mise install
cd apps/desktop
mise exec -- npm ci
mise exec -- npm run dev
```

Alternatively use an existing Node 24.20.0 installation. `npm ci` is for a fresh
checkout or changed lockfile, not a routine pre-test step. Electron uses its own
bundled runtime. The native catalog helper compiles for the host architecture;
package on the intended CPU architecture.

See [contributing](CONTRIBUTING.md), [architecture](docs/architecture.md), and
[release procedure](docs/releasing.md). Use only synthetic data for tests and
screenshots. Do not point development runs at personal transcripts.
