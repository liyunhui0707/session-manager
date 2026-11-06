# Repository discipline

- The public `session-manager` repository is the product's source of truth. Start future feature branches from its accepted `main`; use reviewed pull requests and passing checks for integration.
- Keep one normal development checkout. Additional worktrees are for genuine isolation, not every small change. Do not maintain parallel, diverging product histories.
- Save verified, coherent changes. Inspect staged files and diff before committing. Do not push archive refs or unrelated repository history.
- Use the maintainer's GitHub noreply email for public commit authors and committers. Local Git identity does not control GitHub-generated merge commits: pass `gh pr merge --author-email <GitHub-noreply-email>` explicitly and verify the resulting metadata before tagging. If GitHub rejects that address, do not retry without it: create the reviewed merge locally with the repository's noreply identity, verify its metadata, and push normally without force. Do not change global Git identity as part of a project task.
- Keep source, tests, README and release notes synchronized. Historical evidence belongs in a private maintenance archive when it includes personal infrastructure information.
- Build output, dependencies and temporary synthetic QA artifacts are ignored, not product source. Preserve useful rollback evidence; cleanup must have specific targets.
- Check release artifacts against the exact tag, verify checksums and run the packaged synthetic checks. Distribution artifacts belong in GitHub Releases, not Git commits.
- Installed applications are separate from build output. Quit before replacing a local installed build. Do not modify users' Dock entries or install to a system directory as part of CI.
- Current public packages are ad-hoc signed, without Developer ID or notarization, and manually updated. Never present an ad-hoc build as notarized or claim auto-update acceptance before testing signed upgrades.
- Use SemVer: patch for fixes, minor for new behavior before 1.0. A 1.0 declaration is a deliberate product decision. Keep `package.json`, lockfile and release notes consistent.
