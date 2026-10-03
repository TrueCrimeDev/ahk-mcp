# ahk-mcp v3 work packages

Original dependency-ordered packages from the audit synthesis. Adjustments are
listed under "Owner decisions" and "Delivery phases" in v3-architecture.md:
WP00b, WP00c and WP00d fold into WP05, WP08, WP16 and WP30; observability is
kept and hardened, not deleted; the active file is removed; regex editing is
dropped.

## WP00a Privacy and package-leak stop-gap (2.x patch) [deps: -] breaking=false

FILES: image copy 2.png, image copy.png, image.png, package.json, .gitignore,
.prettierignore, .dockerignore, scripts/fix-mcp-types.cjs Changes:

- git rm the three tracked root screenshots. One shows a prohibited personal
  account handle; never name it in code, commits or PR text.
- Add a package.json 'files' whitelist: dist, data, docs/Modules, inspector,
  scripts/\*.ahk, scripts/studio, README.md, LICENSE. This stops npm pack from
  shipping the .kilo worktree with personal settings, Tests, docs and images.
- Add .kilo/, .superpowers/, .history/, artifacts/, logs/ and coverage/ to
  .gitignore, .prettierignore and .dockerignore. In .gitignore, remove duplicate
  rules and fix the merged comment line at 160.
- Delete scripts/fix-mcp-types.cjs. Do not rewrite history or remove the
  worktree. Put the exact commands in the PR description for the owner to
  approve. ACCEPT: `npm pack --dry-run --json` has no entries under .kilo/,
  .claude/, .history/ or Tests/, and no root \*.png. Prettier reports .kilo
  files as ignored. Build, typecheck and smoke:mcp pass. No committed text
  references the removed handle.

## WP00b Hotfix the v2 dispatcher: containment gate, cancellation, era keys, alpha removal, annotations, delisting (2.x patch) [deps: -] breaking=true

FILES: src/server.ts, src/core/tool-metadata.ts, src/core/tool-registry.ts,
src/core/server-interface.ts, src/core/tool-settings.ts,
src/core/tool-factory.ts, src/core/alpha-version.ts,
src/tools/ahk-system-alpha.ts, src/tools/ahk-file-edit.ts,
src/tools/ahk-system-settings.ts, src/tools/uia-tools.ts,
src/core/client-roots.ts, src/core/mcp-apps.ts, scripts/smoke-mcp.js,
scripts/smoke-mcp-2026.js, Tests/contract/hotfix-regressions.test.ts Only
package allowed to touch the hot files in phase 0. Changes:

1. Delete the alpha subsystem: alpha-version.ts, ahk-system-alpha.ts, the
   AHK_Alpha registry/settings/interface entries, the dead tool-factory.ts, and
   the handleEditFailure call at ahk-file-edit.ts:814. AHK_File_Edit's catch now
   returns isError.
2. Remove the notifications/cancelled override (server.ts:363-369).
3. Remove dispatcher autoDetect (server.ts:749-758).
4. Add a dispatcher path gate. Every string or array argument named filePath,
   file, path, scriptPath, targetFile, directory, scriptDir, extraDirs or files
   goes through the existing assertAllowedPath(value, access) before dispatch.
   access is 'write' for the edit/create set and 'read' otherwise. Failures
   return isError naming the roots; the canonical path is substituted into the
   arguments.
5. Drop 'arguments' from error details (server.ts:923-930).
6. Set annotations explicitly:
   - destructiveHint true for AHK_Run, AHK_Eval, AHK_Debug_DBGp,
     AHK_Cloud_Validate, AHK_Lint, AHK_File_Create, AHK_Settings and AHK_Config;
   - readOnlyHint true for AHK_Library_Import;
   - openWorldHint true for uia\_\*, and for AHK_File_Edit and
     AHK_File_Edit_Small while validate/runAfter still execute code.
7. Delist AHK_Process_Request, AHK_Smart_Orchestrator,
   AHK_Workflow_Analyze_Fix_Run, AHK_File_Edit_Advanced and AHK_File_Detect.
8. List search/fetch only when AHK_MCP_CHATGPT_COMPAT=1.
9. Fix era detection: read ctx.mcpReq.envelope[PROTOCOL_VERSION_META_KEY] and
   [CLIENT_CAPABILITIES_META_KEY]. AHK_Run's missing-path prompt always returns
   inputRequired, and the SDK shim serves 2025 clients. client-roots skips
   listRoots on modern requests. MCP Apps gating reads the envelope.
10. AHK_Settings enable/disable returns isError 'operator-only', and the
    disabled-tool message no longer tells the model to re-enable tools.
11. Default autoOpenInVsCodeAfterEdit to false. The contract with WP00c is
    assertAllowedPath(target, access): Promise<string>; its signature stays
    unchanged. ACCEPT: Regression tests pass:

- a client cancel aborts the handler signal;
- out-of-root paths return isError for AHK_File_View, AHK_Analyze and AHK_Run;
- three failing AHK_File_Edit calls create no \*\_aN.ahk;
- delisted tools are absent from tools/list and rejected with -32602;
- tools/list is byte-identical before and after an AHK_Settings call;
- the annotation snapshot matches. smoke:mcp passes. smoke:mcp:2026 runs with an
  isolated config dir and asserts input_required instead of SKIP.

## WP00c Path policy and AutoHotkey executable hardening (2.x patch) [deps: -] breaking=true

FILES: src/core/path-policy.ts, src/core/config.ts,
src/tools/ahk-system-config.ts, src/tools/ahk-analyze-code.ts,
src/tools/ahk-analyze-diagnostics.ts, src/tools/ahk-run-script.ts,
src/tools/ahk-cloud-validate.ts, src/tools/ahk-debug-dbgp.ts,
src/core/dbgp-client.ts, src/tools/ahk-analyze-vscode.ts,
Tests/unit/path-policy.test.ts, Tests/unit/config-paths.test.ts Changes:

1. path-policy:
   - reject UNC, device and extended-length prefixes and NTFS alternate data
     streams lexically, before any fs call;
   - check pre-canonicalized roots lexically before calling realpath;
   - exclude cwd when it is a drive root, the home directory or a system
     directory;
   - log the effective roots at startup;
   - keep the assertAllowedPath signature unchanged.
2. AHK_Config 'set' of scriptDir, searchDirs or ahkPath returns isError
   'operator-only' and writes nothing.
3. Remove the per-call ahkPath from AHK_Run and AHK_Cloud_Validate. Executable
   candidates become: env, then config, then %ProgramFiles%, then
   LOCALAPPDATA/Programs, then PATH. cwd-relative binaries are used only with
   AHK_MCP_ALLOW_LOCAL_AHK=1.
4. Remove autoDetect(code) from AHK_Analyze and AHK_Diagnostics.
5. AHK_Debug_DBGp get_source: assertAllowedPath, .ahk only, radius at most 50.
   Remove apply_fix.
6. AHK_VSCode_Problems: accept only .json, and run assertAllowedPath.
7. Fix the stale config-paths suite. ACCEPT: Unit tests:

- UNC, device and ADS inputs are rejected with zero fs calls (spy);
- writes through a symlink are refused;
- the cwd guard works;
- AHK_Config set scriptDir returns isError and leaves config unchanged;
- executable candidate order is correct;
- the config-paths suite passes.

## WP00d Lock down the DAP listener (2.x patch) [deps: -] breaking=true

FILES: src/dap/dap-server.ts, src/dap/dap-session.ts, src/dap/index.ts,
src/dap/translator.ts, src/dap/types.ts, Tests/integration/dap-session.test.ts,
Tests/unit/dap-translator.test.ts, docs/dap.md Changes:

- Require a per-process random token (AHK_MCP_DAP_TOKEN, or a generated one
  written to a user-only file) in initialize/launch.
- Reject frames whose header block is anything other than Content-Length; this
  blocks cross-protocol HTTP requests.
- Cap headers at 1 KiB and bodies at 4 MiB, and destroy the socket on overflow.
- Ignore a client-supplied ahkPath.
- The program must pass assertAllowedPath and end in .ahk.
- Spawn with /Debug=127.0.0.1:<the DBGp port actually bound>.
- On EADDRINUSE, fail instead of silently incrementing the port.
- Remove describe.skip from the integration suite and fix it. ACCEPT: Tests:
- launch without the token is rejected;
- an HTTP-shaped POST frame is rejected;
- an oversize frame closes the socket;
- a client ahkPath is ignored;
- an out-of-root program is rejected;
- the dap-session suite runs, not skipped.

## WP01 Foundation: zod 4, dependency and dead-code purge, package metadata [deps: WP00a,WP00b,WP00c,WP00d] breaking=false

FILES: package.json, package-lock.json, tsconfig.json, tsconfig.build.json,
src/\*_/_.ts (import-specifier rewrite 'zod' to 'zod/v3' only), src/server.ts
(version source only), src/compiler/antlr/generated/\*,
src/core/in-memory-event-store.ts, src/core/message-interceptor.ts,
src/core/metrics.ts, src/core/tool-types.ts, src/core/version-manager.ts,
src/tools/ahk-analyze-complete.ts, src/tools/ahk-cloudahk-validate.ts,
src/tools/ahk-memory-context.ts, src/types/library-schemas.ts,
src/utils/debug-formatter.ts, src/utils/path-auto-retry.ts,
src/utils/schema-generator.ts, src/version.ts,
Tests/unit/version-manager.test.ts, Tests/unit/debug-formatter.test.ts,
Tests/manual/verify-unified-tool.ts Runs alone, because it touches every zod
importer. Changes:

- Upgrade zod to ^4.2 so there is one copy shared with the SDK. Mechanically
  rewrite existing `from 'zod'` imports to `from 'zod/v3'`; new code imports
  'zod'.
- Freeze the three zod-to-json-schema outputs (AHK_File_View, AHK_VSCode_Open,
  AHK_Test_Interactive) as literals, then delete schema-generator.ts and
  zod-to-json-schema.
- Delete the 17 unreachable modules and their tests. The ANTLR files also embed
  a third party's local path.
- Remove antlr4ng, prom-client and ts-node. Add jsdiff.
- package.json:
  - repository, engines, and bin placeholders (wired in WP30);
  - remove the dead scripts: spec:\*, dev, start:chatgpt, test:coverage:report;
  - start:http uses --http; prepare is 'husky'; test:integration builds first;
  - pre-register scripts so later packages never need package.json: test:ahk,
    test:contract, build:docs-corpus, gen:config-docs, gen:tools-docs,
    docs:check.
- Add src/version.ts, which reads the package.json version. Use it in
  serverInfo, the server card and OTel instead of the three hard-coded '2.0.0'.
  ACCEPT: `npm ls zod` shows a single 4.x. check:types, lint (current scope),
  build, unit tests and both smoke scripts pass. No import of a deleted module
  remains. dist contains no ANTLR output.

## WP02 Green test harness and CI on master [deps: WP01] breaking=false

FILES: jest.config.cjs, jest.config.integration.cjs, jest.config.coverage.cjs,
jest.config.ahk.cjs, Tests/setup/jest.setup.ts,
Tests/setup/jest.integration.setup.ts, Tests/contract/debug-output.test.ts,
Tests/integration/orchestrator-debug.test.ts,
Tests/unit/orchestration-context.test.ts, Tests/manual/\*\*, Tests/README.md,
.github/workflows/ci.yml, .github/workflows/release.yml,
.github/workflows/security.yml, .husky/pre-commit, scripts/check-privacy.mjs
Changes:

- Delete the suites for features that are already gone (debugMode, orchestrator
  context) and Tests/manual.
- Quarantine suites whose code WP12, WP18 or WP32 will replace by adding
  testPathIgnorePatterns entries. Each entry gets a TODO naming the owning
  package. Do not edit those files.
- Set ts-jest isolatedModules. Delete the unused integrationHelpers.
- Add jest.config.ahk.cjs for Tests/ahk/\*\*.
- New ci.yml on push/PR to master:
  - windows-latest and ubuntu-latest × Node 20/22: npm ci, check:types, lint,
    build, test, smoke:mcp, smoke:mcp:2026;
  - a Windows job that installs AutoHotkey v2 and runs test:ahk;
  - docs:check;
  - a privacy scan (scripts/check-privacy.mjs) against a denylist supplied only
    as a secret.
- release.yml becomes tag-triggered, or is deleted. ACCEPT: `npm test` has zero
  failing suites, and the quarantine list is documented. CI is green on master
  on both operating systems. A planted denylisted token fails the privacy job on
  a test branch.

## WP03 Unified operator configuration [deps: WP01] breaking=false

FILES: src/core/env-config.ts, src/core/operator-config.ts,
scripts/gen-config-docs.mjs, docs/CONFIGURATION.md,
Tests/unit/config/env-config.test.ts, Tests/unit/config/operator-config.test.ts
env-config.ts:

- One zod v4 schema for every environment variable, with a single boolean parser
  (1/true/yes/on).
- Namespaced names: AHK*MCP_AHK_PATH, AHK_MCP_FORK_AHK_PATH,
  AHK_MCP_ALLOWED_DIRS, AHK_MCP_FILE_EXTENSIONS, AHK_MCP_TOOLSETS,
  AHK_MCP_READ_ONLY, AHK_MCP_LOG_LEVEL/FORMAT/DIR, AHK_MCP_PORT, AHK_MCP_DAP*\*,
  AHK_MCP_OTEL_ENDPOINT, AHK_MCP_CHATGPT_COMPAT, AHK_MCP_TOOL_DISCOVERY,
  AHK_MCP_LEGACY_TOOL_NAMES, AHK_MCP_TEXT_MIRROR.
- The old names (AHK*PATH, AHK_PATH_WIN, AHK_BINARY, AHK_DAP*\*, PORT,
  LOG_LEVEL, AHK_THQBY_LSP_SERVER, AHK_MCP_LIGHT and others) remain as
  deprecated aliases, each warned once on stderr.
- Warn about unknown AHK*MCP*\* keys.
- Keep the existing getters as wrappers so v2 callers still compile.
  operator-config.ts reads an operator-owned JSON file (allowedDirs, ahkPath,
  forkAhkPath, thqbyLspPath, toolsets, fileExtensions), cached by mtime. No tool
  can write it. Generate docs/CONFIGURATION.md from the schema. ACCEPT: Unit
  tests for parsing, aliases, unknown-key warnings and the mtime cache. Running
  the generator twice produces no diff.

## WP04 Legacy task manager fixes [deps: WP01] breaking=false

FILES: src/core/task-manager.ts, Tests/unit/task-manager.test.ts Changes:

- expiresAt = createdAt + ttl.
- A finite default task timeout: 10 minutes, configurable.
- A per-principal concurrency cap (default 8) and principal-scoped
  list/get/cancel/result.
- ProtocolError(INVALID_PARAMS) for a bad cursor.
- A completion callback for telemetry.
- API changes are additive, so the v2 dispatcher keeps compiling. ACCEPT: Unit
  tests cover:
- a stuck task pruned by TTL counted from creation;
- rejection at the cap;
- isolation between principals;
- -32602 for a bad cursor.

## WP05 File I/O primitives and path policy v3 [deps: WP03] breaking=false

FILES: src/core/path-policy.ts, src/core/path-normalize.ts,
src/core/fs/text-codec.ts, src/core/fs/safe-write.ts, src/core/fs/path-lock.ts,
src/core/fs/unified-diff.ts, src/tooling/path-gate.ts,
Tests/unit/path-policy.test.ts, Tests/unit/fs/text-codec.test.ts,
Tests/unit/fs/safe-write.test.ts, Tests/unit/fs/path-normalize.test.ts

- text-codec: BOM detection (UTF-8, UTF-16LE/BE); fatal UTF-8 decode that
  returns an error; detection of the dominant EOL; an LF-normalized working
  text; exact restoration of charset, BOM and EOL on write.
- safe-write:
  - the temp file uses randomUUID and 'wx' in the target directory;
  - fsync, then rename with retry on EPERM/EBUSY;
  - the temp file is unlinked in finally;
  - a per-path async mutex;
  - byte-exact backups via copyFile into a server-managed backup dir with
    retention.
- unified-diff: jsdiff with 3 lines of context and truncation.
- path-normalize: one toNative(path). On win32 it converts /mnt/<drive> paths to
  drive paths; on a WSL host it converts drive paths to /mnt/<drive>; UNC is
  rejected.
- path-policy v3: roots = legacy client roots ∪ operator allowedDirs/env ∪
  guarded cwd ∪ an in-memory grant API (stdio, or an authenticated principal).
  Config scriptDir/searchDirs are no longer trusted.
- path-gate: resolves the pathArgs a ToolSpec declares (access, extensions) to
  canonical paths, or returns a typed PathNotAllowed error carrying the roots.
  ACCEPT: Round-trips are byte-identical when nothing changes: CRLF, LF, mixed,
  UTF-8 BOM, and UTF-16LE with non-ASCII text. Backups are byte-identical.
  Concurrent writes to one path serialize. toNative passes its table tests.
  Policy tests cover grants, the cwd guard, UNC and ADS, and refusing writes
  through symlinks.

## WP06 Protocol helpers, change notifier, resource/prompt specs, logging and telemetry [deps: WP03] breaking=false

FILES: src/server/era.ts, src/server/change-notifier.ts,
src/tooling/resource-spec.ts, src/tooling/prompt-spec.ts,
src/tooling/telemetry.ts, src/logger.ts, Tests/unit/tooling/era.test.ts,
Tests/unit/tooling/change-notifier.test.ts,
Tests/unit/tooling/telemetry.test.ts, Tests/unit/logger.test.ts

- era.ts: requestEra, clientCapabilities, supportsFormElicitation and
  supportsMcpApps. Reads the envelope keys on 2026 and handshake state on 2025.
- change-notifier.ts: sends toolsChanged, promptsChanged, resourcesChanged and
  resourceUpdated to the pinned stdio instance and to createMcpHandler().notify.
  Deduplicates by per-URI content hash. Emits a fileTouched event for the MRU
  resource.
- resource-spec / prompt-spec: typed specs registered through
  McpServer.registerResource (static resources, and ResourceTemplate with
  list/complete callbacks and a cacheHint) and registerPrompt (completable
  args).
- telemetry.ts: a bounded ring buffer of {tool, ok, errorCode, durationMs, era,
  ts}, never arguments or results, with summary(). Optional OTLP/JSON export
  that honors the inbound traceparent, with unref'd timers and flush().
- logger.ts: Error-aware serialization (name, message, stack, cause); text or
  json format; every console method redirected to stderr; an optional rotating
  file sink only under AHK_MCP_LOG_DIR. The existing API stays the same. ACCEPT:
  Tests:
- the envelope probe detects modern era and capabilities on an SDK-client 2026
  request;
- the notifier dedupes identical hashes and reaches both sinks;
- the ring buffer is bounded and holds no arguments;
- the logger prints an Error's message and stack;
- console.info and console.debug never write to stdout.

## WP07 AutoHotkey runtime resolution, capability probe and run manager [deps: WP03] breaking=false

FILES: src/core/ahk-runtime.ts, src/core/run-manager.ts,
src/core/window-detect.ts, scripts/ahk/window-detect.ahk,
scripts/ahk/version-probe.ahk, Tests/unit/runtime/ahk-runtime.test.ts,
Tests/unit/runtime/run-manager.test.ts

- ahk-runtime:
  - resolve the script runtime and the fork runtime separately, from operator
    config/env, %ProgramFiles%, LOCALAPPDATA/Programs and PATH, never cwd;
  - probe each once with a bounded timeout, for its version and features
    (/Validate; fork-only Eval/UIA);
  - expose the capabilities used for toolset gating.
- run-manager:
  - switches go before the script path (/ErrorStdOut=utf-8, /Validate,
    /Debug=host:port);
  - output is decoded with StringDecoder into bounded buffers;
  - a runId (UUID) registry, retained for 30 minutes after exit;
  - timeout, cancel and stop return the partial output and kill the process
    tree;
  - optional wait for a startup line;
  - AbortSignal support and a per-toolset concurrency cap.
- window-detect: one AutoHotkey helper that waits for a PID's windows
  (optionally filtered by title or class) and returns [{hwnd, title,
  className}]. No PowerShell polling. ACCEPT: Fake-spawn tests cover exit codes,
  partial output on timeout, tree kill on cancel and timeout, runId expiry, and
  chunk-split UTF-8. On the Windows AutoHotkey job, the probe reports the
  version and /Validate returns exit codes 0 and 2.

## WP08 ToolSpec contract and registry pipeline [deps: WP05,WP06] breaking=false

FILES: src/tooling/tool-spec.ts, src/tooling/registry.ts,
src/tooling/results.ts, src/tooling/errors.ts, src/tooling/toolsets.ts,
src/tooling/concurrency.ts, src/tooling/request-context.ts,
src/tooling/progress.ts, Tests/unit/tooling/registry.test.ts,
Tests/unit/tooling/results.test.ts, Tests/unit/tooling/progress.test.ts
Implement defineTool/ToolSpec and the registry's list() and call() exactly as
specified in infraRefactor:

- precomputed JSON Schema 2020-12 with additionalProperties:false
- toolset, read-only and capability filtering
- code-unit sort
- -32602 for unknown tools
- the task gate
- strict safeParse, returning isError on failure
- the path gate, including a grant through InputRequiredResult
- the resolveInputs hook
- the concurrency guard
- per-tool timeout and abort
- a single ToolError formatter
- compact text rendering and AHK_MCP_TEXT_MIRROR
- output validation
- projectCallToolResult
- telemetry and fileTouched
- monotonic per-request progress, where token 0 is valid ACCEPT: Contract tests
  with two fake tools over InMemoryTransport, in both eras:
- bad input gives isError with the issue paths;
- an unknown tool gives -32602;
- output drift is caught;
- cancellation aborts the handler;
- a timeout gives TOOL_TIMEOUT marked retryable;
- an out-of-root path gives input_required when the request declares
  elicitation, and isError otherwise;
- progress is strictly increasing;
- tools/list is byte-identical across calls.

## WP10 AHK_Check and validation engines [deps: WP07,WP08] breaking=false

FILES: src/analysis/diagnostic.ts, src/analysis/engines/autohotkey-validate.ts,
src/analysis/engines/thqby-lsp.ts, src/analysis/engines/rules.ts,
src/analysis/check-cache.ts, src/tools/analysis/check.ts,
Tests/unit/analysis/check.test.ts, Tests/ahk/analysis/**,
Tests/fixtures/analysis/**

- One Diagnostic type with 1-based positions.
- autohotkey-validate:
  - runs /Validate /ErrorStdOut=utf-8 on the real path, so includes and
    A_ScriptDir resolve and nothing executes;
  - parses the 'file (N) : ==> msg' format plus 'Specifically:';
  - inline code is validated through a server temp file, with a note that
    relative includes can't resolve.
- thqby-lsp: one persistent session per workspace (didOpen/didChange;
  publishDiagnostics collected with a settle timeout; documentSymbol exposed for
  AHK_Outline). Auto-discovers the VS Code extension, honors abort, and reports
  itself unavailable instead of failing.
- rules: a small v1-to-v2 migration set with stable codes (AHK1xxx) and exact
  ranges. Fixes are expressed as AHK_File_Edit ops. Style rules are opt-in, at
  info level.
- Cache key: {engine, exe version, path, mtimes across the include closure}. One
  engine's result is never served for another.
- AHK_Check follows the targetToolSurface entry. ACCEPT: On the golden corpus,
  every audit false-positive sample produces zero errors, and invalid samples
  produce the expected line. With AutoHotkey missing, engines[] shows it as
  unavailable and valid is null. Output validates against the schema.

## WP11 AHK_Outline and parser [deps: WP08,WP10] breaking=false

FILES: src/analysis/parser/ahk-parse.ts,
src/analysis/parser/include-resolver.ts, src/tools/analysis/outline.ts,
Tests/unit/analysis/outline.test.ts Port src/tools/ahk-parse-ast.ts to
src/analysis/parser; the old file and its test are deleted in WP32. Parser
fixes:

- 1-based lines everywhere;
- ESM fs imports, which fixes the swallowed require() that breaks <Lib>;
- Lib precedence: the script's Lib folder, then the user's
  Documents/AutoHotkey/Lib via the known folder, then the install Lib;
- Allman braces and fat-arrow functions are recognized;
- control-flow keywords are not reported as functions;
- methods and properties carry static flags and parameters. AHK_Outline uses
  thqby documentSymbol from WP10 when available, falls back to the parser
  otherwise, and reports which engine it used. ACCEPT: The ported tests pass,
  plus new cases: Allman braces, fat arrow, if with parentheses, and a resolved
  #Include <MyLib>. Output validates against the schema.

## WP12 AHK_File_Edit and edit engine [deps: WP08,WP10] breaking=false

FILES: src/tools/files/edit.ts, src/core/fs/edit-engine.ts,
Tests/unit/tools/file-edit.test.ts, Tests/ahk/file-edit/**,
Tests/fixtures/edit/** A single editor, per the targetToolSurface entry:

- ordered edits run on the LF-normalized buffer and are written once, all or
  nothing;
- str_replace must match exactly once; with 0 or several matches it returns
  isError listing the match lines;
- line operations take integer bounds of at least 1;
- apply_patch uses jsdiff with fuzz;
- expectedSha256 precondition;
- dryRun runs the same code path as apply and returns the real diff;
- validate runs WP10's /Validate on the would-be content and blocks the write on
  errors;
- backups are byte-exact. There is no regex mode, no runAfter, no auto-open, no
  active-file fallback and no alpha fork. ACCEPT: - A multi-line LF oldText
  matches in a CRLF file.
- UTF-8-BOM and UTF-16LE files round-trip.
- An ambiguous match is rejected.
- dryRun's diff equals the applied diff.
- A stale sha is rejected.
- A partial failure writes nothing.
- On the Windows AutoHotkey job, validate blocks a breaking edit.

## WP13 File read, list, create and open tools [deps: WP08,WP11] breaking=false

FILES: src/tools/files/view.ts, src/tools/files/list.ts,
src/tools/files/create.ts, src/tools/files/vscode-open.ts,
Tests/unit/tools/files-read.test.ts Implement AHK_File_View, AHK_File_List,
AHK_File_Create and AHK_VSCode_Open per their targetToolSurface entries:

- path is resolved literally, with no fuzzy search, and read through text-codec;
- View reports range, truncation, nextStartLine, sha256 and encoding; include
  ['outline'] uses the WP11 parser;
- List absorbs Recent through sortBy modified, returns the allowed roots when no
  directory is given, uses an opaque cursor with hasMore, and treats ['*'] as
  every allowed extension;
- Create refuses an existing file with isError pointing to AHK_File_Edit, writes
  through safe-write, and supports dryRun;
- VSCode_Open has no wait option. No active-file state anywhere. ACCEPT: - Every
  success validates against its schema.
- A 5,000-line view reports truncated and nextStartLine.
- sortBy modified orders by mtime.
- Create on an existing file returns isError.
- Out-of-root paths are rejected by the registry gate, with no tool-level fs
  call.

## WP14 AHK_Run, AHK_Process and the runs resource [deps: WP07,WP08] breaking=false

FILES: src/tools/run/run.ts, src/tools/run/process.ts, src/resources/runs.ts,
Tests/unit/tools/run.test.ts, Tests/ahk/run/\*\* AHK_Run runs on run-manager and
takes path or code:

- code runs from a server temp dir;
- the per-tool timeout is timeoutMs plus a grace period, and the description
  points long runs to background or task mode;
- waitForWindow uses window-detect;
- a background run can wait for a startup line;
- statuses carry partial output, and timeouts or failures set isError;
- /ErrorStdOut errors are parsed;
- stdout and stderr are sanitized and capped. AHK_Process supports list, status,
  output (since) and stop, with isError for unknown or expired runIds. The
  ahk://runs/{runId} template publishes resourceUpdated through the
  ChangeNotifier on output and on exit. No runner, ahkPath or watch parameters.
  ACCEPT: - Fake-spawn tests cover every status.
- The flow background run → AHK_Process output → stop works.
- An expired runId returns isError.
- The runs resource can be read, and it updates.
- Outputs validate against the schemas.
- The annotation snapshot shows destructive and openWorld.

## WP15 AHK_Eval sessions [deps: WP07,WP08] breaking=false

FILES: src/tools/run/eval.ts, src/core/repl-session.ts,
scripts/repl-host-v3.ahk, Tests/unit/tools/eval.test.ts

- Session handles: omit session to create one. The 15-minute idle expiry is
  stated in the description; an unknown or expired session returns isError.
- A reset flag replaces AHK_Repl_Reset.
- Errors and timeouts set isError, and a timeout respawns the host.
- Output schema per the targetToolSurface entry.
- Prefer persistent host-side state over replaying the history. If replay
  remains, cap it and state the replay semantics in the description.
- Requires the fork capability; the tool is hidden when it's missing.
- New host script; the old repl-host.ahk is deleted in WP32. ACCEPT: Fake-host
  tests cover:
- create, reuse, expire and reset;
- an error returns isError;
- a timeout returns isError and respawns the host;
- without the fork, the tool is not listed.

## WP16 AHK_Debug over DBGp; DAP as its own entry point [deps: WP07,WP08] breaking=false

FILES: src/tools/debug/debug.ts, src/debug/dbgp-session.ts,
src/dap/dap-server.ts, src/dap/dap-session.ts, src/dap/index.ts,
src/dap/main.ts, src/dap/translator.ts, src/dap/types.ts,
Tests/unit/debug/dbgp-session.test.ts, Tests/integration/dap-session.test.ts,
docs/dap.md New DBGp session:

- listens on an ephemeral loopback port;
- launches AutoHotkey /ErrorStdOut /Debug=127.0.0.1:<port> <script> through
  run-manager;
- sets exception breakpoints;
- turns <error> elements into errors;
- continue/step return after waitMs;
- commands honor abort;
- variables come back as full property trees;
- sessionId handles expire when idle. AHK_Debug actions follow the
  targetToolSurface entry, with runtime conditional validation. get_source,
  apply_fix and analyze_error are removed. The DAP adapter moves to
  src/dap/main.ts and uses the new session; WP30 wires the bin and removes the
  in-process AHK_DAP_ENABLED hook. ACCEPT: Fake-socket tests:
- an exception break is reported with message, file and line;
- an <error code> response becomes isError;
- continue returns 'running' after waitMs;
- stop kills the process tree. The DAP suite passes against the new session.

## WP17 Docs corpus, AHK_Doc_Search, docs and guides resources [deps: WP08] breaking=false

FILES: scripts/build-docs-corpus.mjs, data/ahk-v2-docs.json, data/modules/\*.md,
src/docs/corpus.ts, src/docs/search-index.ts, src/docs/guides.ts,
src/tools/docs/doc-search.ts, src/resources/docs.ts, src/resources/guides.ts,
Tests/unit/docs/\*\*

- A deterministic generator produces a v2-only corpus from the official v2
  documentation source; this is pending the licensing question. Each entry has
  kind, name, parent, signature, params, returns, a one-line summary, examples,
  a canonical autohotkey.com/docs/v2 URL and a version stamp. The output is
  committed.
- Copy docs/Modules into data/modules with agent frontmatter stripped, fences
  fixed and the object-literal advice corrected. Chunk guides by heading, at
  most 2 KB per chunk.
- One FlexSearch index covers reference entries and guide sections, with stable
  ids.
- AHK_Doc_Search follows the targetToolSurface entry and returns resource_link
  blocks.
- Resources: ahk://docs/index, ahk://guides/index, and the templates
  ahk://docs/{kind}/{name} and ahk://guides/{topic}, each with list and
  completion. A miss throws ResourceNotFoundError. Long public cache hints.
  ACCEPT: - Map, Array.Push, WinGetList, StrReplace and CallbackCreate each
  return a top hit.
- StringReplace, SetBatchLines and IfWinExist return no reference hits.
- Every id round-trips through its resource URI.
- An unknown URI returns -32602 with data.uri.
- In detailed mode, guide hits are at most 2 KB each.

## WP18 Library catalog, AHK_Library_Search and AHK_Library_Info [deps: WP08,WP11] breaking=false

FILES: src/library/catalog.ts, src/library/scanner.ts, src/library/extractor.ts,
src/library/resolver.ts, src/library/lib-paths.ts,
src/tools/docs/library-search.ts, src/tools/docs/library-info.ts,
Tests/unit/library/\*\*, Tests/unit/dependency-resolver.test.ts,
Tests/unit/metadata-extractor.test.ts, Tests/unit/library-scanner.test.ts,
Tests/unit/library-catalog.test.ts, Tests/unit/run-library-tests.mjs One shared
catalog:

- follows AutoHotkey Lib precedence plus the allowed roots;
- records shadowed duplicates deterministically (shadowedBy);
- invalidates by mtime, or on the refresh flag;
- reports the paths it failed to scan. Symbols come from the WP11 parser.
  #Include parsing handles \*i, quoted paths, %A_ScriptDir%/%A_LineFile% and
  skips comments. Import order is a DFS post-order over the target's reachable
  subgraph, with cycles reported only inside that subgraph. Scores are
  normalized to 0-1, default threshold 0.6. Both tools follow their
  targetToolSurface entries. Info absorbs Import, and 'relative' is computed
  against relativeTo. Replace the vitest suites with jest suites. ACCEPT:
  End-to-end on a temp Lib dir:
- a Search hit leads to Info, whose includeLines are in dependency order;
- an unrelated cycle does not block the import;
- method search finds a class method;
- scores are at most 1;
- not-found returns isError with suggestions.

## WP19 UIA family as AHK*UIA*\* [deps: WP07,WP08] breaking=false

FILES: src/tools/uia/uia-tools.ts, src/core/uia-inspector.ts,
src/core/uia-selector-validator.ts, inspector/uia_inspect.ahk,
inspector/uia_props.ahk, inspector/uia_snippet.ahk, inspector/uia_paths.ahk,
inspector/uia_daemon.ahk, inspector/json.ahk, scripts/uia-cli.mjs,
scripts/validate-uia-selectors.mjs, Tests/uia/\*,
Tests/unit/uia-selector-validator.test.ts, docs/UIA_INSPECTION.md Re-express the
six tools as five ToolSpecs, with uia_highlight merged into AHK_UIA_Element as
highlightMs:

- typed output schemas: window items, match items, a nullable rect, a patterns
  object;
- openWorldHint true;
- requires the fork capability;
- StringDecoder for inspector stdout;
- SafeRect emits null instead of an empty string. Keep the uia-inspector API
  backward compatible until WP32 deletes the old tool file. Update the e2e and
  golden scripts and the docs to the new names. ACCEPT: Golden inspector outputs
  validate against every outputSchema. The e2e script passes with the AHK*UIA*\*
  names on a machine with the fork. highlightMs 0 draws nothing.

## WP20 AHK_Status, status/workspace/snippet resources, prompts, completions, MCP App [deps: WP07,WP08,WP17] breaking=false

FILES: src/tools/server/status.ts, src/resources/server-status.ts,
src/resources/workspace-recent.ts, src/resources/snippets.ts,
src/resources/apps.ts, src/core/mcp-apps.ts, data/snippets/_.ahk,
src/prompts/_.ts, Tests/unit/prompts/**, Tests/unit/resources/**,
Tests/ahk/snippets/\*\*

- AHK_Status, with the MCP App renamed to ui://ahk/status-dashboard and rendered
  from AHK_Status results.
- ahk://server/status: ttl 0, private, subscribable.
- ahk://workspace/recent: an MRU list fed by fileTouched events.
- The fixed snippets are served as ahk://snippets/{name}.
- The six curated prompts, with titles and completable typed arguments.
- Completion only for declared arguments and variables; -32602 for unknown refs.
  All of this follows the resourcesAndPromptsPlan. ACCEPT: - Every snippet
  passes /Validate on the Windows AutoHotkey job.
- A missing required prompt argument and an unknown prompt both return -32602.
- Completion returns prefix matches, and nothing for undeclared refs.
- AHK_Status output validates against its schema.
- \_meta.ui is present only when the request declares the MCP Apps extension.

## WP21 Compat layer: legacy aliases, ChatGPT search/fetch, tool discovery [deps: WP10,WP11,WP12,WP13,WP14,WP15,WP16,WP17,WP18,WP19,WP20] breaking=false

FILES: src/tools/compat/chatgpt.ts, src/tools/compat/tools-search.ts,
src/tooling/legacy-aliases.ts, Tests/unit/compat/\*\*

- search and fetch, only with AHK_MCP_CHATGPT_COMPAT=1. search returns
  {results:[{id,title,url}]} as JSON text plus structuredContent. fetch looks up
  an exact id and returns isError when it is missing.
- AHK_Tools_Search, only with AHK_MCP_TOOL_DISCOVERY=1.
- A legacy alias table covering every removed or renamed tool, enabled by
  AHK_MCP_LEGACY_TOOL_NAMES=1. Argument adapters cover the common v2 shapes:
  - AHK_File_Edit action/search/newContent/all;
  - AHK_File_Edit_Small find/replace;
  - Diagnostics, Lint and Analyze with code|filePath;
  - the uia\_\* names;
  - Library_Import;
  - Repl_Reset. Aliases are listed as deprecated and carry the target's
    annotations. ACCEPT: With the flags off, none of these are listed. Each
    alias turns a recorded v2 call into an equivalent new call. Legacy arguments
    that can't be mapped return isError naming the new parameters.

## WP30 Integration: composition root on the new registry [deps: WP02,WP04,WP21] breaking=true

FILES: src/server.ts, src/server/create-server.ts, src/server/capabilities.ts,
src/server/tasks.ts, src/server/stdio.ts, src/server/http.ts,
src/tools/index.ts, src/resources/index.ts, src/prompts/index.ts, src/index.ts,
src/core/client-roots.ts, src/core/tool-metadata.ts, src/core/tool-registry.ts,
src/core/server-interface.ts, src/core/tool-settings.ts, package.json,
scripts/smoke-mcp.js, scripts/smoke-mcp-2026.js, scripts/smoke-http-mcp.js,
Tests/contract/mcp-surface.test.ts, Tests/contract/**snapshots**/\*\* The only
package that edits hot files in v3. Changes:

- Rewrite server.ts as the composition root: an McpServer for prompts,
  resources, completion and cache hints, whose underlying Server hosts the
  registry's tools/list and tools/call plus legacy tasks (principal-scoped).
- A single capabilities/identity/instructions/card source.
- Client roots are era-aware.
- Wire the ChangeNotifier to the stdio handle and to createMcpHandler().notify;
  keep {notify, close}.
- Evaluate toolsets, read-only mode and the runtime probe before serving.
- stdio gets onerror. unhandledRejection logs instead of exiting. Shutdown
  closes handles and flushes telemetry, with a forced-exit timer.
- Move the HTTP code verbatim into src/server/http.ts for WP31.
- Non-HTTP code must no longer import tool-analytics, tracing or opentelemetry.
- Delete tool-metadata.ts, tool-registry.ts, server-interface.ts and
  tool-settings.ts. Warn once if a v2 tool-settings.json exists.
- Add the ahk-mcp and ahk-mcp-dap bins.
- Update the smoke scripts to the 20-tool surface. ACCEPT: The contract suite
  passes in both eras:
- exactly the 20 target tools by default;
- the invariants and annotation snapshot hold;
- no description names an unlisted tool;
- tools/list is unchanged after every call;
- -32602 for unknown tools; isError for invalid input;
- cancellation aborts the handler;
- the resources, prompts and completion contracts pass. smoke:mcp,
  smoke:mcp:2026 and smoke:http pass.

## WP31 HTTP transport hardening and observability consolidation [deps: WP30] breaking=true

FILES: src/server/http.ts, src/core/observability-server.ts,
src/core/tool-analytics.ts, src/core/tracing.ts, src/core/opentelemetry.ts,
src/dashboard.ts, src/studio/create-studio.ts, src/studio/studio-http.ts,
Dockerfile, docker-compose.yml, .env.docker.example, .dockerignore,
Tests/integration/http-transport.test.ts,
Tests/integration/studio-server.test.ts, Tests/unit/dashboard-html.test.ts Auth
and access:

- Require the auth token when the allowed hosts or origins contain non-loopback
  names, unless AHK_MCP_ALLOW_INSECURE_REMOTE=1.
- Treat [::1] and 127.0.0.0/8 as loopback.
- Tokens of at least 32 bytes, compared as SHA-256 digests with timingSafeEqual;
  the Bearer scheme is case-insensitive.
- Log the effective auth posture at startup.
- Tasks are bound to the auth principal. JSON-RPC and routes:
- -32700 for parse errors; JSON-RPC bodies for 413 and 429, with Retry-After.
- Task polling is exempt from the limiter; buckets are per principal.
- Delete the custom routing-header validation.
- GET /healthz, checked against Host, before auth.
- Security headers.
- JSON 410 for /sse and /messages.
- Drop the urlencoded parser and the duplicate Studio boundary mount.
  Observability:
- Serve the observability and dashboard routes from the main app, behind auth,
  reading the telemetry ring buffer.
- Delete the standalone observability server, tool-analytics, tracing and
  opentelemetry; they are replaced by src/tooling/telemetry.ts.
- Escape all dashboard fields. Other:
- Load Studio assets from the package directory, not cwd.
- closeIdleConnections/closeAllConnections on shutdown. Docker: publish on
  127.0.0.1, /healthz, --http, `npm ci --omit=dev --ignore-scripts`, allowed
  hosts and origins from env, and a note that execution tools are unavailable in
  Linux containers. ACCEPT: Integration tests cover each rule:
- a remote host without a token is refused at startup;
- a parse error returns -32700;
- a 429 response has a JSON-RPC body;
- /healthz returns 200 without auth;
- a header mismatch returns the SDK's -32020. The docker compose healthcheck is
  healthy.

## WP32 Legacy sweep and lint tightening [deps: WP30] breaking=false

FILES: src/tools/ahk-_.ts (all remaining v2 tool modules),
src/tools/uia-tools.ts, src/core/active-file.ts, src/core/check-cache.ts,
src/core/claude-standards.ts, src/core/config.ts, src/core/dbgp-client.ts,
src/core/dependency-resolver.ts, src/core/elicitation.ts,
src/core/error-response-builder.ts, src/core/error-types.ts,
src/core/friendly-logger.ts, src/core/library-catalog.ts,
src/core/library-scanner.ts, src/core/linting/_, src/core/loader.ts,
src/core/mcp-request-context.ts, src/core/metadata-extractor.ts,
src/core/orchestration-context.ts, src/core/orchestration-engine.ts,
src/core/parameter-aliases.ts, src/core/parser.ts,
src/core/path-converter-config.ts, src/core/path-interceptor.ts,
src/core/process-manager.ts, src/core/progress-notifier.ts,
src/core/resource-subscriptions.ts, src/core/tool-categories.ts,
src/core/unified-logger.ts, src/core/validation-middleware.ts, src/compiler/_,
src/lsp/_, src/debug-journal.ts, src/repl.ts, src/utils/dry-run-preview.ts,
src/utils/path-converter.ts, src/utils/response-helpers.ts,
src/utils/thqby-lsp-client.ts, src/types/mcp-types.ts, src/types/tool-types.ts,
scripts/repl-host.ahk, data/ahk_index.json, data/ahk_documentation_index.json,
data/ahk_structure.csv, data/ahk_documentation_full.json, docs/Modules/\*,
code-execution/\*\*, scripts/generate-code-exec-wrappers.ts,
scripts/test-mcp-run.js, scripts/setup-dev.js,
scripts/build-portable-runtime.mjs, Tests/portable-runtime.test.mjs,
Tests/unit/ahk-parse-ast.test.ts, Tests/unit/check-cache.test.ts,
Tests/unit/dry-run-preview.test.ts, Tests/unit/parameter-aliases.test.ts,
Tests/unit/progress-notifier.test.ts, Tests/unit/vscode-open.test.ts,
Tests/contract/dry-run-output.test.ts, Tests/contract/parameter-aliases.test.ts,
Tests/integration/backward-compat.test.ts,
Tests/integration/edit-dryrun.test.ts, jest.config.cjs, .eslintrc.cjs,
.eslint.maintained.ignore, tsconfig.json, .claude/hooks/run-after-edit.py

- Delete every file in this list that has no remaining importer after WP30. Keep
  anything a new module still imports, and verify with an import-graph check.
- Slim config.ts down to operator helpers, or delete it.
- Remove the remaining 'zod/v3' imports; the target is none.
- Remove the jest quarantine entries.
- Drop the maintained-ignore file and fix full-scope lint.
- Enable noUnusedLocals and noUnusedParameters.
- Add ESLint bans on console.\* and on direct fs write APIs under src/tools;
  src/core/fs/safe-write.ts is the only allowed writer.
- Update the repo's PostToolUse hook matcher to AHK*File*(Edit|Create).
- Update the portable launcher to the renamed env vars. ACCEPT: - No unreachable
  src files remain.
- `rg "from 'zod/v3'"` finds nothing.
- Full-scope lint is clean.
- Build, tests, both smoke scripts and the portable test pass.
- The PR records dist size and tools/list bytes.

## WP40 Documentation, security model, repo clutter [deps: WP31,WP32] breaking=false

FILES: README.md, SECURITY.md, AGENTS.md, CLAUDE.md, CONTRIBUTING.md, LICENSE,
docs/** (except CONFIGURATION.md, dap.md, UIA_INSPECTION.md),
scripts/gen-tools-docs.mjs, HANDOFFahkeval.md, YOLO.md, TEST-MCP-FIXES.md,
Diagram.png, Diagram2.png, demos/**, monitoring/**, extension/**, specs/**,
struct_breakdown/**, evals/\*\*, .prettierrc.js, .lintstagedrc.js,
.lintstagedrc.cjs, .mcp.example.json, .mcp.json.example, .mcp.windows.json

- README: Node 20+, stdio and HTTP setup with the new env names, toolsets and
  read-only mode, the 20 tools, no legacy SSE claim.
- SECURITY.md as a threat model:
  - trust model for stdio vs HTTP;
  - token posture, and the Host/Origin allowlists;
  - containment scope and its limit: AHK_Run and AHK_Eval execute arbitrary
    code, so host approval is the gate;
  - the DAP token, and what observability exposes;
  - a reporting contact.
- AGENTS.md becomes canonical, with a repository layout section. CLAUDE.md
  becomes a pointer plus the Claude-specific and privacy rules. CONTRIBUTING.md
  matches the real scripts.
- Generate docs/TOOLS.md from the registry and docs/MIGRATION-v3.md from the
  alias table.
- Archive the plans, specs and summaries; delete docs/implementation/\*.ts.
- Remove root clutter and duplicate configs.
- Add LICENSE as the owner decides. ACCEPT: - docs:check fails on any AHK*\* or
  uia*\* name that isn't in the registry, except in MIGRATION-v3.md.
- The README quick start works on a clean machine over stdio and HTTP.
- The privacy scan is clean.

## WP41 Release 3.0.0 [deps: WP40] breaking=false

FILES: package.json, package-lock.json, CHANGELOG.md,
.github/workflows/release.yml

- Bump to 3.0.0, with the package name as the owner decides.
- A CHANGELOG listing the breaking changes, with the migration table.
- A tag-triggered release workflow that publishes with npm provenance.
- CI asserts the npm pack whitelist.
- Purge the screenshot from history only if the owner approved it. ACCEPT: - npm
  pack contents match the whitelist.
- A dry-run release from a tag succeeds.
- The installed package runs `npx ahk-mcp` over stdio and passes both smoke
  scripts.
