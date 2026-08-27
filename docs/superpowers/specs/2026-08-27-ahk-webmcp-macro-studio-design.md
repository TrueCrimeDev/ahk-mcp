# AHK WebMCP Macro Studio Design

**Date:** 2026-08-27

**Status:** Approved on 2026-08-27

## Goal

Add a local Macro Studio to the existing AutoHotkey MCP HTTP server. The Studio
must let a WebMCP-capable browser discover curated AutoHotkey v2 macros, inspect
their exact effects, stage a run, and observe its result while keeping arbitrary
script execution out of the page tool surface.

The first end-to-end macro displays a short message in a native Windows dialog.
It proves the complete page-to-local-AHK path without introducing a
consequential automation.

## Scope

Version 1 includes:

- A normal browser UI at `/studio` that remains useful when WebMCP is absent.
- Four page-scoped WebMCP tools registered with
  `document.modelContext.registerTool`.
- A curated server-side macro catalog with one `show_desktop_message` macro.
- Preview, staging, native confirmation, execution, and status tracking.
- A dedicated narrow executor that reuses the project's AutoHotkey discovery and
  process cleanup infrastructure without invoking the stateful `AhkRunTool`.
- Focused unit, HTTP, WebMCP contract, and built-server tests.

Version 1 does not include:

- Arbitrary `.ahk` paths or source supplied by the page or agent.
- Editing, recording, importing, scheduling, watch mode, or background macros.
- Direct exposure of `ToolRegistry`, `/mcp`, or `AHK_Run` through WebMCP.
- A public Cloudflare tunnel, `viols.dev` deployment, browser extension, or
  remote execution pairing.
- Persistence across server restarts or multiple users.

## Approaches Considered

### 1. Curated local bridge — selected

Mount a dedicated Studio beside the existing dashboard. The Studio resolves
opaque macro IDs through a fixed server-side catalog and calls a narrow
execution adapter. This reuses the current HTTP infrastructure, AutoHotkey
discovery, and process cleanup while maintaining a much smaller security
boundary than the regular MCP surface.

### 2. Proxy the regular MCP tool registry — rejected

This would require less new code, but `AHK_Run` accepts caller-selected script
paths, executables, working directories, runner modes, arguments, watch
behavior, and timeouts. That interface is intentionally powerful for trusted MCP
clients and is not an acceptable WebMCP capability.

### 3. Browser extension with native messaging — deferred

An extension/native-host pair would provide a stronger long-term public-site
pairing model, but it adds installation, lifecycle, signing, and cross-origin
complexity that is unnecessary to prove the local workflow.

## Architecture

`AutoHotkeyMcpServer.startHttpMode()` first decides whether the configured HTTP
listener itself is loopback. A non-loopback listener never constructs or mounts
Studio. On an eligible listener, a header-only `/studio` boundary is installed
before global rejection middleware so even Host, Origin, rate-limit,
authentication, and parser failures receive the Studio security headers and
fixed error bodies. The functional `mountStudio()` routes remain behind those
shared protections and beside `mountDashboard()`. The Studio is isolated in
focused modules:

| Unit                                    | Responsibility                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/studio/macro-catalog.ts`           | Define curated macro IDs, display metadata, parameter validation, fixed script paths, timeouts, and side-effect descriptions.                   |
| `src/studio/studio-service.ts`          | Create bounded previews and runs, enforce state transitions and expiry, bind verified catalog bytes, and coordinate confirmation and execution. |
| `src/studio/ahk-runtime.ts`             | Resolve, canonicalize, version-check, and hash-pin one AutoHotkey v2 executable while probing it with pinned helper bytes.                      |
| `src/studio/verified-script.ts`         | Canonicalize, hash-pin, retain, and revalidate the exact bytes of code-owned AHK helper scripts.                                                |
| `src/studio/native-approval.ts`         | Launch the pinned native confirmation source through the interpreter's stdin script target and return a fixed outcome.                          |
| `src/studio/ahk-executor.ts`            | Execute approved, preview-bound catalog bytes with a fixed argument vector and return a path-free bounded result.                               |
| `src/studio/ahk-process.ts`             | Feed verified source bytes to AutoHotkey's `*` stdin target, track process lifetime, and enforce bounded termination escalation.                |
| `src/studio/studio-http.ts`             | Mount assets and JSON endpoints, enforce the real loopback socket/bound authority, and apply Studio-specific headers and errors.                |
| `scripts/studio/VersionProbe.ahk`       | Fixed AHK v2 probe that prints `A_AhkVersion` during Studio startup.                                                                            |
| `scripts/studio/Approval.ahk`           | Fixed AHK v2 confirmation prompt used outside the DOM.                                                                                          |
| `scripts/studio/ShowDesktopMessage.ahk` | Fixed demonstration macro that displays validated text.                                                                                         |

The service receives confirmation, execution, clock, and ID-generation
dependencies. Tests replace only the native prompt and actual process spawn;
catalog, state machine, routes, and browser callbacks remain real. The dedicated
executor does not call `AhkRunTool.execute()`, change the shared active file, or
pass through any of `AhkRunTool`'s path-rich response content.

The runner never asks AutoHotkey to reopen a mutable script path. It starts the
pinned interpreter with the fixed `*` stdin script target and writes a private
copy of the already-verified source bytes to the child pipe. The executor maps
process outcomes to a fixed public result containing only `status`, `exitCode`,
`durationMs`, and a catalog-owned summary. Exit `0` is success; a nonzero exit,
spawn error, or timeout is failure. Raw stdout, stderr, command strings,
executable paths, and script paths are discarded from the public result rather
than sanitized by pattern matching.

## Macro Catalog

Catalog entries are code-owned, not request-owned. Each entry contains:

- An opaque `id`, human title, description, and explicit side-effect summary.
- A script path resolved beneath the fixed `scripts/studio` macro root.
- A Zod parameter schema and a function that converts validated parameters into
  a fixed ordered argument list.
- A bounded timeout and a list of target applications or Windows facilities.

The initial `show_desktop_message` entry accepts:

```json
{
  "message": "string, 1 to 120 characters"
}
```

The script displays the message under the fixed title `AHK Macro Studio`. It
does not read the clipboard, type into another application, open a URL, write a
file, or remain running after the dialog closes.

## Trusted AutoHotkey Runtime

At HTTP-server startup, the Studio resolves one candidate with the project's
existing `resolveAutoHotkeyPath()` function. It then:

1. Resolves the candidate with `realpath` and requires a regular `.exe` file.
2. Canonicalizes and hash-pins the exact bytes of the fixed
   `scripts/studio/VersionProbe.ahk`, revalidates the helper, and runs those
   retained bytes through AutoHotkey's `*` stdin script target. The probe writes
   only `A_AhkVersion` to stdout.
3. Requires a semantic version whose major component is `2` or greater.
4. Computes and stores the executable's SHA-256 hash.

The canonical executable path and hash are pinned for the Studio service
lifetime. The hash is rechecked immediately before every approval or macro
launch. `Approval.ahk` is separately canonicalized and hash-pinned during Studio
composition and revalidated before use. Both helpers and catalog macros execute
from the retained verified bytes rather than a later path lookup. All scripts
use the same runtime. If discovery, helper verification, version probing,
canonicalization, or hashing fails, the Studio UI remains available for catalog
inspection but reports execution as unavailable. No request can override or
re-resolve the executable or helper source.

Setting `AHK_MCP_STUDIO_EXECUTION=off` selects catalog-only mode. In that mode
the server does not resolve, hash, probe, or launch AutoHotkey; list and preview
remain available, while staging or approving a run returns `503` with the fixed
code `execution_unavailable`.

## WebMCP Tool Contract

The client checks that `document.modelContext?.registerTool` is a function
before registering tools. Tool names and behavior are:

| Tool                    | Read-only hint | Behavior                                                                                                                                                                                |
| ----------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_ahk_macros`       | `true`         | Return catalog metadata and effect summaries.                                                                                                                                           |
| `preview_ahk_macro`     | `true`         | Validate a macro ID and parameters, then return the exact effect, target, script hash, and a short-lived preview ID. Creating the ephemeral preview does not execute or modify Windows. |
| `request_ahk_macro_run` | `false`        | Convert a valid preview into a `pending_approval` run and make it visible in the page. It never opens a process or approves a run.                                                      |
| `get_ahk_run_status`    | `true`         | Return the redacted state and result of one run ID.                                                                                                                                     |

Every schema sets `additionalProperties: false`, bounds string lengths, and
describes side effects. Tool results contain enough information for the browser
agent and user to verify the visible page state.

`preview_ahk_macro` has a read-only hint because it changes no user or Windows
state; its expiring server-side preview record is an internal cache used only to
bind a later write request to the inspected script and parameters.

There is deliberately no WebMCP approval or direct execution tool.

## HTTP Contract

The Studio uses same-origin JSON endpoints:

- `GET /studio/api/macros`
- `POST /studio/api/previews`
- `POST /studio/api/runs`
- `GET /studio/api/runs/:runId`
- `POST /studio/api/runs/:runId/approve`

Studio is not mounted when `AHK_MCP_HTTP_HOST` configures a non-loopback
listener. Every request that reaches an eligible Studio route additionally
requires the actual remote socket address to be loopback (including a safely
normalized IPv4-mapped loopback address) and the raw `Host` authority to be an
explicit `localhost`, `127.0.0.1`, or `[::1]` literal whose port exactly equals
`req.socket.localPort`. Forwarding headers and configured Host allowlists cannot
satisfy this boundary.

All three mutating endpoints—`POST /studio/api/previews`,
`POST /studio/api/runs`, and `POST /studio/api/runs/:runId/approve`—also require
the raw `Origin` to be the exact normalized `http://<Host>` origin. Missing,
public, HTTPS, cross-port, and cross-host origins receive `403`.

The approval endpoint is invoked only by the visible page. Because DOM clicks
can be automated, the page button is not the security boundary. Approval is
complete only after the fixed native Windows prompt returns an affirmative
result.

If `AHK_MCP_AUTH_TOKEN` is configured, existing global bearer authentication
remains in front of every Studio route. Version 1 does not bypass or replace it;
direct browser navigation therefore assumes the default loopback configuration
without a bearer token. An authenticated remote or reverse-proxy browser flow is
deferred with public pairing.

The early header-only boundary does not route or authorize a request. Global
Host/Origin failures use fixed Studio `403` bodies without echoing allowlists or
request metadata; authentication remains mandatory and uses a fixed Studio
`401`; rate and parser failures are likewise sanitized. Every mounted Studio
response carries the Studio security headers, including failures emitted before
the functional routes.

Expected response classes are:

- `200` for reads and completed approval attempts.
- `201` for a newly created preview or staged run.
- `400` for malformed or schema-invalid input.
- `403` when a Studio POST is not demonstrably same-origin and loopback.
- `404` for an unknown macro, preview, or run ID.
- `409` for an invalid or already-consumed state transition.
- `410` for an expired preview or run request.
- `429` for a sanitized rate-limit rejection.
- `500` for a sanitized native confirmation or execution failure.
- `503` when native execution is disabled, the trusted runtime is unavailable,
  or the bounded in-memory record capacity is full.

## State and Data Flow

1. The page or agent lists macros.
2. `preview_ahk_macro` validates parameters, canonicalizes the catalog script
   with `realpath`, verifies it is a regular `.ahk` file beneath the fixed root,
   hashes its bytes with SHA-256, retains a private copy of those exact bytes,
   and creates a five-minute preview.
3. `request_ahk_macro_run` atomically consumes the preview and creates a
   five-minute run in `pending_approval`. No process starts.
4. The page renders the exact macro, parameters, effect, target, and script
   hash.
5. The user selects **Run on this PC**. The server atomically acquires the
   single Studio execution lock, moves the run to
   `awaiting_native_confirmation`, rechecks the pinned runtime hash, and spawns
   the trusted executable with `/ErrorStdOut`, the `*` stdin target, the pinned
   `Approval.ahk` source bytes, and bounded code-owned display arguments.
6. `Approval.ahk` shows a fixed Yes/No dialog containing the catalog title and
   effect. It exits `0` for approval and `2` for denial. Any other exit, process
   error, or a 60-second timeout is a failed confirmation. A timeout or tracked
   process/pipe failure requests graceful termination, escalates to a forced
   kill after a bounded grace interval, and does not release the execution lock
   until `close` confirms termination. If bounded confirmation still fails, the
   global coordinator enters persistent quarantine and rejects later approvals.
   Denial or confirmation failure never starts the selected macro.
7. Approval causes the server to re-resolve the file, recheck containment and
   the SHA-256 hash, then execute the retained preview bytes through the `*`
   stdin target and move through `running` to `succeeded` or `failed`. A file
   write, deletion, or replacement between the final recheck and process spawn
   cannot change the launched program.
8. The page and `get_ahk_run_status` report a bounded, redacted result.

State lives in memory and is intentionally lost on restart. Preview and run IDs
use cryptographically random UUIDs. Live previews and runs expire after exactly
five minutes; terminal runs remain pollable through that valid window. Lazy
sweeps remove expired inactive records, timestamped consumed/expired tombstones
retain fixed one-use/expiry errors for a bounded window, and deterministic caps
reject new records rather than evicting live or active work. Tombstones evict
oldest-first at their defensive cap, so ordinary requests cannot grow private
state indefinitely. A preview is one-use. Approval is one-use and atomically
transitions state before awaiting native input, so duplicate requests cannot
execute twice. The one-run lock covers both the outstanding native prompt and
the selected macro process; a concurrent approval attempt receives `409` without
starting another prompt.

## Security Invariants

- No client input may specify a filesystem path, AHK source, executable, working
  directory, command line, runner, watch behavior, or arbitrary argument vector.
- Catalog scripts are resolved with `realpath`, must be regular `.ahk` files,
  and must remain beneath the fixed macro root after symlink resolution.
- A preview binds the macro ID, validated parameters, canonical script path,
  script hash, verified source bytes, creation time, and expiry. The hash and
  path are rechecked immediately before execution, but process creation consumes
  only the retained bytes through AutoHotkey's stdin script target.
- `VersionProbe.ahk` and `Approval.ahk` are canonicalized, hash-pinned,
  retained, and revalidated; neither helper is reopened by AutoHotkey during
  launch.
- Only the startup-resolved, version-verified, canonical, hash-pinned AutoHotkey
  v2 executable is used for approval and selected macro processes.
- Only one Studio macro may run at a time. Each catalog entry has a timeout of
  at most 30 seconds, and captured output is capped and sanitized. The lock is
  held through confirmed child termination; failure to confirm termination
  permanently quarantines the coordinator for the server lifetime.
- Native confirmation is mandatory. Denial, prompt failure, or timeout cannot
  spawn the selected macro.
- Studio is absent from non-loopback configured listeners. Every mounted Studio
  request requires a real loopback remote socket and raw literal Host authority
  matching the actual local port; every POST also requires the exact matching
  `http` Origin.
- Studio responses set `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a CSP
  limited to same-origin scripts, styles, connections, and images with
  `object-src 'none'`, `base-uri 'none'`, and `frame-ancestors 'none'`.
- Errors and status records never return absolute paths, raw command lines,
  executable paths, stack traces, or unbounded stdout/stderr.
- Preview, run, and tombstone stores have bounded deterministic admission,
  sweeping, and eviction behavior without evicting active execution.
- Browser rendering uses `textContent` and DOM node construction for all
  request, result, and catalog values. It never inserts those values through
  `innerHTML`.

## Public and Cloudflare Boundary

The current HTTP listener must not be tunneled. It also serves `/mcp`, and the
regular MCP tool surface includes general-purpose local execution. Binding that
listener to loopback does not prevent a Cloudflare tunnel from forwarding public
traffic to it.

Version 1 is therefore available only at loopback URLs such as
`http://127.0.0.1:8787/studio`. A later `viols.dev` phase must use a separate
frontend-only public listener plus authenticated pairing to a private local
bridge. Cloudflare Access is required for any remote execution workflow; Host
and Origin validation are not authentication.

## User Interface

The Studio is a responsive single page with four visible regions:

- Connection banner showing local companion and WebMCP availability.
- Macro catalog showing title, effect, and target before selection.
- Preview panel showing validated parameters and the exact pending effect.
- Run activity panel showing native-confirmation, running, success, denial,
  expiry, and sanitized failure states.

Every WebMCP callback updates the same visible UI that a person uses. A person
can also complete the workflow entirely through the page controls when WebMCP is
absent.

## Error Handling

Validation errors identify the invalid field without echoing sensitive input.
Unknown, consumed, and expired IDs are distinct. Native prompt failures and AHK
failures become terminal sanitized run states rather than uncaught route errors.
Client fetch failures leave the last verified state visible and show a retryable
connection message.

## Testing Strategy

Development follows red-green-refactor:

1. `Tests/unit/studio-service.test.ts` covers allowlisting, realpath
   containment, preview binding, expiry, one-use transitions, denial, duplicate
   approval, hash changes and launch races, execution quarantine, concurrency,
   bounded record caps/sweeps, and sanitized failures with injected native
   boundaries.
2. `Tests/unit/studio-http.test.ts` mounts real Express on an ephemeral port and
   tests response shapes, status codes, security headers, modeled remote
   sockets, IPv4-mapped loopback, and actual-local-port checks.
3. `Tests/contract/studio-webmcp.test.ts` evaluates the served client JavaScript
   with a recording `document.modelContext`, verifies the four registrations and
   schemas, and proves that the request tool only stages a run.
4. `Tests/integration/studio-server.test.ts` starts the built loopback server
   with `AHK_MCP_STUDIO_EXECUTION=off`, then checks the page, client asset,
   catalog, `/mcp`, non-loopback mount exclusion, and fixed composed-middleware
   failures without launching AHK.
5. Manual verification in the WebMCP-capable in-app browser confirms discovery,
   normal UI fallback, visible state changes, native denial, native approval,
   and the desktop message result.

The focused suite, production build, type check, and diff check must pass before
the feature is reported complete. Existing unrelated repository-wide failures,
if any, must be reported separately rather than described as Studio failures.

## Success Criteria

- Visiting `/studio` renders a usable page with or without WebMCP.
- A compatible browser discovers exactly the four specified tools.
- An agent can list, preview, and stage the demonstration macro, but cannot
  directly approve or execute it.
- Staging a run never spawns AutoHotkey.
- Native denial spawns no selected macro; native approval executes exactly the
  fixed, hash-verified script once.
- The page and status tool show a verifiable terminal result without revealing
  local paths or raw process details.
- The existing dashboard and `/mcp` behavior remain unchanged.
- The loopback Studio works end to end; no public URL is claimed in this phase.
