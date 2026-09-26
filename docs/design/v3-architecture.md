# ahk-mcp v3 architecture

This is the design contract for the v3 redesign. It comes from a 9-area audit of
v2: 191 findings, and all 60 critical/high ones were independently re-verified.
Every implementation package works against this document. If code and this
document disagree, fix the code, or update this document in the same change and
explain why.

## Owner decisions (binding)

| Topic             | Decision                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope             | Full v3 redesign. 43 tools become the ~20 consolidated `AHK_*` tools below. Old names are available only through the opt-in legacy alias layer (`AHK_MCP_LEGACY_TOOL_NAMES=1`). Released as 3.0.0.                                                                             |
| Optional surfaces | **Keep and harden** all four: Streamable HTTP transport (ChatGPT `search`/`fetch` only with `AHK_MCP_CHATGPT_COMPAT=1`), Macro Studio (`src/studio/*`), the DAP adapter (its own entry point, token-gated), and observability/dashboard (see below). None of these is deleted. |
| Active file       | **Removed.** Every tool takes an explicit `path`. The in-memory `ahk://workspace/recent` resource replaces recall. Nothing persists an "active file" to disk.                                                                                                                  |
| Git               | Work on branch `feat/v3-sota`. Commit each milestone as `TrueCrimeAudit <TrueCrimeAudit@users.noreply.github.com>` using Conventional Commits. No push, no history rewrite.                                                                                                    |

### Implementation defaults (chosen by the lead; revisit only with evidence)

- **Observability.** The standalone observability server becomes **opt-in**
  (`AHK_MCP_OBSERVABILITY=1`); v2 bound port 9090 on every stdio launch. It
  binds to loopback, checks Host, and requires a token when bound to a
  non-loopback address. In HTTP mode, `/dashboard`, `/traces` and `/metrics` are
  also served from the main app behind its auth. Both read the single telemetry
  ring buffer (`src/tooling/telemetry.ts`). `/metrics` is Prometheus text
  generated from that buffer, which keeps `prom-client` a live dependency.
  Dashboard fields are HTML-escaped. Telemetry never stores tool arguments or
  results.
- **Editing.** The regex edit mode is **dropped** because of ReDoS on the event
  loop. `str_replace` (with explicit `replaceAll`), line operations,
  append/prepend and unified-diff `apply_patch` cover the same needs.
- **Docs corpus.** Bundled data under `data/` is re-indexed so every entry is
  searchable. At runtime, if the thqby `vscode-autohotkey2-lsp` extension is
  installed (auto-discovered under the VS Code extensions dir, or
  `AHK_MCP_THQBY_PATH`), its `syntaxes/ahk2.d.ahk` signatures and doc comments
  augment the corpus in memory. That LGPL data is **never copied into this
  repository or the npm package**. Nothing is fetched from the network.
- **Fork-only tools** (`AHK_Eval`, `AHK_UIA_*`, which need the v2.1-alpha
  Console fork). They are always listed, so tools/list stays deterministic and
  needs no startup probe. When the fork is missing they return an `UNAVAILABLE`
  isError telling the user how to configure `AHK_MCP_FORK_AHK_PATH`.
  `AHK_Status` reports capability state.
- **Out-of-root paths** return an isError `PATH_NOT_ALLOWED` that lists the
  allowed roots. There are no elicitation-based folder grants: the model must
  not be able to talk its way into a wider sandbox. Roots are client roots ∪
  operator config/env ∪ guarded cwd.
- **Default posture.** All toolsets are enabled over stdio.
  `AHK_MCP_READ_ONLY=1` hides every tool that is not `readOnlyHint:true`. HTTP
  refuses to start with non-loopback hosts or origins unless
  `AHK_MCP_AUTH_TOKEN` is set.
- **License.** Add an MIT `LICENSE` ("ahk-mcp contributors"), matching the
  README's existing MIT claim. The package name stays `ahk-server-v2`, with
  `bin` entries `ahk-mcp` and `ahk-mcp-dap`.
- **Privacy.** Remove tracked root screenshots going forward only. Commits, code
  and docs never name personal handles, usernames or absolute local paths.

## Delivery phases (as executed)

The v2 "2.x hotfix" packages are **not** built separately. Their fixes and
regression tests fold into the v3 packages, because the v2 dispatcher is
replaced.

1. **Foundation.** WP01 (privacy stop-gap, zod 4, dead-code purge, package
   metadata), then WP02 (green test harness, CI) ∥ WP03 (operator config) ∥ WP04
   (legacy tasks), then WP05 (fs primitives, path policy v3) ∥ WP06
   (era/notifier/specs/logging/telemetry) ∥ WP07 (runtime probe, run manager),
   then WP08 (ToolSpec and registry pipeline).
2. **Tools.** WP10 AHK_Check ∥ WP14 AHK_Run/Process ∥ WP15 AHK_Eval ∥ WP16
   AHK_Debug + DAP hardening ∥ WP17 docs ∥ WP19 UIA, then WP11 Outline ∥ WP12
   Edit ∥ WP20 Status/resources/prompts, then WP13 file view/list/create/open ∥
   WP18 library, then WP21 compat layer.
3. **Integration.** WP30 composition root (the only package that edits hot
   files), then WP31 HTTP and observability hardening ∥ WP32 legacy sweep, then
   WP40 docs and clutter, then WP41 3.0.0 version and changelog (no publish).
4. **Review.** Multi-lens review, adversarial verification, fix loop.

## Target tool surface (default toolsets)

| Tool                   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Replaces                                                                                                                                                                                 | Annotations                                                                         | Task support |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------ |
| `AHK_File_View`        | Read a window of lines from a text file inside the allowed roots. Returns line numbers, sha256 and encoding, and optionally an outline. Use before editing, and pass the sha256 to AHK_File_Edit as expectedSha256. Do not use to find files (AHK_File_List) or to check code (AHK_Check).                                                                                                                                                                                                                                                         | AHK_File_View (v2), AHK_File_Active get preview, AHK_Smart_Orchestrator view step                                                                                                        | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false  | forbidden    |
| `AHK_File_List`        | Find files. Lists a directory recursively with a glob or name pattern and an extension filter, sorted by name or by modification time. With no directory, returns the allowed roots. Use to find scripts or recently changed files. Do not use to read content.                                                                                                                                                                                                                                                                                    | AHK_File_List (v2), AHK_File_Recent, AHK_File_Detect                                                                                                                                     | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false  | forbidden    |
| `AHK_File_Edit`        | Apply 1-50 edits to an existing file as one atomic change. Supported edits: exact str_replace (must match exactly once unless replaceAll is set), replace/insert/delete of line ranges, append/prepend, or a unified-diff patch. Keeps charset, BOM and line endings, and writes a byte-exact backup. Honors an optional expectedSha256 precondition. dryRun returns the exact diff. validate runs AutoHotkey /Validate on the result without executing it and refuses to write if there are errors. Do not use to create files (AHK_File_Create). | AHK_File_Edit (v2), AHK_File_Edit_Small, AHK_File_Edit_Diff, AHK_File_Edit_Advanced, AHK_Lint autoFix, AHK_LSP fix mode, AHK_Debug_DBGp apply_fix, AHK_Workflow_Analyze_Fix_Run fix step | readOnlyHint=false, destructiveHint=true, idempotentHint=false, openWorldHint=false | forbidden    |
| `AHK_File_Create`      | Create a new file with the given content. Refuses to overwrite an existing file; use AHK_File_Edit for those.                                                                                                                                                                                                                                                                                                                                                                                                                                      | AHK_File_Create (v2), AHK_File_Edit action 'create'                                                                                                                                      | readOnlyHint=false, destructiveHint=false, idempotentHint=true, openWorldHint=false | forbidden    |
| `AHK_VSCode_Open`      | Open a file in the user's VS Code, optionally at a line and column. A convenience for the human only; never needed to read or edit a file.                                                                                                                                                                                                                                                                                                                                                                                                         | AHK_VSCode_Open (v2), auto-open side effect of the edit/create tools                                                                                                                     | readOnlyHint=false, destructiveHint=false, idempotentHint=true, openWorldHint=false | forbidden    |
| `AHK_Check`            | Check AutoHotkey v2 code without running it. Sources: AutoHotkey /Validate (authoritative load and syntax errors, including #Include), thqby LSP diagnostics when installed, and opt-in v1-to-v2 migration rules. Returns 1-based diagnostics with stable codes and optional fixes written as AHK_File_Edit edits. Use before AHK_Run and after edits. If an engine is unavailable it is reported as unavailable, never as 'no issues'.                                                                                                            | AHK_Diagnostics, AHK_Analyze, AHK_LSP, AHK_Lint, AHK_Cloud_Validate (validation), AHK_VSCode_Problems                                                                                    | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false  | optional     |
| `AHK_Outline`          | Structural map of a script with 1-based line ranges: #Requires, #Include (resolved), classes with their methods and properties, functions with parameters, hotkeys/hotstrings and labels. Can follow includes. Use it to navigate, then read the ranges you need with AHK_File_View.                                                                                                                                                                                                                                                               | AHK_THQBY_Document_Symbols, ahk-parse-ast, AHK_Lint structure map, AHK_Smart_Orchestrator entity lookup, AHK_File_View outline mode                                                      | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false  | forbidden    |
| `AHK_Run`              | Run an AutoHotkey v2 script file or inline code with the user's privileges. This has real side effects: hotkeys, GUIs, file and registry changes. 'wait' mode returns the exit code, captured stdout and /ErrorStdOut errors. 'background' mode returns a runId handle for AHK_Process. Run AHK_Check first; use AHK_Eval for single expressions.                                                                                                                                                                                                  | AHK_Run (v2), AHK_Test_Interactive, AHK_Cloud_Validate (execution), AHK_Process_Request (run), edit tools runAfter/autoRunAfterEdit, AHK_Workflow_Analyze_Fix_Run run step               | readOnlyHint=false, destructiveHint=true, idempotentHint=false, openWorldHint=true  | optional     |
| `AHK_Process`          | List, read new output from, or stop scripts that AHK_Run started in background mode. A runId expires 30 minutes after its process exits; unknown or expired ids return an error.                                                                                                                                                                                                                                                                                                                                                                   | AHK_Run watch-mode kill-all, processManager (no model-facing surface in v2)                                                                                                              | readOnlyHint=false, destructiveHint=true, idempotentHint=true, openWorldHint=false  | forbidden    |
| `AHK_Eval`             | Evaluate AutoHotkey v2 expressions in a REPL session. Requires the v2.1-alpha.30+Console fork. Omit session to start one; pass back the returned sessionId to keep variables. Sessions expire after 15 minutes idle, and reset clears state. Expressions have real side effects.                                                                                                                                                                                                                                                                   | AHK_Eval (v2), AHK_Repl_Reset                                                                                                                                                            | readOnlyHint=false, destructiveHint=true, idempotentHint=false, openWorldHint=true  | forbidden    |
| `AHK_Debug`            | Debug a script over DBGp. Launch it under /Debug (breaks on exceptions) or attach to one started by hand. Set and remove breakpoints, continue and step, inspect the stack and variables, evaluate in a frame, and stop. launch and attach return a sessionId that every later call must pass; sessions expire after 30 minutes idle.                                                                                                                                                                                                              | AHK_Debug_DBGp, AHK_Debug_Agent                                                                                                                                                          | readOnlyHint=false, destructiveHint=true, idempotentHint=false, openWorldHint=true  | optional     |
| `AHK_Doc_Search`       | Search the bundled AutoHotkey v2 reference (functions, classes, methods, properties, variables, directives, operators, flow control) and the sections of the v2 guides. Use before writing or reviewing code to confirm a built-in's signature and behavior. Not for user libraries (use AHK_Library_Search).                                                                                                                                                                                                                                      | AHK_Doc_Search (v2), AHK_Context_Injector, AHK_Summary, AHK_Prompts (guide content), AHK_Sampling_Enhancer, search/fetch (default mode)                                                  | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false  | forbidden    |
| `AHK_Library_Search`   | Find user AutoHotkey libraries and their symbols (classes, methods, properties, functions, globals) in the standard Lib folders, using AutoHotkey's precedence order, and in the allowed roots.                                                                                                                                                                                                                                                                                                                                                    | AHK_Library_Search (v2), AHK_Library_List                                                                                                                                                | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false  | forbidden    |
| `AHK_Library_Info`     | Details for one library: its symbols, its dependencies (including missing ones and cycles), and ready-to-paste #Include lines in dependency order.                                                                                                                                                                                                                                                                                                                                                                                                 | AHK_Library_Info (v2), AHK_Library_Import                                                                                                                                                | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false  | forbidden    |
| `AHK_UIA_Windows`      | List top-level windows with their UI Automation identity: hwnd, title, class, pid, process, and visible/minimized/cloaked state. Start here for any UIA work. Reads live content from third-party windows.                                                                                                                                                                                                                                                                                                                                         | uia_windows                                                                                                                                                                              | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true   | forbidden    |
| `AHK_UIA_Tree`         | Compact UI Automation tree of one window, one line per control, with durable @paths. Continue into collapsed subtrees with fromPath.                                                                                                                                                                                                                                                                                                                                                                                                               | uia_tree                                                                                                                                                                                 | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true   | forbidden    |
| `AHK_UIA_Find`         | Rank controls by Name or AutomationId (exact, then prefix, then substring). Returns durable paths and AHK selector snippets that are verified to resolve back to the same element.                                                                                                                                                                                                                                                                                                                                                                 | uia_find                                                                                                                                                                                 | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true   | forbidden    |
| `AHK_UIA_Element`      | Full properties, read-only pattern state and a verified snippet for one element. Can optionally draw a temporary click-through highlight border (highlightMs).                                                                                                                                                                                                                                                                                                                                                                                     | uia_element, uia_highlight                                                                                                                                                               | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true   | forbidden    |
| `AHK_UIA_Under_Cursor` | Identify the element under the mouse pointer, after an optional delay so the user can hover first. Returns the element details, its ancestor chain and a snippet.                                                                                                                                                                                                                                                                                                                                                                                  | uia_under_cursor                                                                                                                                                                         | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=true   | forbidden    |
| `AHK_Status`           | Environment and health report: AutoHotkey runtime and fork paths and versions, whether the thqby LSP is available, allowed roots, enabled toolsets and read-only mode, the docs dataset, and recent tool error statistics. Call it when a tool reports an environment or path error, or to learn where files may be read and written.                                                                                                                                                                                                              | AHK_Config (get), AHK_Settings (get), AHK_Analytics, AHK_Cache_Stats, AHK_Trace_Viewer, ahk://system/info                                                                                | readOnlyHint=true, destructiveHint=false, idempotentHint=true, openWorldHint=false  | forbidden    |

### Key parameters and output shapes

#### AHK_File_View

- **Params:** path (required, literal, gate: read); startLine int>=1 (default
  1); maxLines int 1-2000 (default 200); format 'numbered'|'raw'; include
  ['outline']
- **Output:** { path, totalLines, startLine, endLine, truncated,
  nextStartLine|null, sha256, sizeBytes, modified, encoding:{
  charset:'utf-8'|'utf-16le'|'utf-16be', bom, eol:'crlf'|'lf'|'mixed' },
  content, outline? }

#### AHK_File_List

- **Params:** directory? (gate: read); pattern? (glob, e.g. '\**/*Gui*.ahk');
  extensions? (default ['.ahk']; ['*'] = every allowed extension); recursive
  (default true); maxDepth 1-10; sortBy 'name'|'modified'; limit 1-500 (default
  100); cursor?
- **Output:** { directory|null, roots?: string[], entries:[{ path, name,
  type:'file'|'directory', sizeBytes|null, modified|null }], nextCursor|null,
  searchedDirectories: string[] }

#### AHK_File_Edit

- **Params:** path (required, gate: write); edits[1..50] of {op:'str_replace',
  oldText, newText, replaceAll?} | {op:'replace_lines', startLine, endLine,
  text} | {op:'insert', afterLine (0 = top), text} | {op:'delete_lines',
  startLine, endLine} | {op:'append'|'prepend', text} | {op:'apply_patch',
  patch}; expectedSha256?; dryRun (default false); validate (default false);
  backup (default true). No regex mode, no runAfter, no active-file fallback.
- **Output:** { path, applied, dryRun, sha256Before, sha256After|null, edits:[{
  op, matches, startLine, endLine }], linesBefore, linesAfter, diff,
  diffTruncated, backupPath|null, encoding, validation?:{ valid, diagnostics[]
  }, warnings[] }

#### AHK_File_Create

- **Params:** path (required, gate: write, must not exist); content (required,
  <= 1 MB); eol 'crlf'|'lf' (default crlf); bom (default false);
  createDirectories (default false); dryRun
- **Output:** { path, created, bytesWritten, lines, encoding,
  directoriesCreated[], dryRun }

#### AHK_VSCode_Open

- **Params:** path (required, gate: read); line?; column? (no 'wait')
- **Output:** { path, line|null, column|null, command, launched }

#### AHK_Check

- **Params:** path | code (exactly one; path gate: read, .ahk); engines?
  ['autohotkey','lsp','rules'] (default autohotkey + lsp when available);
  minSeverity 'error'|'warning'|'info' (default 'warning'); limit 1-500 (default
  100); cursor?; responseFormat 'concise'|'detailed'
- **Output:** { path|null, valid: boolean|null, engines:[{ name, available, ran,
  version?, durationMs, reason? }], counts:{ error, warning, info },
  diagnostics:[{ line, column, endLine, endColumn, severity, code, source,
  message, fix?:{ title, edits:[AHK_File_Edit op] } }], truncated,
  nextCursor|null }

#### AHK_Outline

- **Params:** path | code (exactly one); followIncludes (default false); engine
  'auto'|'lsp'|'parser'; responseFormat
- **Output:** { path|null, engine, requires|null, includes:[{ spec,
  resolved|null, line }], classes:[{ name, extends?, startLine, endLine,
  methods:[{ name, params, isStatic, startLine, endLine }], properties:[{ name,
  isStatic, line }] }], functions:[{ name, params:[{ name, optional, byRef,
  variadic, default? }], startLine, endLine }], hotkeys:[{ trigger, kind, line
  }], labels:[{ name, line }], metrics:{ lines, codeLines, commentLines } }

#### AHK_Run

- **Params:** path | code (exactly one; path gate: read, .ahk); args?: string[];
  cwd? (gate); mode 'wait'|'background' (default 'wait'); timeoutMs 1000-600000
  (default 30000); waitForWindow? { title?, class?, timeoutMs? }; startupLine?
  (background). No ahkPath, runner or watch parameters.
- **Output:** {
  status:'exited'|'started'|'timedOut'|'failedToStart'|'cancelled',
  exitCode|null, pid|null, runId|null, durationMs, stdout, stderr,
  stdoutTruncated, stderrTruncated, errors:[{ file, line, message, detail? }],
  windows:[{ hwnd, title, className }], path|null } (timeout/failure: isError
  with the partial output kept)

#### AHK_Process

- **Params:** action 'list'|'status'|'output'|'stop'; runId (required except for
  list); since? (output offset)
- **Output:** { runs?:[{ runId, pid, path, status, exitCode|null, startedAt,
  endedAt|null }], run?:{ runId, status, exitCode|null, stdout, stderr,
  nextOffset, windows[] }, stopped?: boolean }

#### AHK_Eval

- **Params:** code (required, <= 20 KB); session?; reset?; timeoutMs 100-30000
  (default 5000)
- **Output:** { sessionId, value|null, output: string[], errors: string[],
  timedOut, historyLength } (errors or timeout set isError)

#### AHK_Debug

- **Params:** action
  'launch'|'attach'|'status'|'continue'|'step_into'|'step_over'|'step_out'|'breakpoint_set'|'breakpoint_remove'|'breakpoint_list'|'stack'|'variables'|'eval'|'stop';
  session (required except for launch/attach); path (launch; gate, .ahk); args?;
  line, condition? (breakpoint_set); breakpointId; expression (eval); frame?;
  context 'local'|'global'; depth 1-5; waitMs 0-30000 (continue/step). Flat
  object; conditional requirements are checked at runtime and failures return
  actionable isError.
- **Output:** { sessionId, state:'listening'|'break'|'running'|'stopped',
  location?:{ file, line }, reason?:'breakpoint'|'exception'|'step'|'exit',
  exception?:{ message, file, line }, frames?:[{ level, where, file, line }],
  variables?:[{ name, type, value, children? }], breakpoints?:[{ id, file, line,
  condition? }], value? }

#### AHK_Doc_Search

- **Params:** query (required, 1-200 chars); kinds?
  ['function','class','method','property','variable','directive','operator','flow','guide'];
  limit 1-25 (default 8); cursor?; responseFormat 'concise'|'detailed' (detailed
  adds params, returns, examples and guide section text)
- **Output:** { query, dataset:{ version, entries }, hits:[{ id (e.g.
  'function/WinGetList'), kind, name, parent?, signature?, summary, url, uri
  ('ahk://docs/{kind}/{name}' or 'ahk://guides/{topic}'), score, params?,
  returns?, examples?, text? }], nextCursor|null }, plus resource_link content
  blocks

#### AHK_Library_Search

- **Params:** query (required); scope 'libraries'|'symbols'|'all' (default
  'all'); kinds?; relativeTo? (script whose local Lib takes precedence); limit
  1-50 (default 10); cursor?; refresh?
- **Output:** { query, scope, hits:[{ kind, name, library, parentClass?, path,
  line?, score (0-1), include ('#Include <Lib>') }], searchedPaths[],
  failedPaths:[{ path, error }], nextCursor|null }

#### AHK_Library_Info

- **Params:** name (required); include? ['symbols','dependencies','includes']
  (default all); includeFormat 'angle'|'relative'|'absolute' (default 'angle');
  relativeTo? (required for 'relative'); symbolLimit 1-500 (default 100);
  responseFormat
- **Output:** { name, path, version?, classes[], functions[], dependencies:[{
  name, path|null }], missing[], cycles: string[][], includeOrder[],
  includeLines[], shadowedBy?, truncated } (not found: isError with suggestions)

#### AHK_UIA_Windows

- **Params:** filter? (substring of title or process name)
- **Output:** { windows:[{ hwnd, title, className, pid, processName, visible,
  minimized, cloaked }] }

#### AHK_UIA_Tree

- **Params:** hwnd | titleQuery (exactly one); depth 1-30; maxNodes 1-2000;
  filter?; fromPath?
- **Output:** { hwnd, lines: string[], nodeCount, truncated, continuations:
  string[] }

#### AHK_UIA_Find

- **Params:** hwnd | titleQuery; query (required); controlType?; maxResults 1-50
  (default 10)
- **Output:** { hwnd, query, totalMatched, matches:[{ controlType, name,
  automationId, path, rect|null, snippet, snippetStrategy, snippetVerified }] }

#### AHK_UIA_Element

- **Params:** hwnd | titleQuery; path | automationId | name; controlType?;
  highlightMs 0 or 100-15000 (default 0)
- **Output:** { hwnd, controlType, name, automationId, className, enabled,
  offscreen, path, rect|null, patterns, snippet, snippetStrategy?,
  snippetVerified, highlighted }

#### AHK_UIA_Under_Cursor

- **Params:** delayMs 0-10000 (default 0; about 3000 when asking a user to
  hover)
- **Output:** { cursor:{ x, y }, ancestors: string[], ...AHK_UIA_Element fields
  }

#### AHK_Status

- **Params:** include? ['environment','roots','toolsets','stats'] (default all);
  additionalProperties:false
- **Output:** { server:{ name, version, transport }, ahk:{ runtime:{ path|null,
  version|null, ok }, fork:{ path|null, version|null, ok } }, lsp:{ available,
  path|null }, allowedRoots: string[], toolsets:{ enabled: string[], readOnly },
  docs:{ version, entries }, stats:{ calls, errors, byTool:[{ tool, calls,
  errors, p50Ms }], recentErrors:[{ tool, code, at }] } }; the MCP App
  ui://ahk/status-dashboard is attached when the client supports it

## Removed tools

| Tool                                                                   | Reason                                                                                                                                                                                                                                  | Replacement                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `AHK_File_Edit_Small`                                                  | A second editor with the opposite defaults (replace-all on, backup off). Its 'replace' parameter defaults to '', so a {find, newContent} call deletes the matched text. Failures never set isError.                                     | AHK_File_Edit (str_replace with explicit replaceAll, line ops)                             |
| `AHK_File_Edit_Diff`                                                   | Hidden and uncallable, yet still recommended by other tools. Applies hunks by position, and no hunk with context applies to a CRLF file.                                                                                                | AHK_File_Edit op 'apply_patch' (jsdiff with fuzz)                                          |
| `AHK_File_Edit_Advanced`                                               | Edits nothing. Returns keyword-matched routing text that says 'use IMMEDIATELY' and points to a hidden tool. Annotated destructive even though it never writes.                                                                         | AHK_File_Edit                                                                              |
| `AHK_File_Active`                                                      | Holds a process-global active file that is saved to disk and silently changes which file later writes target. The 2026-07-28 Stateful Tools guidance favors explicit handles over this kind of implicit state.                          | An explicit path argument on every tool; the ahk://workspace/recent resource for recall    |
| `AHK_Active_File`                                                      | Unreachable duplicate of AHK_File_Active whose parameter-alias rule is the reverse of it.                                                                                                                                               | none                                                                                       |
| `AHK_File_Detect`                                                      | Critical: saves scriptDir to config, which widens the path allowlist (ahk-file-detect.ts:93-94). Also duplicates AHK_File_Active's detect action.                                                                                       | AHK_File_List (pattern, sortBy)                                                            |
| `AHK_File_Recent`                                                      | Same as AHK_File_List sorted by modified time, and it enumerates directories without the containment check.                                                                                                                             | AHK_File_List sortBy 'modified'                                                            |
| `AHK_Diagnostics`                                                      | A heuristic presented as 'validation'. Reports error-level false positives on valid v2 code (e.g. 'Duplicate function' for two MsgBox calls). Its results end up in AHK_Cloud_Validate's cache as if they were real validation results. | AHK_Check                                                                                  |
| `AHK_Analyze`                                                          | Its custom lexer and linter flag core v2 operators (+=, //, =>, ++, := -1) as errors and hide real parse errors. It also changes the active file based on paths found in the code.                                                      | AHK_Check (+ AHK_Outline for structure)                                                    |
| `AHK_LSP`                                                              | Not an LSP; it runs the same heuristics as AHK_Diagnostics. Its fix mode produces code that does not parse, such as count(+= 1) and Loop(3 {).                                                                                          | AHK_Check (thqby engine); fixes applied with AHK_File_Edit                                 |
| `AHK_Lint`                                                             | Its checker is O(n^2). autoFix rewrites Windows paths and single-quoted strings on disk. It gives wrong v2 advice ('use = for assignment'). Annotated as non-destructive.                                                               | AHK_Check (rules engine), AHK_Outline, AHK_File_Edit validate                              |
| `AHK_Cloud_Validate`                                                   | Runs the script from a temp copy instead of validating it, which also breaks #Include and A_ScriptDir. The 'Cloud' name is misleading, and it accepts an ahkPath argument that can launch any executable.                               | AHK_Check (/Validate, never executes); AHK_Run {code} for runtime checks                   |
| `AHK_VSCode_Problems`                                                  | Parses a VS Code problems JSON the user must export by hand, and reads files of any extension outside the allowed roots.                                                                                                                | AHK_Check (thqby LSP diagnostics)                                                          |
| `AHK_THQBY_Document_Symbols`                                           | The name exposes an implementation detail. Fails in the default configuration and returns raw LSP JSON with 0-based ranges.                                                                                                             | AHK_Outline engine 'lsp'                                                                   |
| `ahk-parse-ast`                                                        | Registered but not listed, so it cannot be called. Its <Lib> include resolution is broken by a require() call in ESM. The kebab-case name breaks the naming convention.                                                                 | AHK_Outline engine 'parser'                                                                |
| `AHK_Summary`                                                          | A no-argument dump of static reference data that advertises incorrect 'standards'.                                                                                                                                                      | ahk://docs/index resource and AHK_Doc_Search                                               |
| `AHK_Context_Injector`                                                 | Returns about 92K characters per call, inserts hidden steering banners, asks the model to paste its reasoning, and locates modules relative to process.cwd().                                                                           | AHK_Doc_Search guide-section hits and ahk://guides/{topic}                                 |
| `AHK_Prompts`                                                          | Dumps about 49K characters that duplicate prompts/list and prompts/get.                                                                                                                                                                 | Six curated MCP prompts with arguments; guides as resources                                |
| `AHK_Sampling_Enhancer`                                                | Never performs MCP sampling, can't be reached, and makes false claims about sampling compliance.                                                                                                                                        | none                                                                                       |
| `AHK_Library_List`                                                     | Scans a directory that does not exist on Windows, so it always reports 0 libraries; its output is also unbounded.                                                                                                                       | AHK_Library_Search scope 'libraries'                                                       |
| `AHK_Library_Import`                                                   | Only formats text, yet is annotated as mutating. Its import order leaves out every dependency.                                                                                                                                          | AHK_Library_Info include 'includes'                                                        |
| `AHK_Process_Request`                                                  | Critical: a natural-language router that runs scripts when the text merely contains 'run' or 'test' (so 'truncated' or 'latest' trigger it). autoExecute defaults to true, and it drops isError from the result.                        | Direct calls to AHK_Run or AHK_Check                                                       |
| `AHK_Test_Interactive`                                                 | Hidden. Its only unique feature is running inline code.                                                                                                                                                                                 | AHK_Run {code}                                                                             |
| `AHK_Repl_Reset`                                                       | A tool with a single operation.                                                                                                                                                                                                         | AHK_Eval {reset:true}                                                                      |
| `AHK_Debug_DBGp`                                                       | 19 actions in one flat schema. Error capture never fires, it cannot launch a script, the port parameter is ignored, get_source bypasses the path policy, and apply_fix rewrites line endings to LF.                                     | AHK_Debug (session handles, launch, exception breaks)                                      |
| `AHK_Debug_Agent`                                                      | A passive TCP sniffer that parses DAP frames on a link that carries DBGp. Its port ranges are unbounded and its errors lack isError.                                                                                                    | AHK_Debug                                                                                  |
| `AHK_Smart_Orchestrator`                                               | Analyzes the path string instead of the file and regex-parses markdown, so it never finds an entity. Its 'validate' option runs the script, and it bypasses the registry.                                                               | AHK_Outline, then AHK_File_View line ranges                                                |
| `AHK_Workflow_Analyze_Fix_Run`                                         | Always reports 0 issues, and its write path uses raw fs outside containment and the editing kill-switch.                                                                                                                                | AHK_Check, then AHK_File_Edit (validate), then AHK_Run; the ahk-debug-error prompt         |
| `AHK_Alpha`                                                            | Critical: on repeated edit failures it writes <name>\_aN.ahk next to the target outside the allowed dirs, then retargets the active file.                                                                                               | Byte-exact backups returned by AHK_File_Edit                                               |
| `AHK_Config`                                                           | Lets the model rewrite the allowlist and the AutoHotkey executable path, and the change is saved across restarts.                                                                                                                       | Operator config (env or config file) plus the read-only AHK_Status and ahk://server/status |
| `AHK_Settings`                                                         | Lets the model re-enable tools the user disabled. It changes tools/list as a side effect of a request, which the 2026-07-28 spec forbids. Several of its safety flags do nothing.                                                       | Operator toolsets (AHK_MCP_TOOLSETS, AHK_MCP_READ_ONLY) and the client's own tool toggles  |
| `AHK_Analytics`                                                        | Operator telemetry exposed as a model tool. export floods the context with result previews, and clear is destructive.                                                                                                                   | AHK_Status stats, ahk://server/status and the MCP App                                      |
| `AHK_Cache_Stats`                                                      | Developer diagnostics that cannot be reached.                                                                                                                                                                                           | AHK_Status stats                                                                           |
| `AHK_Trace_Viewer`                                                     | Cannot be reached, and it views traces that only ever contain a single span.                                                                                                                                                            | Telemetry ring buffer and optional OTLP export                                             |
| `AHK_Tools_Search`                                                     | Duplicates tools/list once the surface is about 20 tools.                                                                                                                                                                               | Kept but hidden unless AHK_MCP_TOOL_DISCOVERY=1                                            |
| `uia_windows`                                                          | Renamed under the server namespace to avoid collisions with other Windows UIA servers; no behavior change.                                                                                                                              | AHK_UIA_Windows (old name available via AHK_MCP_LEGACY_TOOL_NAMES=1)                       |
| `uia_tree`                                                             | Renamed under the server namespace.                                                                                                                                                                                                     | AHK_UIA_Tree                                                                               |
| `uia_find`                                                             | Renamed under the server namespace.                                                                                                                                                                                                     | AHK_UIA_Find                                                                               |
| `uia_element`                                                          | Renamed; now also takes highlightMs.                                                                                                                                                                                                    | AHK_UIA_Element                                                                            |
| `uia_under_cursor`                                                     | Renamed under the server namespace.                                                                                                                                                                                                     | AHK_UIA_Under_Cursor                                                                       |
| `uia_highlight`                                                        | Uses the same selector as uia_element and returns a subset of its output.                                                                                                                                                               | AHK_UIA_Element {highlightMs}                                                              |
| `search / fetch`                                                       | Generic names listed only when the server runs over HTTP. fetch cannot resolve the ids that search returns, and it builds URLs that do not exist.                                                                                       | AHK_Doc_Search; compatible versions only with AHK_MCP_CHATGPT_COMPAT=1                     |
| `AHK_Analyze_Unified, CloudAHK AHK_Cloud_Validate, AHK_Memory_Context` | Unregistered dead modules; one of them reuses a live tool name.                                                                                                                                                                         | none                                                                                       |

## Resources, prompts, completions

RESOURCES Registered with McpServer.registerResource from src/resources/\*.

Every resource has:

- a slug name plus a display title
- description, mimeType and size
- annotations: audience ['assistant'], priority, lastModified
- a toolset icon
- a per-resource cacheHint

Only canonical URIs are accepted; the prefix-stripping normalizeResourceUri
(server.ts:1154-1170) is deleted. A miss throws ResourceNotFoundError, which is
-32602 with data.uri on every protocol revision. This settles the auditors'
-32002 vs -32602 disagreement: the SDK never emits -32002 and maps a thrown
-32002 to -32602 (src-D-y6h4N7.mjs:3547-3557, 3640-3654).

Static resources (resources/list):

- ahk://docs/index — JSON: names grouped by kind, plus dataset version. Long
  public TTL.
- ahk://guides/index — guide topics with one-line summaries.
- ahk://snippets/index
- ahk://server/status — same data as AHK_Status. ttl 0, private, subscribable.
- ahk://workspace/recent — in-memory most-recently-used list of files this
  process created, edited or ran. Replaces the persisted active file.
  Subscribable.
- ui://ahk/status-dashboard — text/html;profile=mcp-app. Attached to AHK_Status
  and rendered from its results.

Templates (resources/templates/list, RFC 6570, each with list and complete
callbacks):

- ahk://docs/{kind}/{name} — text/markdown per reference entry. kind completes
  from the enum; name completes by prefix within the kind.
- ahk://guides/{topic} — text/markdown, from docs/Modules moved to data/modules.
  Agent frontmatter stripped, fences fixed, and the 'replace object literals
  with Map()' advice corrected.
- ahk://snippets/{name} — text/x-autohotkey. The four current templates are
  moved to data/snippets/\*.ahk and fixed: #Requires AutoHotkey v2.0, OnEvent
  instead of g-labels, backtick-n newlines, no class/variable name collision, a
  valid arrow example. Each is checked with AutoHotkey /Validate in CI.
- ahk://runs/{runId} — application/json status and output of a background run.
  Subscribable.

Removed resources:

- ahk://context/auto and ahk://system/clipboard (placeholders with misleading
  descriptions)
- ahk://system/info (fake fields, plus cwd and pid)
- ahk://docs/functions, variables, classes, methods (a 12-entry stub described
  as 'complete')
- ahk://templates/\* (broken AHK, and the name clashes with MCP resource
  templates)
- mcp://server-card.json (the card stays at /.well-known/mcp/server-card.json on
  HTTP only)
- ui://ahk/analytics-dashboard (renamed)

Subscriptions: advertise resources.subscribe and deliver through one
ChangeNotifier.

- stdio: the pinned instance's sendResourceUpdated. The SDK routes this onto
  subscriptions/listen on 2026 and sends it unsolicited on 2025.
- HTTP 2026: createMcpHandler().notify.resourceUpdated feeds the listen streams.
  Keep the handler's {notify, close}, which server.ts:2643-2649 currently
  discards.
- Updates are emitted only when a content hash changes: run output or exit,
  workspace MRU, status probe or config reload.
- Delete the 2s and 5s polling timers and resource-subscriptions.ts.
- Legacy stateless HTTP cannot receive later notifications. Document this.

PROMPTS User-controlled. Registered with McpServer.registerPrompt, with
completable arguments. Names are stable and hand-written, each prompt has a
title and description, and the list is sorted by code units. A missing required
argument or an unknown name returns ProtocolError -32602; today these throw a
plain Error that becomes -32603 (server.ts:1123). The catalog is built once at
startup, not re-read from disk on every call.

The six prompts:

- ahk-debug-error {error (required), path?, line?} — embeds the file window as
  an EmbeddedResource when path is inside the allowed roots. Workflow: AHK_Check
  → AHK_Outline/AHK_File_View → AHK_File_Edit (dryRun, validate) → AHK_Check.
- ahk-new-script {goal (required), gui 'yes'|'no', hotkeys?} — links the
  relevant ahk://guides topics.
- ahk-review {path (required), focus
  'correctness'|'style'|'performance'|'v2-migration'}
- ahk-convert-v1 {path? | code?} — uses the AHK_Check migration rules.
- ahk-gui-layout {requirements (required)} — merges the two near-duplicate 12K
  GUI bodies.
- ahk-uia-automate {task (required), window?} — AHK_UIA_Windows → AHK_UIA_Find →
  AHK_UIA_Element → snippet → AHK_Check → AHK_Run.

The guide modules become resources and AHK_Doc_Search hits, not prompts. The
AHK_Prompts tool is removed.

COMPLETIONS Advertised, because real references now exist. Supported:

- prompt arguments: path → files in the allowed roots by prefix, at most 100;
  enums; guide topics
- template variables: kind, name, topic, snippet name, runId

An unknown ref returns -32602. Nothing is returned for undeclared arguments,
which ends the active-file path echo at server.ts:1941-1972.

## Protocol fixes

- [high] Cancellation. Delete the notifications/cancelled override
  (server.ts:363-369). It replaces the handler the SDK's Protocol constructor
  installs (src-D-y6h4N7.mjs:6235), so ctx.mcpReq.signal never aborts. Pass the
  signal into every handler through ToolContext. Regression test: a cancel sent
  during a slow call aborts the handler's signal.
- [high] Era and capability detection. Add src/server/era.ts:
  - On 2026 requests, read ctx.mcpReq.envelope[PROTOCOL_VERSION_META_KEY] and
    [CLIENT_CAPABILITIES_META_KEY]. The SDK moves these keys out of \_meta: see
    RESERVED_ENVELOPE_META_KEYS and liftWireOnlyMaterial,
    src-D-y6h4N7.mjs:6057-6105.
  - On 2025 connections, use server.getClientCapabilities().
  - Replace isModernRequest (server.ts:400-403), clientSupportsFormElicitation
    (405-421), client-roots.ts:12-15 and clientSupportsMcpApps
    (mcp-apps.ts:12-17).
  - Always return inputRequired(...), and let the SDK's default-on legacy shim
    fulfil it for 2025 clients (mcp-Dw2OlZ1f.mjs:790-797, 1196-1203).
  - Make smoke-mcp-2026.js assert input_required, using an isolated config dir,
    instead of printing SKIP.
- [high] tools/list stability. 2026-07-28 says the tool set 'MUST NOT vary
  per-connection or as a side effect of other requests on the connection'.
  AHK_Settings enable_tool/disable_tool breaks this (server.ts:581, 601-618,
  730-735). Move enablement to operator toolsets and read-only mode, evaluated
  at startup. Send list_changed only after the runtime probe or an operator
  config reload, through the ChangeNotifier: stdio instance send and
  createMcpHandler notify.toolsChanged.
- [high] Input validation. The registry checks every call against the tool's
  strict zod schema before any side effect ('Servers MUST validate all tool
  inputs'). Failures are isError tool results, per the Error Handling section of
  both 2025-11-25 and 2026-07-28; the SDK's McpServer does the same
  (mcp-Dw2OlZ1f.mjs:1738-1746). Unknown tools stay ProtocolError -32602. Stop
  injecting \_progressToken into arguments (server.ts:377-389), since that
  breaks additionalProperties:false.
- [high] Output. Every tool declares an outputSchema.
  - The registry validates structuredContent, which servers MUST conform to the
    schema, then calls server.projectCallToolResult(). That method is public and
    intended for low-level handlers (mcp-Dw2OlZ1f.mjs:1391-1407).
  - The text block is a compact, lossless rendering. This is a documented
    deviation from the SHOULD to include serialized JSON, and the spec's own
    list_users example uses a summary. AHK_MCP_TEXT_MIRROR=json emits serialized
    JSON for strict clients.
  - Type ToolRegistry results as CallToolResult, not any.
- [high] isError on every failure path. Today, disabled-tool messages, not-found
  results and edit/eval/library/settings failures come back looking like
  successes (e.g. ahk-file-edit.ts:827-834, ahk-eval.ts:51-52,
  ahk-library-info.ts:111-118, tool-registry.ts disabled path). The ToolError to
  single-formatter path makes this structural. Delete scripts/fix-mcp-types.cjs,
  a batch script whose stated purpose is removing isError, and the comment at
  src/types/mcp-types.ts:29-30 that says isError is 'NOT part of the official
  MCP specification'.
- [high] Stateful tools. Use explicit handles (runId, debug sessionId, eval
  sessionId) with stated retention, and return isError for unknown or expired
  handles, following the 2026-07-28 'Stateful Tools' guidance. Remove the
  persisted global active file, the argument sniffing that sets it
  (server.ts:749-758), and autoDetect(code) in the analysis tools.
- [medium] Progress. Use a per-request sender held in AsyncLocalStorage instead
  of the global token map. Values must be strictly increasing (the spec says
  progress 'MUST increase'); today a call sends 0,0,100,100. Treat token 0 as
  valid, and send a completion only if its value is greater than the last one.
- [medium] Resources. Throw ResourceNotFoundError on a miss: -32602 with
  data.uri. Use canonical URIs only, real RFC 6570 templates with completion,
  and full metadata (title, size, annotations, cacheHint).
- [medium] Prompts. Stable names, a title, typed arguments, -32602 for a missing
  required argument or an unknown prompt (currently -32603), sorted listing, and
  a catalog loaded once.
- [medium] Completion. Resolve ref.name and ref.uri against the registries and
  return -32602 for unknown refs. Complete only declared arguments and template
  variables.
- [medium] Subscriptions. Advertise subscribe only where updates are actually
  delivered: stdio in both eras, and HTTP 2026 via the createMcpHandler bus.
  Send notifications only when content changes, with no timers. Use
  notify.toolsChanged and notify.resourceUpdated on HTTP.
- [medium] Tasks (legacy 2025-11-25 only; no extension advertised, which matches
  SDK 2.1.0):
  - TTL counted from creation (task-manager.ts:241-243 counts from completion).
  - A finite default task timeout.
  - A per-principal concurrency cap and principal-scoped list/get/cancel/result.
  - -32602 for a bad cursor.
  - Task completion is logged.
  - taskSupport is 'optional' only on AHK_Run, AHK_Check and AHK_Debug.
- [medium] Timeouts. Per-tool timeouts. A timeout maps to TOOL_TIMEOUT
  (retryable), with a hint to use task or background mode. The abort signal is
  checked before any write, and child process trees are killed.
- [medium] Robustness:
  - unhandledRejection logs and the server keeps running (index.ts:22-25
    currently exits).
  - Error-aware log serialization; logger.ts:32-47 prints Errors as '{}'.
  - .catch on fire-and-forget sends.
  - Pass onerror to serveStdio.
  - Redirect every console method to stderr; logger.ts:106-109 covers only
    console.log.
- [medium] Shutdown. Await mcpHandler.close() and stdioHandle.close(), call
  closeIdleConnections/closeAllConnections, flush telemetry, and add a 5s
  forced-exit timer (server.ts:2700-2704, 3005-3041).
- [medium] HTTP JSON-RPC conformance:
  - -32700 for entity.parse.failed.
  - JSON-RPC error bodies for 413 and 429, with Retry-After on 429.
  - Delete configureRoutingHeaderValidation (server.ts:2836+). It duplicates SDK
    validation, and on mismatches it answers -32001 where the SDK uses -32020
    HEADER_MISMATCH.
  - JSON 410 for /sse and /messages, pointing to /mcp.
- [medium] Rate limiting and sanitization (spec: servers MUST rate limit tool
  invocations and sanitize tool outputs):
  - Concurrency caps per toolset (exec, UIA) and per-path write locks.
  - Per-principal HTTP buckets that exempt task polling.
  - Strip control characters from captured stdout, stderr and UIA text, cap
    their size, and clearly delimit this untrusted external text.
- [low] Capabilities and identity. Use one SERVER_INFO/SERVER_CAPABILITIES
  source for both new Server() and the server card; the card is HTTP-only and
  drops requires.roots. Drop the logging capability, deprecated by SEP-2577, and
  the notifications/message that duplicates isError. Read the version from
  package.json (it is hard-coded as '2.0.0' three times). Rewrite the server
  instructions (server.ts:293), which currently point to AHK_File_Active,
  AHK_Diagnostics and AHK_Lint.
- [low] Deterministic ordering. Sort tools, prompts, resources and templates by
  code-unit comparison, replacing localeCompare (server.ts:692).
- [low] Compat tools. search/fetch appear only with AHK_MCP_CHATGPT_COMPAT=1;
  today they appear whenever HTTP is on (server.ts:574-577, 629; verified).
  fetch looks up an exact id and returns isError when it is missing.

## Security fixes

- [critical] Delete the alpha subsystem. AHK_File_Edit's catch calls
  handleEditFailure (ahk-file-edit.ts:814). From the third failure on, it writes
  <base>\_a<N>.ahk next to the target with no assertAllowedPath and no
  exclusive-create flag (alpha-version.ts:104-144). The failure count is saved
  to disk and never reset, and PathNotAllowedError counts as a failure. It then
  retargets the active file. Fixed in WP00b.
- [critical, privacy] 'image copy 2.png' is tracked in a public repo and shows a
  prohibited personal account handle. Remove it; rewrite history only with the
  owner's approval. Add a 'files' whitelist: npm pack currently ships 988 files,
  including the .kilo git worktree and its personal settings. Delete the ANTLR
  output that embeds a third party's local path. Add a CI scan against a
  denylist supplied through a secret, never committed.
- [critical] Make the allowlist operator-only. AHK_File_Detect saves scriptDir
  (ahk-file-detect.ts:93-94). AHK_Config saves scriptDir, searchDirs and ahkPath
  (ahk-system-config.ts:115-141). path-policy trusts both
  (path-policy.ts:63-74). Remove those writes now (WP00b/WP00c). In v3, roots
  are: legacy client roots, plus operator env/config, plus cwd unless it is a
  drive root, the home directory or a system directory, plus in-memory folder
  grants that the user approves through form elicitation (stdio, or an
  authenticated principal, only).
- [critical when enabled] DAP listener. Today it has no authentication and
  spawns whatever client-supplied ahkPath/program it is given
  (dap-session.ts:205-221), and its frame codec also accepts HTTP-shaped
  requests. Fixes: a per-process token; a strict codec that accepts only
  Content-Length headers, caps headers at 1 KiB and bodies at 4 MiB, and
  destroys the socket on overflow; client ahkPath ignored; program must pass
  assertAllowedPath and be .ahk; explicit /Debug=127.0.0.1:<port>; no silent
  port increment; and a separate entry point.
- [critical] Remove AHK_Process_Request. Substring matching on 'run'/'test'
  executes scripts when the text says 'truncated' or 'latest'
  (ahk-run-process.ts:108-113); autoExecute defaults to true and isError is
  dropped.
- [critical, integrity] Delete the heuristic fixers that corrupt valid code on
  disk. AHK_Lint autoFix rewrites escape-like sequences inside Windows paths and
  single-quoted strings (auto-fix-engine.ts:215-248,
  fast-syntax-checker.ts:243-264). AHK_LSP fix rewrites 'count += 1' as
  'count(+= 1)' (fix-service.ts:88-98). From now on, fixes are only suggestions,
  applied through AHK_File_Edit with /Validate gating and byte-exact backups.
- [high] Enforce containment centrally. Only 8 call sites use assertAllowedPath.
  About 12 tools read outside the allowed roots (Analyze, Diagnostics, LSP,
  THQBY, Cloud_Validate, VSCode_Problems, Process_Request, Context_Injector,
  File_Recent, File_Active get, DBGp get_source) and AHK_Workflow writes outside
  them. The v3 registry resolves every declared path argument (read/write,
  extension allowlist) before the handler runs; per-tool checks stay as defense
  in depth. A contract test calls every tool with an out-of-root path.
- [high] Reject UNC, device ('.') and extended-length ('?') path prefixes and
  NTFS alternate data streams lexically, before any fs call. Today
  assertAllowedPath runs lstat and realpath before the allowlist check
  (path-policy.ts:91-104), so a UNC target triggers SMB/NTLM or a named-pipe
  connection. Also pre-check roots lexically before calling realpath.
- [high] Executable integrity:
  - No per-call ahkPath on AHK_Run, AHK_Cloud_Validate or DAP.
  - Runtime and fork executable paths come only from operator config.
  - Search order: %ProgramFiles%, then LOCALAPPDATA/Programs, then PATH.
  - cwd-relative binaries only with AHK_MCP_ALLOW_LOCAL_AHK=1. Today
    config.ts:222-234 checks them first, and read-only UIA calls execute
    whatever binary is found.
  - Cache a version probe per executable.
- [high] Remove hidden execution:
  - The edit tools' 'validate' option runs the edited script from a temp copy
    (ahk-cloud-validate.ts:289-311).
  - runAfter and autoRunAfterEdit run the script after an edit.
  - The orchestrator's 'validate' executes the script.
  - VS Code auto-opens on every edit (the default is on). In v3, validation is
    AutoHotkey /Validate, which loads the script without running it.
- [high] Declare honest annotations per tool and snapshot-test them:
  - AHK_Run, AHK_Eval, AHK_Debug: destructive and openWorld.
  - AHK_Process: destructive.
  - UIA tools: openWorld, since they read arbitrary third-party windows.
  - Read-only tools: readOnly and idempotent. SECURITY.md must state that
    AHK_Run and AHK_Eval execute arbitrary code, so path containment is defense
    in depth and the host's approval is the real gate.
- [high] HTTP auth posture:
  - Require AHK_MCP_AUTH_TOKEN whenever the allowed hosts or origins include
    non-loopback names. Today a reverse proxy or tunnel runs unauthenticated
    (server.ts:2585-2593).
  - Treat [::1] and 127.0.0.0/8 as loopback.
  - Tokens of at least 32 bytes, compared as digests, with a case-insensitive
    Bearer scheme.
  - Scope tasks to the auth principal; today all clients share one store
    (server.ts:1019-1021).
- [medium] Observability. Serve /traces and the dashboard from the main HTTP
  app, behind the Host/Origin/auth middleware. Delete the standalone
  observability server, which has no auth off-loopback and allows CORS from any
  localhost port. Escape dashboard fields. Telemetry never records arguments or
  results.
- [medium] Error results never echo raw arguments. Today file contents and code
  are copied into \_meta error details (server.ts:923-930). No stack traces go
  to clients.
- [medium] Nothing writes into the client's cwd. Today three log sinks create
  logs/ there with argument summaries, and friendly-logger calls mkdirSync at
  import time. Allow one optional, rotation-capped log directory, under operator
  control only.
- [medium] Remove the edit tools' regex mode. It runs model-supplied regular
  expressions synchronously on the event loop, which allows ReDoS. Cap the file
  size the editor accepts.
- [medium] Stop trusting cwd implicitly when it is a drive root, the home
  directory or a system directory. Log the effective roots at startup. A file
  root means that file, not its parent directory (client-roots.ts:38).
- [medium] Completion must not return absolute paths for arbitrary arguments;
  today it echoes the active file (server.ts:1941-1972). Complete paths only for
  declared path arguments, inside the allowed roots.
- [medium] Delete PathInterceptor and the path-converter config. The interceptor
  rewrites tool output text and matches argument keys by substring; when
  disabled it returns the JS arguments object, which drops the user's arguments;
  and on a WSL host the file tools write the wrong file. Replace it with one
  explicit toNative normalization and echo the resolved path in
  structuredContent.
- [medium] HTTP security headers: nosniff, frame-ancestors 'none', and
  x-powered-by disabled. SECURITY.md currently claims headers the code never
  sets.

## Infrastructure

TOOL DEFINITION PATTERN Each tool is one module that exports a defineTool()
spec, and a single TOOLS array lists them all:

```ts
// src/tools/files/edit.ts
export default defineTool({
  name: 'AHK_File_Edit',
  title: 'Edit File',
  toolset: 'files',
  description:
    'Apply edits atomically to an existing file ... Use when ... Do not use when (AHK_File_Create) ... Side effects ... Limits ... Example: {...}',
  input: z.strictObject({
    path: z.string().min(1),
    edits: z.array(EditOp).min(1).max(50),
    expectedSha256: z.string().length(64).optional(),
    dryRun: z.boolean().default(false),
    validate: z.boolean().default(false),
  }),
  output: EditResult, // zod v4; required for every tool
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  taskSupport: 'forbidden',
  timeoutMs: 30_000,
  requires: [], // e.g. ['ahk.runtime'] | ['ahk.fork']; tool is hidden when the startup probe fails
  pathArgs: [{ key: 'path', access: 'write', kind: 'file' }],
  concurrency: { key: a => a.path }, // per-path lock
  resolveInputs: undefined, // optional multi-round-trip hook: (args, ctx) => args | InputRequiredResult
  handler: async (args, ctx) => ({ text, structured, links }), // failures: throw new ToolError('CONFLICT', msg, hints)
});
// src/tools/index.ts
export const TOOLS = [
  view,
  list,
  edit,
  create,
  vscodeOpen,
  check,
  outline,
  run,
  process,
  evaluate,
  debug,
  docSearch,
  librarySearch,
  libraryInfo,
  ...uia,
  status,
];
```

The name Sets, name-to-instance maps, IToolServer, tool-factory and hand-written
JSON Schemas all go away. A tool that is not in TOOLS does not exist.

REGISTRY src/tooling/registry.ts runs on the low-level Server that an McpServer
hosts. Tools stay custom because McpServer.registerTool cannot declare
execution.taskSupport: mcp-Dw2OlZ1f.mjs:2111 passes execution as undefined, and
this server needs legacy tasks and a per-request \_meta.ui. Prompts, resources
and completion use McpServer directly.

list(ctx):

- Definitions are precomputed at startup: z.toJSONSchema with target
  'draft-2020-12' and io input/output, additionalProperties:false, toolset
  icons, title, explicit annotations, execution.taskSupport.
- The list is filtered by operator toolsets, read-only mode and the runtime
  probe, never by earlier requests.
- Sorted by code units, and returned with ttlMs/cacheScope.
- \_meta.ui is added to AHK_Status when clientCapabilities(ctx) declares MCP
  Apps.

call():

1. An unknown or unlisted tool is ProtocolError -32602.
2. Task gate: a task request to a non-task tool is -32601.
3. Strict safeParse. Failures return isError listing each 'field.path: message'
   and the valid keys.
4. Path gate:
   - lexical rejection of UNC/device/extended paths and ADS;
   - allowlist check;
   - extension allowlist;
   - the canonical path is substituted into the arguments;
   - a path outside the roots returns an inputRequired grant elicitation when
     supported, otherwise isError PATH_NOT_ALLOWED listing the roots.
5. resolveInputs hook.
6. Concurrency guard.
7. The handler runs under one AbortSignal combining client cancel, task cancel
   and the tool timeout.
8. A ToolError goes through a single formatter:
   - one line saying what failed, plus up to three fixes;
   - \_meta {code, retryable};
   - never an argument echo or a stack trace.
9. On success, content is the compact lossless text rendering (serialized JSON
   when AHK_MCP_TEXT_MIRROR=json) plus any resource_link blocks, and
   structuredContent is the output.
10. Output safeParse: throw under NODE_ENV=test; in production, log and return
    isError INTERNAL.
11. server.projectCallToolResult(result, outputJsonSchema).
12. finally: record telemetry, send the progress completion (only if strictly
    greater than the last value), emit the fileTouched event.

Error codes: INVALID_ARGUMENT, PATH_NOT_ALLOWED, NOT_FOUND, CONFLICT,
UNAVAILABLE, TIMEOUT, CANCELLED, EXECUTION_FAILED, INTERNAL.

Description template: purpose; 'Use when'; 'Do not use when', naming the
alternative; side effects; limits (sizes, timeouts, handle lifetimes); one
example. At most 1,000 characters. No mention of unlisted tools (a contract test
enforces this).

Parameter conventions:

- camelCase names: path, code, directory, timeoutMs, responseFormat,
  cursor/nextCursor, runId/sessionId.
- Integers with bounds; enums.
- Exactly-one-of rules are enforced by refinement, never by a root-level oneOf,
  which some clients reject. Unions appear only nested, as in AHK_File_Edit's
  edits items.
- No parameter aliases outside the opt-in legacy layer.

PROTOCOL PLUMBING

- src/server/era.ts provides requestEra(ctx) and clientCapabilities(server,
  ctx). It reads ctx.mcpReq.envelope on 2026 requests and
  getClientCapabilities() on 2025 connections.
- Handlers return inputRequired(...) and rely on the SDK's default-on legacy
  shim for 2025 clients.
- src/server/change-notifier.ts sends tools/prompts/resources list-changed and
  resource-updated to the pinned stdio instance and to
  createMcpHandler().notify, deduplicated by content hash.
- An AsyncLocalStorage request context carries the signal, a monotonic
  per-request progress sender, the allowed roots and the principal.
- src/server.ts becomes a composition root over:
  - src/server/create-server.ts;
  - src/server/capabilities.ts: one
    SERVER_INFO/SERVER_CAPABILITIES/instructions/server-card source, version
    from package.json, no logging capability;
  - src/server/tasks.ts: legacy 2025-11-25 only, principal-scoped;
  - src/server/stdio.ts: serveStdio with onerror; the handle is closed on
    shutdown;
  - src/server/http.ts: Express plus createMcpHandler, keeping {fetch, notify,
    close}.

CONFIGURATION AND RUNTIME

- env-config.ts: one zod schema, one boolean parser (1/true/yes/on), deprecated
  aliases, warnings for unknown AHK*MCP*\* keys.
- operator-config.json: read-only to tools, cached by mtime. It replaces
  model-writable config.json and tool-settings.json.
- AHK_MCP_TOOLSETS (files, analysis, run, debug, docs, uia, server, compat) and
  AHK_MCP_READ_ONLY are evaluated at startup.
- ahk-runtime probes the script runtime, the fork and the thqby LSP before
  serving.
- run-manager owns every child process: switches come before the script path,
  output is decoded with StringDecoder into bounded buffers, process trees are
  killed on stop, and runIds are retained for a fixed period.

LOGGING AND TRACING

- One stderr logger: level, text or json format, Error-aware serialization,
  every console method redirected, and an optional rotating file sink only under
  AHK_MCP_LOG_DIR.
- One telemetry hook in registry.call() feeds a bounded ring buffer of {tool,
  ok, errorCode, durationMs, era, ts}. It never holds arguments or results.
  AHK_Status, ahk://server/status and the HTTP dashboard read it.
- Optional OTLP spans (AHK_MCP_OTEL_ENDPOINT), parented on the inbound
  traceparent (SEP-414), with unref'd timers and a flush on shutdown.
- Deleted: friendly-logger (writes to cwd, synchronous I/O), unified-logger,
  debug-journal, the custom spans in tracing.ts, tool-analytics, metrics.ts with
  prom-client, the standalone observability server, and the MCP logging
  capability with its duplicate notifications/message.

LEGACY COMPATIBILITY src/tooling/legacy-aliases.ts holds a table of oldName →
{target, adaptArgs}, enabled by AHK_MCP_LEGACY_TOOL_NAMES=1.

- Aliases are listed, not hidden, with the description 'Deprecated: use X' and
  the target's annotations, so hosts still gate them.
- Adapters cover the common v2 argument shapes. Legacy arguments that cannot be
  mapped return isError naming the new parameters.
- Off by default; removed after one minor release.
- The same table generates docs/MIGRATION-v3.md.

SERVER INSTRUCTIONS 'AutoHotkey v2 development server. File paths must be inside
the allowed roots; AHK*Status, or AHK_File_List without a directory, shows them.
Check built-ins with AHK_Doc_Search before writing code. Read with
AHK_File_View. Change files with AHK_File_Edit: use dryRun to preview, and pass
expectedSha256 from the view. Then run AHK_Check, which validates without
running, before AHK_Run. AHK_Run, AHK_Eval and AHK_Debug execute code on the
user's desktop. The AHK_UIA*\* tools inspect live windows read-only and return
verified selector snippets.'

## Hygiene

- Privacy first (WP00a). Remove the tracked root screenshots (one shows a
  prohibited personal handle; do not name it in commits). Add a package.json
  'files' whitelist. Ignore .kilo/, .superpowers/, .history/, artifacts/, logs/
  and coverage/ in the git, prettier and docker ignore files. Rewrite history
  and remove the stale worktree only with the owner's approval.
- Commit identity. CLAUDE.md requires every commit to use the TrueCrimeAudit
  identity, but the local git user is configured as a different identity.
  Implementation agents must set the author and committer explicitly and follow
  Conventional Commits.
- Delete scripts/fix-mcp-types.cjs, which batch-strips isError from tools, and
  the incorrect 'isError is not part of the spec' comment
  (src/types/mcp-types.ts:29-30). Consolidate the five ToolResponse definitions
  onto the SDK's CallToolResult.
- Dependencies. Move to zod ^4.2, shared as one copy with the SDK, which needs
  4.2+ for StandardSchemaWithJSON. Existing imports are rewritten to 'zod/v3'
  until deleted; new code imports 'zod'. Drop zod-to-json-schema, antlr4ng,
  prom-client and ts-node; add jsdiff.
- Dead code:
  - 17 unreachable modules, including the ANTLR output, metrics,
    message-interceptor, in-memory-event-store, version-manager,
    analyze-complete, cloudahk-validate, memory-context, debug-formatter and
    path-auto-retry. tool-factory is removed with the alpha subsystem.
  - 8 handlers that are registered but cannot be called.
  - After integration, every legacy tool, engine, fixer, logger, interceptor and
    orchestrator (WP32). An import-graph check keeps it that way.
- package.json:
  - bin entries (ahk-mcp, ahk-mcp-dap), repository, and license plus a LICENSE
    file (README says MIT but no file exists).
  - One package name; the version is read at runtime.
  - Remove dead or broken scripts: spec:\*, dev (cmd-only 'set'), start:chatgpt,
    test:coverage:report ('open'); fix test:uia:lib, which uses $AHK_PATH that
    cmd.exe never expands.
  - prepare becomes 'husky'; test:integration builds first.
  - Add test:ahk, test:contract, build:docs-corpus and gen:\*-docs scripts.
- Tests and CI. Make npm test green; today 12 of 28 suites fail (node:test and
  vitest suites run under Jest, plus stale APIs). Delete Tests/manual, which has
  broken imports. Add a contract suite for the MCP surface. Run CI on master:
  the current workflows target main/develop, call scripts that don't exist and
  test Node 18 while engines requires 20 or later. Add a Windows AutoHotkey job.
- Lint and format:
  - One lint scope: delete .eslint.maintained.ignore and fix the remaining
    errors.
  - Turn on noUnusedLocals and noUnusedParameters.
  - ESLint bans on console.\* and on direct fs write APIs under src/tools; the
    only allowed writer is src/core/fs/safe-write.ts.
  - Deduplicate .gitignore and fix its merged comment line.
  - Delete the shim configs .prettierrc.js and .lintstagedrc.js.
- Runtime data:
  - docs/Modules moves to data/modules; it is runtime data, not documentation.
  - Snippets move to data/snippets/\*.ahk and are checked with /Validate in CI.
  - Regenerate the v2 docs corpus.
  - Delete data/ahk_index.json (the stub served as 'complete'),
    ahk_documentation_index.json, ahk_structure.csv, and the v1 'Module' list of
    1031 names without descriptions.
- Logs. Nothing writes to process.cwd(). Stop producing unbounded archives in
  logs/. There is one optional log directory, under operator control.
- Documentation:
  - AGENTS.md becomes canonical, with a 'Repository layout' section.
  - CLAUDE.md shrinks to a pointer plus the Claude-specific and privacy rules;
    drop its stale newContent, debugMode and dryRun tool guidance.
  - README: Node 20+, no legacy SSE claim, a LICENSE file, the 20 tools,
    toolsets and read-only mode.
  - SECURITY.md is rewritten as a threat model.
  - docs/TOOLS.md and docs/CONFIGURATION.md are generated; docs/MIGRATION-v3.md
    comes from the alias table.
  - Archive plans, specs and one-off summaries (about two thirds of docs/
    describe removed tools) and delete the drifted copies in
    docs/implementation/\*.ts.
- Root clutter:
  - Delete or archive HANDOFFahkeval.md, YOLO.md, TEST-MCP-FIXES.md,
    Diagram2.png, demos/, monitoring/ (it scrapes a /metrics endpoint that
    doesn't exist and references a missing rules file), extension/, specs/ and
    struct_breakdown/.
  - Move Diagram.png to docs/assets.
  - Refresh evals/ to the new names or remove it.
  - Delete the code-execution/ wrappers (11 tools already missing), or
    regenerate them from the registry if they are still used.
- Config examples:
  - Keep one .mcp.example.json, with a portable entry and a dist entry using the
    new env names; delete .mcp.json.example and .mcp.windows.json.
  - Update the repo's PostToolUse hook (.claude/hooks/run-after-edit.py) to
    match only AHK*File*(Edit|Create).
  - Update the portable-runtime launcher for the renamed env vars and remove
    AHK_ACTIVE_FILE.
- Docker:
  - Publish ports on 127.0.0.1 only.
  - Add a real /healthz; the current healthcheck probes /health, which doesn't
    exist, and gets 401.
  - Use --http, and npm ci --omit=dev --ignore-scripts.
  - Take the allowed hosts and origins from env.
  - Document that the execution and /Validate tools can't run in Linux
    containers.

## Test plan

1. Unit tests (jest with @jest/globals; no AutoHotkey needed):

- registry pipeline, result/error formatter, progress, era helpers, change
  notifier, telemetry ring buffer, logger
- text codec: round-trips for CRLF, LF, mixed endings, UTF-8 BOM and
  UTF-16LE/BE; strict-decode failure
- safe-write: atomic under concurrency; backups are byte-exact
- path policy: UNC/device/ADS rejected, with an fs spy proving zero I/O happens;
  symlink writes refused; cwd guard; user grants
- edit engine: uniqueness errors with line numbers; replaceAll; line-op bounds;
  insert at 0; append/prepend with a BOM; apply_patch with fuzz; all-or-nothing;
  dryRun and apply produce the same diff; sha precondition
- run-manager and window detection with an injected spawn: every status; partial
  output on timeout; tree kill; runId expiry; UTF-8 characters split across
  chunks
- DBGp with a fake socket: error elements, exception breaks, async continue,
  abort
- docs index: coverage (Map, Array.Push, WinGetList, StrReplace, CallbackCreate
  all hit), no v1-only names, stable ids
- library resolver: DFS dependency order; cycles only within the reachable
  subgraph; Lib precedence; scores between 0 and 1
- parser: 1-based lines; Allman braces; fat-arrow functions; control flow is not
  reported as functions; <Lib> includes resolve
- env and operator config
- task manager: TTL from creation, -32602 for a bad cursor, caps, principal
  isolation

2. Contract tests. An SDK Client over InMemoryTransport against createServer(),
   run once per era: 2025-11-25 with initialize, and 2026-07-28 with the
   envelope. They check:

- tools/list invariants for every tool:
  - AHK\_ prefix and a title
  - all four annotations explicit and matching a committed snapshot
  - inputSchema of type object with additionalProperties:false
  - outputSchema present
  - description under the length budget, containing 'Use when', and naming no
    unlisted tool
- listing is byte-identical across calls and unchanged after every tool call
  (2026 MUST NOT)
- an exec allowlist: any tool whose handler reaches run-manager or spawn must be
  destructive and openWorld
- unknown tool gives -32602
- invalid input gives isError with issue paths
- structuredContent validates against outputSchema for golden calls
- cancellation aborts the handler signal
- a timeout gives TOOL_TIMEOUT
- path grant: input_required on a 2026 request that declares elicitation; the
  SDK shim elicitation on 2025; isError otherwise
- resources:
  - list/read round-trip for every listed resource
  - template matching
  - an unknown URI gives -32602 with data.uri
  - canonical URIs
- prompts: sorted; get with arguments; a missing required argument or an unknown
  name gives -32602
- completion: declared arguments only; an unknown ref gives -32602
- subscriptions: on stdio, AHK_File_Edit produces resources/updated for
  ahk://workspace/recent; on 2026, subscriptions/listen is acknowledged and
  delivers
- legacy tasks: create, get, cancel, result, TTL

3. Integration tests:

- stdio spawn of dist: smoke:mcp, and smoke:mcp:2026 with an isolated config dir
  that asserts input_required instead of printing SKIP
- HTTP:
  - auth posture: a remote host without a token is refused at startup
  - Host/Origin checks
  - -32700 for bad JSON
  - JSON-RPC bodies for 413 and 429
  - /healthz without auth
  - SDK header validation (-32020)
  - shutdown while a listen stream is open
- the DAP adapter through its own entry point

4. AutoHotkey-dependent tests (Windows runner with AutoHotkey v2 installed;
   Tests/ahk/\*\*):

- AHK_Check golden corpus. It includes every false-positive sample from the
  audit, which must produce zero errors:
  - count += 1
  - idx := -1
  - 10 // 3
  - Double(x) => x \* 2
  - count++
  - a single-quoted double-quote literal
  - backslash Windows path strings
  - Send "{Enter}"
  - Loop 3 {
  - an object literal
  - #Requires AutoHotkey >=2.0
  - two MsgBox calls Invalid samples must produce the expected error line.
- AHK_File_Edit validate blocks a breaking edit
- AHK_Run statuses and window detection
- every data/snippets/\*.ahk passes /Validate
- AHK_Outline agrees with thqby when the extension is installed

5. Fork-dependent job (manual or optional): UIA golden outputs validate against
   the outputSchemas; the e2e script passes with AHK*UIA*\* names; AHK_Eval
   sessions work.

6. Named regression tests, one per critical or high audit finding:

- alpha fork writes nothing
- cancel override
- envelope keys
- allowlist widening
- UNC probing
- DAP spawn
- substring execution
- tools/list side effects
- CRLF matching
- BOM and UTF-16 damage
- autofix corruption
- docs stub coverage
- library root path
- import order
- search/fetch transport gating

7. Budgets:

- tools/list total bytes, plus per-tool description and schema sizes, asserted
  against thresholds recorded from the first green build (baseline today: 75.8
  KB for 43 tools)
- default responses at most 25k characters, with truncation flags and cursors

8. CI on push/PR to master:

- windows-latest and ubuntu-latest × Node 20 and 22: typecheck, full-scope lint,
  build, unit plus contract tests, both smoke scripts
- the Windows AutoHotkey job
- a privacy denylist scan, with the list supplied only as a secret
- an npm pack whitelist check
- a check that generated docs are fresh
- coverage gate of at least 85% lines on src/tooling, src/core/fs,
  src/core/path-policy.ts and the edit engine
