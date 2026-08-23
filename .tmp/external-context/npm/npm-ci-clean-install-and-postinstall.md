---
source: Official npm documentation (validated with Context7)
library: npm CLI
package: npm
topic: npm ci clean install, node_modules replacement, and postinstall behavior
tech_stack: Node.js 22, CommonJS Electron application
fetched: 2026-08-23T00:00:00Z
official_docs: https://docs.npmjs.com/cli/v10/commands/npm-ci/
additional_official_docs:
  - https://docs.npmjs.com/cli/v10/using-npm/scripts/
  - https://docs.npmjs.com/cli/v11/commands/npm-ci/
  - https://docs.npmjs.com/cli/v11/using-npm/scripts/
---

# Verified npm behavior

The official npm 10 and npm 11 documentation agrees on the relevant behavior:

- `npm ci` requires an existing `package-lock.json` (or `npm-shrinkwrap.json`).
- It installs the entire project from the lockfile. If `package.json` and the lockfile disagree, it exits with an error instead of changing the lockfile.
- It does not write to `package.json` or a package lock.
- If `node_modules` exists, npm automatically removes it before installing. This is a full clean replacement, not an additive repair of only missing modules.
- The documented `npm ci` lifecycle includes, in order: `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, and `postprepare`. These run after modules are installed.
- `ignore-scripts` defaults to `false`; therefore a declared `postinstall` runs by default. `--ignore-scripts` (or equivalent npm configuration) suppresses package scripts.

# Operational recommendation

Match CI's Node 22 environment and record `npm --version`, review/trust the project's install-time scripts, then run `npm ci` from the project root and rerun tests only after it succeeds. Do not use `npm install <missing-package>` for restoration: `npm ci` intentionally discards the current `node_modules` tree and reconstructs the locked dependency graph. In an Electron project, do not treat `npm ci --ignore-scripts` as a test-ready restore unless install scripts are known to be unnecessary, because Electron/native dependencies may rely on them.

The application's CommonJS module format does not alter these npm installation semantics.
