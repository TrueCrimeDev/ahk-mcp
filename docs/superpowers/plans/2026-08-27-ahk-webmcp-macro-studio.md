# AHK WebMCP Macro Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox ( - [ ] ) syntax for tracking.

**Goal:** Build a local, human-approved WebMCP Macro Studio that can inspect and
stage one curated AutoHotkey v2 desktop-message macro without exposing arbitrary
AHK execution.

**Architecture:** Mount a separate /studio application beside the existing
dashboard. A curated catalog and state machine bind validated parameters to
canonical script hashes and retained verified bytes; a pinned AutoHotkey v2
runtime, pinned native approval prompt, and narrow stdin-source process adapter
are the only path to execution. Studio is mounted only on a configured loopback
listener, with a real-socket boundary on every request. The browser registers
four page-scoped WebMCP tools, while approval remains outside WebMCP and
requires a native Windows dialog.

**Tech Stack:** Node.js 20+, TypeScript 5 strict mode, Express 5, Zod 3, Jest 29
with ts-jest, AutoHotkey v2, WebMCP document.modelContext.registerTool.

**Spec:** docs/superpowers/specs/2026-08-27-ahk-webmcp-macro-studio-design.md

## Global Constraints

- Preserve the existing dirty changes in src/dashboard.ts and
  Tests/unit/dashboard-html.test.ts; never stage them in Studio commits.
- Keep the existing /dashboard and /mcp behavior unchanged.
- Do not add a dependency or change Jest module mode.
- Browser assets must be classic scripts; do not use import.meta, top-level
  await, inline script, inline style, or innerHTML.
- The only v1 macro ID is show_desktop_message with one strict message string of
  1–120 characters.
- No request may provide a path, source, executable, working directory, runner,
  watch setting, raw command, or arbitrary argument array.
- Macro files live beneath path.resolve(process.cwd(), "scripts", "studio").
- Studio is never mounted on a non-loopback configured listener. Every Studio
  request requires an actual loopback remote socket and a literal loopback Host
  authority whose port equals the socket's actual local port; every POST also
  requires the exact matching http Origin.
- Code-owned probe, approval, and catalog script bytes must be canonicalized,
  hash-pinned, retained, and passed to AutoHotkey through its `*` stdin target.
  A later mutable-path spawn or a second stat/hash alone is not an integrity
  boundary.
- AHK_MCP_STUDIO_EXECUTION=off must skip executable discovery, hashing, version
  probing, approval, and macro launch.
- Public DTOs must never include executable paths, script paths, commands,
  stdout, stderr, or stack traces.
- Do not tunnel port 8787 or claim a public viols.dev URL in this phase.

## Final-Review Binding Amendments (2026-08-27)

These amendments correct implementation assumptions in the original task
snippets and take precedence wherever an older example below still implies a
path-based script spawn or header-only loopback check:

1. The process runner accepts verified `scriptSource`, starts only the pinned
   interpreter with `['/ErrorStdOut=utf-8', '*', ...codeOwnedArguments]`, and
   writes a private source copy to stdin. `VersionProbe.ahk`, `Approval.ahk`,
   and the selected catalog macro are never reopened by AutoHotkey.
2. Timeout and tracked process/pipe failures do not settle until child `close`.
   Graceful termination escalates to forced kill within bounded intervals. If
   termination remains unconfirmed, the shared execution coordinator enters a
   persistent fail-closed quarantine that blocks all later approvals.
3. A header-only `/studio` boundary is mounted before global rejection
   middleware. It adds headers only and never bypasses Host, Origin, rate,
   bearer-auth, or parser checks. Those failures return fixed Studio bodies.
   Functional Studio routes are not constructed or mounted for a configured
   non-loopback listener.
4. Route admission uses `req.socket.remoteAddress` and `req.socket.localPort`,
   not forwarding headers or configured allowlists. Only literal `localhost`,
   `127.0.0.1`, and `[::1]` authorities with the actual local port are accepted;
   IPv4-mapped loopback is normalized safely.
5. Preview, run, and timestamped tombstone stores are swept lazily, capped
   deterministically, and never evict active execution. New work fails with a
   fixed `studio_busy` response at capacity while five-minute validity and
   one-use behavior remain exact.

---

### Task 1: Curated macro catalog and fixed AHK assets

**Files:**

- Create: src/studio/studio-types.ts
- Create: src/studio/macro-catalog.ts
- Create: scripts/studio/VersionProbe.ahk
- Create: scripts/studio/Approval.ahk
- Create: scripts/studio/ShowDesktopMessage.ahk
- Test: Tests/unit/studio-macro-catalog.test.ts

**Interfaces:**

- Produces StudioParameters, PublicMacro, StudioMacroDefinition,
  StudioMacroCatalog, and createStudioMacroCatalog().
- Later tasks may consume a definition only after resolving it by opaque ID;
  PublicMacro contains no local path.

- [ ] **Step 1: Write the failing catalog tests**

```ts
import { describe, expect, it } from '@jest/globals';
import path from 'node:path';
import { createStudioMacroCatalog } from '../../src/studio/macro-catalog.js';

describe('Studio macro catalog', () => {
  const root = path.resolve(process.cwd(), 'scripts', 'studio');
  const catalog = createStudioMacroCatalog(root);

  it('publishes exactly the curated desktop-message macro', () => {
    expect(catalog.list()).toEqual([
      {
        id: 'show_desktop_message',
        title: 'Show desktop message',
        description: 'Display a short message in a native Windows dialog.',
        effect: 'Shows one dismissible message dialog on this PC.',
        targets: ['Windows desktop'],
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', minLength: 1, maxLength: 120 },
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
    ]);
  });

  it.each(['', 'x'.repeat(121)])('rejects an out-of-range message', message => {
    const macro = catalog.get('show_desktop_message');
    expect(() => macro?.parameterSchema.parse({ message })).toThrow();
  });

  it('rejects unknown fields and builds one fixed argument', () => {
    const macro = catalog.get('show_desktop_message');
    expect(() =>
      macro?.parameterSchema.parse({ message: 'Hello', path: 'C:\\x.ahk' })
    ).toThrow();
    const parameters = macro?.parameterSchema.parse({ message: 'Hello' });
    expect(macro?.buildArguments(parameters ?? {})).toEqual(['Hello']);
    expect(macro?.timeoutMs).toBe(30_000);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npm run test:unit -- --runInBand --runTestsByPath Tests/unit/studio-macro-catalog.test.ts
```

Expected: FAIL because src/studio/macro-catalog.ts does not exist.

- [ ] **Step 3: Implement the catalog types and fixed definition**

Use these public interfaces in src/studio/studio-types.ts:

```ts
import type { z } from 'zod';

export type StudioParameters = Readonly<Record<string, unknown>>;

export interface PublicMacro {
  id: string;
  title: string;
  description: string;
  effect: string;
  targets: readonly string[];
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface StudioMacroDefinition {
  metadata: PublicMacro;
  scriptPath: string;
  parameterSchema: z.ZodType<StudioParameters>;
  timeoutMs: number;
  buildArguments(parameters: StudioParameters): readonly string[];
  successSummary: string;
  failureSummary: string;
}

export interface StudioMacroCatalog {
  readonly rootPath: string;
  list(): readonly PublicMacro[];
  get(id: string): StudioMacroDefinition | undefined;
}
```

Create the definition in src/studio/macro-catalog.ts with a strict Zod object
and a code-owned path:

```ts
const messageSchema = z
  .object({ message: z.string().min(1).max(120) })
  .strict()
  .transform(value => value as StudioParameters);

const definition: StudioMacroDefinition = {
  metadata: {
    id: 'show_desktop_message',
    title: 'Show desktop message',
    description: 'Display a short message in a native Windows dialog.',
    effect: 'Shows one dismissible message dialog on this PC.',
    targets: ['Windows desktop'],
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', minLength: 1, maxLength: 120 } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  scriptPath: path.join(rootPath, 'ShowDesktopMessage.ahk'),
  parameterSchema: messageSchema,
  timeoutMs: 30_000,
  buildArguments: parameters => [String(parameters.message)],
  successSummary: 'Desktop message closed successfully.',
  failureSummary: 'Desktop message did not complete.',
};
```

Create the scripts with exactly these behaviors:

```ahk
; scripts/studio/VersionProbe.ahk
#Requires AutoHotkey v2.0
#SingleInstance Force
FileAppend(A_AhkVersion, "*")
ExitApp 0
```

```ahk
; scripts/studio/Approval.ahk
#Requires AutoHotkey v2.0
#SingleInstance Force
if A_Args.Length != 2
    ExitApp 3
title := SubStr(A_Args[1], 1, 80)
effect := SubStr(A_Args[2], 1, 240)
decision := MsgBox("Run " title "?" Chr(10) Chr(10) effect, "AHK Macro Studio", "YesNo Icon?")
ExitApp(decision = "Yes" ? 0 : 2)
```

```ahk
; scripts/studio/ShowDesktopMessage.ahk
#Requires AutoHotkey v2.0
#SingleInstance Force
if A_Args.Length != 1
    ExitApp 3
message := A_Args[1]
if StrLen(message) < 1 || StrLen(message) > 120
    ExitApp 3
MsgBox(message, "AHK Macro Studio", "OK Iconi")
ExitApp 0
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: one suite passes with all catalog
assertions green.

- [ ] **Step 5: Commit only Task 1 files**

```powershell
git add -- src/studio/studio-types.ts src/studio/macro-catalog.ts scripts/studio Tests/unit/studio-macro-catalog.test.ts
git commit -m "feat(studio): add curated AHK macro catalog"
```

---

### Task 2: Pinned runtime, tracked process runner, native approval, and bounded executor

**Files:**

- Create: src/studio/ahk-process.ts
- Create: src/studio/ahk-runtime.ts
- Create: src/studio/verified-script.ts
- Create: src/studio/native-approval.ts
- Create: src/studio/ahk-executor.ts
- Test: Tests/unit/studio-ahk-runtime.test.ts
- Test: Tests/unit/studio-ahk-adapters.test.ts

**Interfaces:**

- Consumes StudioMacroDefinition from Task 1 and
  resolveAutoHotkeyPath()/processManager from existing code.
- Produces StudioProcessRunner, RuntimeAvailability, PinnedAhkRuntime,
  NativeApprovalGateway, StudioMacroExecutor, and path-free outcomes.

- [ ] **Step 1: Write failing runtime and adapter tests**

```ts
import { describe, expect, it, jest } from '@jest/globals';
import { initializeAhkRuntime } from '../../src/studio/ahk-runtime.js';
import { createNativeApprovalGateway } from '../../src/studio/native-approval.js';
import { createStudioMacroExecutor } from '../../src/studio/ahk-executor.js';

describe('Studio AHK boundaries', () => {
  it('keeps execution disabled without resolving or probing AHK', async () => {
    const resolveCandidate = jest.fn<() => string | undefined>();
    const processRunner = { run: jest.fn() };
    const state = await initializeAhkRuntime({
      executionMode: 'off',
      resolveCandidate,
      processRunner,
      versionProbePath: 'fixed-probe.ahk',
    });
    expect(state).toEqual({
      available: false,
      reason: 'disabled',
      message: 'Native execution is disabled.',
    });
    expect(resolveCandidate).not.toHaveBeenCalled();
    expect(processRunner.run).not.toHaveBeenCalled();
  });

  it('accepts a pinned v2 runtime and rejects changed executable bytes', async () => {
    let bytes = Buffer.from('trusted');
    const state = await initializeAhkRuntime({
      executionMode: 'on',
      resolveCandidate: () => 'C:\\AutoHotkey64.exe',
      realpath: async value => value,
      stat: async () => ({ isFile: () => true }),
      readFile: async () => bytes,
      processRunner: {
        run: async () => ({
          kind: 'exited',
          exitCode: 0,
          durationMs: 1,
          stdout: '2.0.19',
          stderr: '',
        }),
      },
      versionProbePath: 'C:\\repo\\scripts\\studio\\VersionProbe.ahk',
    });
    expect(state.available).toBe(true);
    if (!state.available) return;
    bytes = Buffer.from('changed');
    await expect(state.runtime.assertIntegrity()).rejects.toThrow(
      'AutoHotkey runtime integrity check failed.'
    );
  });

  it('maps native approval and macro outcomes without leaking process details', async () => {
    const runner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({
          kind: 'exited',
          exitCode: 2,
          durationMs: 4,
          stdout: 'secret',
          stderr: '',
        })
        .mockResolvedValueOnce({
          kind: 'exited',
          exitCode: 0,
          durationMs: 7,
          stdout: 'path',
          stderr: '',
        }),
    };
    const runtime = {
      executablePath: 'C:\\AutoHotkey64.exe',
      version: '2.0.19',
      sha256: 'a'.repeat(64),
      assertIntegrity: async () => undefined,
    };
    const approval = createNativeApprovalGateway(runner, pinnedApprovalScript);
    const executor = createStudioMacroExecutor(runner);
    await expect(
      approval.confirm({ runtime, title: 'Macro', effect: 'Effect' })
    ).resolves.toEqual({
      decision: 'denied',
      durationMs: 4,
    });
    const result = await executor.execute({
      runtime,
      scriptSource: Buffer.from('#Requires AutoHotkey v2.0'),
      arguments: ['Hello'],
      timeoutMs: 30_000,
      successSummary: 'Finished.',
      failureSummary: 'Failed.',
    });
    expect(result).toEqual({
      status: 'succeeded',
      exitCode: 0,
      durationMs: 7,
      summary: 'Finished.',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /AutoHotkey|Macro\.ahk|stdout|stderr|secret|path/
    );
  });
});
```

- [ ] **Step 2: Run both tests and verify RED**

```powershell
npm run test:unit -- --runInBand --runTestsByPath Tests/unit/studio-ahk-runtime.test.ts Tests/unit/studio-ahk-adapters.test.ts
```

Expected: FAIL because the four Studio boundary modules do not exist.

- [ ] **Step 3: Implement the process and runtime contracts**

Define:

```ts
export interface StudioProcessRequest {
  executablePath: string;
  scriptSource: Uint8Array;
  arguments: readonly string[];
  timeoutMs: number;
  outputLimitChars: number;
  windowsHide: boolean;
}

export type StudioProcessOutcome =
  | {
      kind: 'exited';
      exitCode: number;
      durationMs: number;
      stdout: string;
      stderr: string;
    }
  | { kind: 'timed_out'; durationMs: number }
  | { kind: 'termination_unconfirmed'; durationMs: number }
  | { kind: 'spawn_failed'; durationMs: number };

export interface StudioProcessRunner {
  run(request: StudioProcessRequest): Promise<StudioProcessOutcome>;
}
```

The real runner must call
`spawn(executablePath, ["/ErrorStdOut=utf-8", "*", ...arguments])`, pipe a
private copy of `scriptSource` to stdin, register and unregister the PID through
processManager, and cap each stream at 4,096 characters. On timeout or a tracked
spawn/pipe failure it must request graceful termination, escalate to a forced
kill after a bounded grace interval, and settle exactly once only after `close`.
If `close` cannot be confirmed after the bounded forced-kill wait, return
`termination_unconfirmed` without unregistering the still-unconfirmed process.

Define RuntimeAvailability with unavailable reasons disabled, not_found,
invalid_executable, probe_failed, and unsupported_version.
initializeAhkRuntime() must return disabled before calling any dependency when
executionMode is off. In on mode it must realpath a regular .exe, canonicalize
and hash-pin the fixed version probe source, run only those retained bytes with
a 5,000 ms timeout, require a numeric major version of at least 2, hash the
executable with SHA-256, and close over that canonical path and hash in
assertIntegrity(). Helper replacement between verification and process creation
must not change the source consumed by the interpreter.

- [ ] **Step 4: Implement fixed approval and execution mapping**

Approval must call runtime.assertIntegrity(), revalidate the composition-pinned
Approval.ahk helper, then run only its retained source bytes with [title,
effect], 60,000 ms, and windowsHide false. Map exit 0 to approved, exit 2 to
denied, and all other outcomes to failed with a fixed reason. An unconfirmed
termination also carries a private quarantine signal to the service.

Execution must call runtime.assertIntegrity(), run only service-provided,
preview-bound source bytes and fixed ordered arguments, and return only:

```ts
export interface StudioExecutionResult {
  status: 'succeeded' | 'failed';
  exitCode: number | null;
  durationMs: number;
  summary: string;
}
```

Discard captured streams and all local paths. Add regressions for helper tamper,
probe replacement, catalog check-to-launch replacement, delayed `close`, kill
failure, forced-kill escalation, exactly-once settlement/cleanup, and
unconfirmed-termination quarantine before implementing these amendments.

- [ ] **Step 5: Run focused tests, type check, and verify GREEN**

```powershell
npm run test:unit -- --runInBand --runTestsByPath Tests/unit/studio-ahk-runtime.test.ts Tests/unit/studio-ahk-adapters.test.ts
npm run check:types
```

Expected: both suites and type check exit 0.

- [ ] **Step 6: Commit only Task 2 files**

```powershell
git add -- src/studio/ahk-process.ts src/studio/ahk-runtime.ts src/studio/verified-script.ts src/studio/native-approval.ts src/studio/ahk-executor.ts Tests/unit/studio-ahk-runtime.test.ts Tests/unit/studio-ahk-adapters.test.ts
git commit -m "feat(studio): add trusted AutoHotkey runtime boundaries"
```

---

### Task 3: Preview and run state machine

**Files:**

- Create: src/studio/studio-service.ts
- Test: Tests/unit/studio-service.test.ts

**Interfaces:**

- Consumes the catalog, runtime, approval, and executor from Tasks 1–2.
- Produces StudioService and typed public errors for the HTTP layer.

- [ ] **Step 1: Write failing state-machine tests**

```ts
import { describe, expect, it, jest } from '@jest/globals';
import { StudioService } from '../../src/studio/studio-service.js';

it('stages a hash-bound run without opening approval or executing AHK', async () => {
  const approval = { confirm: jest.fn() };
  const executor = { execute: jest.fn() };
  const service = await createTestStudioService({
    approval,
    executor,
    ids: ['preview-1', 'run-1'],
  });
  const preview = await service.createPreview({
    macroId: 'show_desktop_message',
    parameters: { message: 'Hello' },
  });
  const run = service.requestRun({ previewId: preview.previewId });
  expect(run.state).toBe('pending_approval');
  expect(run.scriptHash).toMatch(/^[a-f0-9]{64}$/);
  expect(approval.confirm).not.toHaveBeenCalled();
  expect(executor.execute).not.toHaveBeenCalled();
});

it('requires native approval and consumes a run only once', async () => {
  const gate = deferred<{ decision: 'approved'; durationMs: number }>();
  const approval = { confirm: jest.fn(() => gate.promise) };
  const executor = {
    execute: jest.fn(async () => ({
      status: 'succeeded',
      exitCode: 0,
      durationMs: 5,
      summary: 'Done.',
    })),
  };
  const service = await createStagedTestService({ approval, executor });
  const first = service.approveRun('run-1');
  await expect(service.approveRun('run-1')).rejects.toMatchObject({
    code: 'state_conflict',
    statusCode: 409,
  });
  gate.resolve({ decision: 'approved', durationMs: 2 });
  await expect(first).resolves.toMatchObject({ state: 'succeeded' });
  expect(executor.execute).toHaveBeenCalledTimes(1);
});

it('fails closed when the script changes after preview', async () => {
  const fixture = await createStagedTestService({
    approval: {
      confirm: async () => ({ decision: 'approved', durationMs: 1 }),
    },
  });
  await fixture.replaceMacroBytes('changed');
  await expect(fixture.service.approveRun('run-1')).rejects.toMatchObject({
    code: 'integrity_failed',
    statusCode: 500,
  });
  expect(fixture.executor.execute).not.toHaveBeenCalled();
});
```

The test file must use a real temporary macro directory and real files. Include
named cases for strict validation, unknown IDs, five-minute preview/run expiry,
one-use preview, native denial, confirmation failure, global execution lock,
runtime-integrity failure, symlink or junction escape, and public DTO leakage.

- [ ] **Step 2: Run the service test and verify RED**

```powershell
npm run test:unit -- --runInBand --runTestsByPath Tests/unit/studio-service.test.ts
```

Expected: FAIL because StudioService does not exist.

- [ ] **Step 3: Implement public types, errors, and transitions**

Expose methods:

```ts
export class StudioService {
  constructor(dependencies: StudioServiceDependencies);
  getRuntimeStatus(): PublicRuntimeStatus;
  listMacros(): {
    macros: readonly PublicMacro[];
    runtime: PublicRuntimeStatus;
  };
  createPreview(input: {
    macroId: string;
    parameters: unknown;
  }): Promise<PublicPreview>;
  requestRun(input: { previewId: string }): PublicRun;
  getRun(runId: string): PublicRun;
  approveRun(runId: string): Promise<PublicRun>;
}
```

StudioServiceError codes must be:

```ts
type StudioServiceErrorCode =
  | 'invalid_input'
  | 'macro_not_found'
  | 'preview_not_found'
  | 'run_not_found'
  | 'preview_expired'
  | 'run_expired'
  | 'state_conflict'
  | 'execution_busy'
  | 'studio_busy'
  | 'execution_unavailable'
  | 'integrity_failed';
```

Use 400, 404, 409, 410, 500, or 503 as specified. Store canonical paths,
verified source bytes, and fixed arguments only in private maps. Public objects
include IDs, metadata, validated parameters, SHA-256, ISO timestamps, state, and
bounded result only.

createPreview() must validate, realpath both root and script, require a regular
.ahk beneath the root, hash and retain the exact bytes, and store a five-minute
preview. requestRun() must reject unavailable execution with 503, atomically
delete a valid preview, preserve a timestamped one-use tombstone, copy the
verified bytes, and store a five-minute pending run.

approveRun() must acquire one global lock before awaiting, set
awaiting_native_confirmation synchronously, require runtime integrity, await the
native gate, recheck runtime and script path/hash after approval, execute once,
pass only the preview-bound source bytes to the executor, store a terminal
state, and release the lock in finally.

Before each public operation, lazily sweep expired previews, inactive runs, and
expired tombstones. Active `awaiting_native_confirmation` and `running` records
must not be swept. Apply deterministic caps to preview, run, and tombstone
records: reject new live records with fixed `studio_busy` rather than evicting
them, and evict the oldest tombstone at its cap. Recheck capacity after async
preview hashing to close concurrent-admission races. Terminal runs remain
pollable for their full five-minute window. If either native adapter reports
unconfirmed termination, quarantine the global coordinator before `finally`
attempts release.

- [ ] **Step 4: Run service and boundary tests and verify GREEN**

```powershell
npm run test:unit -- --runInBand --runTestsByPath Tests/unit/studio-macro-catalog.test.ts Tests/unit/studio-ahk-runtime.test.ts Tests/unit/studio-ahk-adapters.test.ts Tests/unit/studio-service.test.ts
npm run check:types
```

Expected: all focused suites and type check exit 0.

- [ ] **Step 5: Commit only Task 3 files**

```powershell
git add -- src/studio/studio-service.ts Tests/unit/studio-service.test.ts
git commit -m "feat(studio): add preview and approval state machine"
```

---

### Task 4: Secure HTTP API, fallback UI, and four WebMCP tools

**Files:**

- Create: src/studio/studio-http.ts
- Create: src/studio/studio-page.ts
- Test: Tests/unit/studio-http.test.ts
- Test: Tests/contract/studio-webmcp.test.ts

**Interfaces:**

- Consumes only the public StudioService methods from Task 3.
- Produces mountStudio(app, service) and four classic-script assets: HTML, CSS,
  normal UI JavaScript, and WebMCP JavaScript.

- [ ] **Step 1: Write failing HTTP tests**

```ts
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mountStudio } from '../../src/studio/studio-http.js';

it('serves the page, assets, API, and security headers', async () => {
  const app = express();
  app.use(express.json());
  mountStudio(app, createHttpTestService());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch('http://127.0.0.1:' + port + '/studio');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain(
      "script-src 'self'"
    );
    expect(await response.text()).toContain('AHK Macro Studio');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
});

it('rejects every Studio POST without an exact loopback Origin', async () => {
  const fixture = await startStudioHttpFixture();
  try {
    for (const origin of [
      undefined,
      'https://127.0.0.1:' + fixture.port,
      'http://localhost:' + fixture.port,
      'https://viols.dev',
    ]) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (origin) headers.origin = origin;
      const response = await fetch(fixture.url + '/studio/api/previews', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          macroId: 'show_desktop_message',
          parameters: { message: 'Hi' },
        }),
      });
      expect(response.status).toBe(403);
    }
  } finally {
    await fixture.close();
  }
});
```

Add route-shape cases for 200/201 and typed 400/404/409/410/500/503 responses.
Error bodies must use fixed code and message fields and must not serialize
Error.stack.

- [ ] **Step 2: Write the failing WebMCP contract test**

Serve and evaluate a separate classic /studio/webmcp.js asset with node:vm.
Record registerTool calls and assert exactly:

```ts
expect(registrations.map(tool => [tool.name, tool.annotations])).toEqual([
  ['list_ahk_macros', { readOnlyHint: true }],
  ['preview_ahk_macro', { readOnlyHint: true }],
  ['request_ahk_macro_run', { readOnlyHint: false }],
  ['get_ahk_run_status', { readOnlyHint: true }],
]);
```

Assert every input schema has additionalProperties false. Invoke
request_ahk_macro_run.execute({ previewId }) and prove fetch receives only POST
/studio/api/runs. Assert no registered callback contains or requests /approve.

- [ ] **Step 3: Run HTTP and contract tests and verify RED**

```powershell
npm run test:unit -- --runInBand --runTestsByPath Tests/unit/studio-http.test.ts Tests/contract/studio-webmcp.test.ts
```

Expected: FAIL because Studio HTTP/page modules do not exist.

- [ ] **Step 4: Implement secure routes and fixed error mapping**

mountStudio() must derive the exact bound authority from the real socket so
ephemeral ports work and forwarding headers cannot widen the boundary:

```ts
function hasExactBoundLoopbackAuthority(req: Request): boolean {
  const host = req.headers.host;
  const localPort = req.socket.localPort;
  const remote = normalizeIpv4MappedAddress(req.socket.remoteAddress);
  if (!isLoopbackAddress(remote) || typeof localPort !== 'number') return false;
  const match = /^(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/.exec(
    host ?? ''
  );
  return Boolean(match && Number(match[1]) === localPort);
}
```

Apply this check to every Studio request. Every POST must additionally require
raw Origin to equal the exact normalized `http://<Host>` origin. Add modeled
remote-socket, spoofed Host/Origin, IPv4-mapped loopback, and local-port
mismatch regressions.

Expose a header-only boundary that applies the required no-store, nosniff,
no-referrer, and CSP headers before global middleware, while keeping
mountStudio() usable in standalone tests. Register the five JSON routes and map
only StudioServiceError fields; malformed JSON and all unknown errors return
fixed bodies without metadata. The fallback UI visibly reports local,
AutoHotkey, and WebMCP status, shows catalog targets, labels approval **Run on
this PC**, and clears/disables stale Stage state when WebMCP publishes a run.

- [ ] **Step 5: Implement external fallback UI and WebMCP scripts**

Serve /studio, /studio/styles.css, /studio/app.js, and /studio/webmcp.js. HTML
must reference both external scripts. The normal app script uses
createElement/textContent, handles list → preview → stage → status → approve,
and listens for ahk-studio-tool-result CustomEvents so WebMCP calls update the
same panels.

The WebMCP classic IIFE must feature-detect registerTool, register exactly four
tools sequentially with await, call same-origin fetch, dispatch visible result
events, and expose only its registration promise as
globalThis.\_\_ahkStudioWebMcpReady for the contract test.

Tool schemas:

```js
const previewInput = {
  type: 'object',
  properties: {
    macroId: { type: 'string', enum: ['show_desktop_message'] },
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', minLength: 1, maxLength: 120 } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  required: ['macroId', 'parameters'],
  additionalProperties: false,
};
```

- [ ] **Step 6: Run HTTP, contract, service, and parse tests and verify GREEN**

```powershell
npm run test:unit -- --runInBand --runTestsByPath Tests/unit/studio-http.test.ts Tests/contract/studio-webmcp.test.ts Tests/unit/studio-service.test.ts
npm run check:types
```

Expected: all suites and type check exit 0.

- [ ] **Step 7: Commit only Task 4 files**

```powershell
git add -- src/studio/studio-http.ts src/studio/studio-page.ts Tests/unit/studio-http.test.ts Tests/contract/studio-webmcp.test.ts
git commit -m "feat(studio): add secure WebMCP Macro Studio page"
```

---

### Task 5: Compose and mount Studio in the real HTTP server

**Files:**

- Create: src/studio/create-studio.ts
- Modify: src/server.ts near imports and startHttpMode() mount sequence
- Create: Tests/integration/studio-server.test.ts

**Interfaces:**

- createStudioService() composes process runner, runtime mode, catalog, pinned
  helper source, approval, executor, and service.
- startHttpMode() installs the Studio header-only boundary before existing
  host/origin/rate/auth/body middleware, but only for a configured loopback
  listener. It then awaits composition and mounts functional routes behind those
  protections, beside mountDashboard(), before /mcp. Non-loopback listeners
  never construct or mount Studio.

- [ ] **Step 1: Write the failing built-server smoke test**

The integration test must import only Node built-ins, reserve a free loopback
port, spawn dist/index.js --sse with cwd at the repository root, and always
terminate the child:

```ts
const child = spawn(process.execPath, ['dist/index.js', '--sse'], {
  cwd: process.cwd(),
  windowsHide: true,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    AHK_MCP_HTTP_HOST: '127.0.0.1',
    AHK_MCP_STUDIO_EXECUTION: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

Poll /studio for at most 90 seconds, then assert:

```ts
expect((await fetch(baseUrl + '/studio')).status).toBe(200);
expect((await fetch(baseUrl + '/studio/app.js')).status).toBe(200);
expect((await fetch(baseUrl + '/studio/webmcp.js')).status).toBe(200);
const catalog = await (await fetch(baseUrl + '/studio/api/macros')).json();
expect(catalog.runtime).toEqual({
  available: false,
  reason: 'disabled',
  message: 'Native execution is disabled.',
});
expect(catalog.macros).toHaveLength(1);
expect((await fetch(baseUrl + '/dashboard')).status).toBe(200);
```

- [ ] **Step 2: Build and run the smoke test to verify RED**

```powershell
npm run build
npm run test:integration -- --runInBand --runTestsByPath Tests/integration/studio-server.test.ts
```

Expected: build succeeds, then the integration test fails because /studio
returns 404.

- [ ] **Step 3: Implement composition and server mount**

createStudioService() must use:

```ts
const macroRoot = path.resolve(process.cwd(), 'scripts', 'studio');
const executionMode =
  process.env.AHK_MCP_STUDIO_EXECUTION === 'off' ? 'off' : 'on';
const runner = createStudioProcessRunner();
let runtime = await initializeAhkRuntime({
  executionMode,
  processRunner: runner,
  versionProbePath: path.join(macroRoot, 'VersionProbe.ahk'),
});
const catalog = createStudioMacroCatalog(macroRoot);
let approval = unavailableApprovalGateway;
if (runtime.available) {
  try {
    const approvalScript = await pinStudioScript(
      path.join(macroRoot, 'Approval.ahk'),
      { rootPath: macroRoot }
    );
    approval = createNativeApprovalGateway(runner, approvalScript);
  } catch {
    runtime = {
      available: false,
      reason: 'probe_failed',
      message: 'AutoHotkey runtime could not be verified.',
    };
  }
}
const executor = createStudioMacroExecutor(runner);
return new StudioService({ macroRoot, catalog, runtime, approval, executor });
```

Import createStudioService, mountStudioHeaderBoundary, mountStudio, and the
fixed Studio error sender in src/server.ts. In startHttpMode(), compute
eligibility from the configured listener host. For an eligible listener, install
the header-only boundary immediately after Express construction; global Host,
Origin, rate-limit, and bearer-auth rejection handlers must branch on that
boundary marker to return fixed Studio errors while still enforcing the check.
After json/urlencoded and routing-header validation, await the service and mount
it next to mountDashboard(). Do not construct or mount it otherwise.

The built integration regressions must cover non-loopback mount exclusion, fixed
Host/Origin/auth/parser/rate failures with Studio headers, an allowlisted wrong
Host port rejected against the actual socket local port, and a minimal
successful `/mcp` initialization proving the existing protocol boundary remains
intact.

- [ ] **Step 4: Rebuild and run smoke/focused tests to verify GREEN**

```powershell
npm run build
npm run test:integration -- --runInBand --runTestsByPath Tests/integration/studio-server.test.ts
npm run test:unit -- --runInBand --runTestsByPath Tests/unit/studio-macro-catalog.test.ts Tests/unit/studio-ahk-runtime.test.ts Tests/unit/studio-ahk-adapters.test.ts Tests/unit/studio-service.test.ts Tests/unit/studio-http.test.ts Tests/contract/studio-webmcp.test.ts
npm run check:types
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit only Task 5 files**

```powershell
git add -- src/studio/create-studio.ts src/server.ts Tests/integration/studio-server.test.ts
git commit -m "feat(studio): mount Macro Studio in the HTTP server"
```

---

### Task 6: Fresh verification and live browser/AHK proof

**Files:**

- No planned source edits. Any defect found must first receive a failing
  regression test in the owning task’s test file.

- [ ] **Step 1: Run the complete focused verification matrix**

```powershell
npm run test:unit -- --runInBand --runTestsByPath Tests/unit/studio-macro-catalog.test.ts Tests/unit/studio-ahk-runtime.test.ts Tests/unit/studio-ahk-adapters.test.ts Tests/unit/studio-service.test.ts Tests/unit/studio-http.test.ts Tests/contract/studio-webmcp.test.ts Tests/unit/dashboard-html.test.ts
npm run build
npm run check:types
npm run test:integration -- --runInBand --runTestsByPath Tests/integration/studio-server.test.ts
npx eslint src/studio --ext .ts
git diff --check
git status --short
```

Expected: focused tests, build, type check, integration smoke, Studio lint, and
diff check exit 0. git status must show only intentional Studio work plus the
preserved pre-existing dashboard changes.

- [ ] **Step 2: Restart the loopback server with native execution enabled**

Stop the managed process currently holding 127.0.0.1:8787, then run the freshly
built server from the repository root with:

```powershell
$env:PORT='8787'
$env:AHK_MCP_HTTP_HOST='127.0.0.1'
Remove-Item Env:AHK_MCP_STUDIO_EXECUTION -ErrorAction SilentlyContinue
node dist/index.js --sse
```

Keep the managed terminal session alive.

- [ ] **Step 3: Verify the real browser boundary**

Open http://127.0.0.1:8787/studio in the in-app browser and verify:

1. The fallback page renders with no console errors.
2. Exactly four Site Tools are discoverable.
3. list_ahk_macros → preview_ahk_macro → request_ahk_macro_run updates the
   visible catalog, preview, and pending-run panels.
4. Staging leaves the run in pending_approval and launches no selected macro.
5. The dashboard still renders at /dashboard.

- [ ] **Step 4: Verify native denial and approval**

Use the visible Run on this PC button for one staged run. Deny the native prompt
and verify the terminal state is denied and ShowDesktopMessage.ahk never
launches.

Stage a second run, approve the native prompt, observe the fixed AHK Macro
Studio message, close it, and verify the run becomes succeeded exactly once.

- [ ] **Step 5: Inspect the final diff and report the verified boundary**

```powershell
git status --short
git diff --stat
git log -6 --oneline
```

Report focused command results, live browser discovery, native denial/approval
evidence, the preserved unrelated dashboard changes, and the explicit fact that
no public tunnel was created.
