# Tests

All suites run on Jest with ts-jest. Import the test API from `@jest/globals`;
Jest cannot run `node:test` or vitest suites (they report "Your test suite must
contain at least one test" or fail to resolve `vitest`).

## Layout

| Path                              | What                                                            | Runner                      |
| --------------------------------- | --------------------------------------------------------------- | --------------------------- |
| `Tests/unit/`                     | Unit tests. No AutoHotkey, no network, no built `dist/`.        | `npm test`                  |
| `Tests/contract/`                 | MCP surface contracts (SDK client over an in-memory transport). | `npm test`, `test:contract` |
| `Tests/integration/`              | Spawns the built server from `dist/`.                           | `npm run test:integration`  |
| `Tests/ahk/`                      | Needs a real AutoHotkey v2 runtime (Windows).                   | `npm run test:ahk`          |
| `Tests/fixtures/`                 | Input files shared by suites.                                   | -                           |
| `Tests/setup/`                    | Shared Jest config, setup files and helpers.                    | -                           |
| `Tests/uia/`                      | UIA golden and end-to-end scripts for the v2.1-alpha fork.      | `npm run test:uia*`         |
| `Tests/portable-runtime.test.mjs` | Portable bundle check.                                          | `npm run test:portable`     |

## Commands

| Command                    | Config                        | Notes                                         |
| -------------------------- | ----------------------------- | --------------------------------------------- |
| `npm test`                 | `jest.config.cjs`             | Unit and contract suites. Must stay green.    |
| `npm run test:contract`    | `jest.config.cjs`             | Only `Tests/contract/`.                       |
| `npm run test:coverage`    | `jest.config.coverage.cjs`    | Same suites with coverage into `coverage/`.   |
| `npm run test:integration` | `jest.config.integration.cjs` | Builds first, then runs `Tests/integration/`. |
| `npm run test:ahk`         | `jest.config.ahk.cjs`         | Serial; passes when `Tests/ahk/` is empty.    |

Type-check the suites with
`node node_modules/typescript/bin/tsc -p Tests/setup/tsconfig.tests.json`
(`npm run check:types` covers `src/` only).

Run one file with
`npx cross-env NODE_ENV=test npx jest --config jest.config.cjs Tests/unit/foo.test.ts`.

All configs spread `Tests/setup/jest.base.cjs`, which holds the ts-jest
transform and the `.js` specifier mapping.

## Writing tests

- Import from `@jest/globals`, including `jest` for mocks and spies.
- ts-jest runs with `isolatedModules`: each file is transpiled to CommonJS on
  its own and **not type-checked**, so a type error does not fail the run. CI
  type-checks the suites separately with `Tests/setup/tsconfig.tests.json`.
  Modules that tests import must not use `import.meta` (a SyntaxError under
  CommonJS).
- Use `.js` specifiers for relative imports, as in `src/`.
- `Tests/setup/jest.setup.ts` only sets `NODE_ENV=test`,
  `AHK_MCP_LOG_LEVEL=error` and silences `console.log/info/debug`. There are no
  global helpers and no module mocks; import what you need.
- Mocks are cleared between tests (`clearMocks`). Restore spies you create.
- Write scratch files under `fs.mkdtempSync(path.join(os.tmpdir(), ...))`, never
  inside the repository, and remove them in `afterEach`.
- Never put absolute local paths, usernames or personal handles in a test or
  fixture. Build paths from `os.tmpdir()`, `path.join` and `__dirname`.

### AutoHotkey-dependent suites

Put them under `Tests/ahk/` and gate them on the runtime:

```ts
import { describe, it, expect } from '@jest/globals';
import { findAutoHotkey } from '../setup/ahk-runtime.js';

const ahk = findAutoHotkey();

(ahk ? describe : describe.skip)('AHK_Check golden corpus', () => {
  it('accepts count += 1', async () => {
    // ...
  });
});
```

`findAutoHotkey()` returns `AHK_MCP_AHK_PATH` when it is set, else the default
v2 install location, else `null` (always `null` off Windows). Locally a missing
runtime skips the suites. CI sets `AHK_TEST_REQUIRE_RUNTIME=1`, and then a
missing runtime fails the run in the global setup instead.

## Quarantine

These suites are excluded through `testPathIgnorePatterns` (and from
`Tests/setup/tsconfig.tests.json`) because the code they exercise is being
replaced. Do not fix them. The owning package deletes each file and its ignore
entry.

| Suite                                       | Why                                                      | Owner                           |
| ------------------------------------------- | -------------------------------------------------------- | ------------------------------- |
| `Tests/contract/dry-run-output.test.ts`     | node:test; v2 AHK_File_Edit dry-run output               | WP12 (replaces), WP32 (deletes) |
| `Tests/contract/parameter-aliases.test.ts`  | node:test; v2 AHK_File_Edit `content`/`newContent` alias | WP12 (replaces), WP32 (deletes) |
| `Tests/unit/dry-run-preview.test.ts`        | node:test; `src/utils/dry-run-preview.ts` is removed     | WP32                            |
| `Tests/unit/parameter-aliases.test.ts`      | node:test; `src/core/parameter-aliases.ts` is removed    | WP32                            |
| `Tests/unit/dependency-resolver.test.ts`    | vitest; v2 library catalog                               | WP18                            |
| `Tests/unit/library-catalog.test.ts`        | vitest; v2 library catalog                               | WP18                            |
| `Tests/unit/library-scanner.test.ts`        | vitest; v2 library catalog                               | WP18                            |
| `Tests/unit/metadata-extractor.test.ts`     | vitest; v2 library catalog                               | WP18                            |
| `Tests/integration/backward-compat.test.ts` | node:test; v2 AHK_File_Edit and smart orchestrator       | WP32                            |
| `Tests/integration/edit-dryrun.test.ts`     | node:test; v2 AHK_File_Edit dry-run                      | WP32                            |

`Tests/integration/dap-session.test.ts` is not quarantined; it is
`describe.skip` inside the file (owned by the DAP package, WP16).

## Privacy scan

`scripts/check-privacy.mjs` fails when any tracked file, or a tracked path,
contains a denylisted token (a personal handle, username or local path). The
list is never committed. Provide it through one of:

- `AHK_MCP_PRIVACY_DENYLIST`: newline-separated tokens (CI reads the repository
  secret of the same name);
- `AHK_MCP_PRIVACY_DENYLIST_FILE`: a file outside the repository with one token
  per line. Blank lines and `#` comments are ignored.

Matching is a case-insensitive substring match, so list each spelling that
matters (for example both separator styles of a path). The script prints only
`file:line` (or `file: path` with the token masked as `***`, or
`file: binary content`), never the token. Exit codes: 0 clean, 1 hits, 2 no
denylist, a token shorter than 3 characters, or a git error.

The pre-commit hook runs the scan when either variable is set in your shell.

## CI

`.github/workflows/ci.yml` runs on pushes and pull requests to `master` and
`feat/**`:

- **build-test**: ubuntu-latest and windows-latest, Node 20 and 22: `npm ci`,
  `check:types`, the test type-check, `lint`, `build`, `docs:check` (Ubuntu
  only; config docs alone until the tools generator exists), `npm test`,
  `smoke:mcp`, `smoke:mcp:2026`.
- **autohotkey**: windows-latest, installs a pinned, hash-checked AutoHotkey v2
  build, exports `AHK_MCP_AHK_PATH`, and runs `npm run test:ahk`.
- **privacy**: `scripts/check-privacy.mjs` with the `AHK_MCP_PRIVACY_DENYLIST`
  secret. Skipped for forks, which do not receive secrets; fails if the secret
  is missing anywhere else.

`release.yml` publishes to npm only for a pushed `v*.*.*` tag that matches
`package.json` (prereleases go to the `next` dist-tag). `security.yml` runs npm
audit, a license allowlist, CodeQL, dependency review and a secret scan.
