# Handoff: add `AHK_Eval` + `AHK_Repl_Reset` to ahk-mcp, open a draft PR

You are Claude Code running locally on the user's Windows machine, inside the
this repo. A previous (remote,
sandboxed) session implemented this feature but could not reach this machine to
push it. This document is the complete spec — recreate the changes directly
against the real current repo, then push and open a draft PR. Everything you
need is below; you should not need network access except to push.

## Goal

Add two MCP tools backed by a single persistent AutoHotkey v2 interpreter
process:

- **`AHK_Eval`** — evaluate one AHK v2 expression; variables persist across
  calls.
- **`AHK_Repl_Reset`** — kill + respawn the interpreter, clearing all state.

The interpreter is the **alpha.30+Console** AHK fork (provides `Print()` BIF and
`#EnableEval`/`Eval()`) — the same binary this repo's run/diagnostics tools
already use.

## IMPORTANT — sort out the git mess FIRST (ask the user before destroying anything)

The repo is currently in a messy state, confirmed by the user:

- Local `master` has **diverged** from `origin/master` (≈39 local vs 43 remote
  commits) — not a fast-forward.
- There is a **large uncommitted working tree**, including edits to
  `src/core/config.ts`, `src/server.ts`, `src/core/tool-metadata.ts` — the very
  files this feature touches.
- `node_modules/` and `dist/` appear to be **tracked in git**, which is why
  `git status` is huge.

Do **not** blindly `reset --hard`, `stash`, or discard. First run `git status`
and `git log --oneline origin/master..master` and **show the user what their 39
local commits and uncommitted changes actually are**, then ask how they want to
handle them. Likely the cleanest route is:

1. Decide with the user what to do about the dirty tree (commit it elsewhere,
   stash, or leave it).
2. Create the feature branch from the **clean remote base**, not the messy local
   master:
   ```
   git fetch origin
   git checkout -b feat/persistent-repl-eval origin/master
   ```
   (Carry over only the feature changes below — not the unrelated local edits.)
3. If the uncommitted edits to `config.ts` / `server.ts` / `tool-metadata.ts`
   are unrelated work, keep them out of this branch. If they overlap, integrate
   carefully.

Confirm the branching plan with the user before proceeding.

## Architecture

A single long-lived AHK process runs `scripts/repl-host.ahk`. The Node side
(`src/repl.ts`) writes one framed command per line to the host's stdin and reads
back lineout delimited by a per-command end marker. State survives between calls
until reset. Wire format:

- stdin line: `<seq>\x1F<payload>\n` (payload: literal `\n`→`\x1A`, `\`→`\\`)
- stdout result lines, then end marker `\x1E<seq>\x1E`
- error lines are prefixed with `\x02`

Binary is resolved via `getAhkPath()` (env `AHK_PATH` → config `ahkPath`).
WSL→Windows arg translation reuses the shared `pathConverter`.

---

## NEW FILE: `scripts/repl-host.ahk`

```ahk
#Requires AutoHotkey v2.1-alpha.30
#EnableEval

; REPL host for the autohotkey-debug MCP server. The server keeps this process
; alive and feeds it one framed command per line on stdin; we Eval each
; expression and Print the result, then a per-command end marker so the server
; knows the lineout for that command is complete.
;
; Wire format (one line per command): <seq><0x1F><payload>
;   payload has literal newlines encoded as 0x1A and backslashes doubled.
; Eval is expression-level — full multi-line scripts go through ahk_run, not here.
; A dedicated blocking read loop is used (no GUI/message pump), which is more
; robust with Node's pipes than overlapped reads. Lib/AsyncProcessIO.ahk's
; AsyncStdinReader is the async fallback if line delivery ever stalls.

FIELD_SEP := Chr(0x1F)
NL_ENCODE := Chr(0x1A)
ERR_PREFIX := Chr(0x02)
MARK := Chr(0x1E)

stdin := FileOpen("*", "r", "UTF-8")
while !stdin.AtEOF {
    line := stdin.ReadLine()
    if line = ""
        continue
    ProcessLine(line)
}

ProcessLine(line) {
    sep := InStr(line, FIELD_SEP)
    if !sep
        return
    seq := SubStr(line, 1, sep - 1)
    payload := SubStr(line, sep + StrLen(FIELD_SEP))
    payload := StrReplace(payload, NL_ENCODE, "`n")
    payload := StrReplace(payload, "\\", "\")
    try {
        result := Eval(payload)
        Print("{}", result)
    } catch as e {
        Print("{}", ERR_PREFIX (Type(e) ": ") e.Message)
    }
    ; End marker — the value slot keeps any braces in seq from being parsed.
    Print("{}", MARK seq MARK)
}
```

---

## NEW FILE: `src/repl.ts`

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAhkPath } from './core/config.js';
import { pathConverter, PathFormat } from './utils/path-converter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * The AHK REPL host script, shipped in the repo's `scripts/` dir. Resolved
 * relative to the compiled `dist/` output (one level up), matching how the
 * tool registry resolves other shipped assets.
 */
const HOST_SCRIPT = join(__dirname, '..', 'scripts', 'repl-host.ahk');

const FIELD_SEP = '\x1F'; // separates <seq> from <payload> on the wire
const NL_ENCODE = '\x1A'; // stands in for a literal newline inside a payload
const ERR_PREFIX = '\x02'; // host tags error lines with this leading byte

/**
 * Translate a path into the Windows form the AutoHotkey `.exe` expects as an
 * argument. On native Windows the path is already Windows-style and passes
 * through untouched; under WSL a `/mnt/c/...` path is converted via ahk-mcp's
 * shared pathConverter (the same helper the run/diagnostics tools rely on).
 */
function toWinArg(p: string): string {
  const fmt = pathConverter.detectPathFormat(p);
  if (fmt === PathFormat.WSL || fmt === PathFormat.UNIX) {
    const r = pathConverter.wslToWindows(p);
    if (r.success) return r.convertedPath;
  }
  return p;
}

export interface EvalResult {
  output: string[];
  error: string[];
  timedOut: boolean;
}

interface Pending {
  marker: string;
  output: string[];
  error: string[];
  resolve: (r: EvalResult) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT = 10000;

/**
 * A persistent AutoHotkey interpreter. One binary stays alive running
 * repl-host.ahk; each `send` writes a framed expression to its stdin and reads
 * back the lineout up to a per-command end marker. Interpreter state (variables,
 * defined via Eval) persists across calls until `reset`.
 *
 * Requires the alpha.30+Console fork of AutoHotkey (`Print()` BIF, `#EnableEval`
 * / `Eval()`). The binary is resolved via `getAhkPath()` — the same path ahk-mcp
 * uses for its run/diagnostics tools — so set it once via `AHK_PATH` or the
 * `ahkPath` config value.
 */
export class ReplSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private pending: Pending | null = null;
  private stdoutBuf = '';

  private ensureStarted(): void {
    if (this.child) return;
    const bin = getAhkPath() ?? 'AutoHotkey64.exe';
    this.child = spawn(bin, ['/ErrorStdOut=utf-8', toWinArg(HOST_SCRIPT)], {
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      // Host load-time errors land here; attach to the in-flight command if any.
      const text = chunk.toString('utf-8');
      if (this.pending) {
        for (const line of text.split('\n')) {
          const t = line.replace(/\r$/, '');
          if (t) this.pending.error.push(t);
        }
      }
    });
    this.child.on('exit', () => {
      this.child = null;
      if (this.pending) {
        clearTimeout(this.pending.timer);
        const p = this.pending;
        this.pending = null;
        p.error.push('REPL host exited unexpectedly.');
        p.resolve({ output: p.output, error: p.error, timedOut: false });
      }
    });
    this.child.on('error', err => {
      if (this.pending) {
        this.pending.error.push(`spawn error: ${err.message} (binary: ${bin})`);
      }
    });
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString('utf-8');
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, nl).replace(/\r$/, '');
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      this.routeLine(line);
    }
  }

  private routeLine(line: string): void {
    const p = this.pending;
    if (!p) return; // unsolicited output (e.g. before first command)
    if (line === p.marker) {
      clearTimeout(p.timer);
      this.pending = null;
      p.resolve({ output: p.output, error: p.error, timedOut: false });
      return;
    }
    if (line.startsWith(ERR_PREFIX)) {
      p.error.push(line.slice(ERR_PREFIX.length));
    } else {
      p.output.push(line);
    }
  }

  /** Evaluate a single AHK expression in the live interpreter. */
  async send(
    expr: string,
    timeoutMs: number = DEFAULT_TIMEOUT
  ): Promise<EvalResult> {
    this.ensureStarted();
    if (this.pending) {
      throw new Error('REPL is busy with another expression.');
    }
    const seq = ++this.seq;
    const marker = `\x1E${seq}\x1E`;
    const payload = expr.replace(/\\/g, '\\\\').replace(/\n/g, NL_ENCODE);

    return await new Promise<EvalResult>(resolve => {
      const timer = setTimeout(() => {
        const p = this.pending;
        if (p && p.marker === marker) {
          this.pending = null;
          resolve({ output: p.output, error: p.error, timedOut: true });
        }
      }, timeoutMs);

      this.pending = { marker, output: [], error: [], resolve, timer };
      this.child!.stdin.write(`${seq}${FIELD_SEP}${payload}\n`);
    });
  }

  /** Kill the interpreter; the next `send` respawns a fresh one (state cleared). */
  reset(): void {
    this.stop();
  }

  /** Stop the interpreter and clear any pending command. */
  stop(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch {
        /* ignore */
      }
      this.child.kill();
      this.child = null;
    }
    this.stdoutBuf = '';
  }
}

/** Render an EvalResult into LLM-friendly text. */
export function formatEval(r: EvalResult): string {
  const lines: string[] = [];
  if (r.timedOut) lines.push('(timed out — interpreter still alive)');
  if (r.output.length) lines.push(r.output.join('\n'));
  if (r.error.length) lines.push('ERROR:', r.error.join('\n'));
  if (!lines.length) lines.push('(no output)');
  return lines.join('\n');
}
```

> NOTE: verify `src/utils/path-converter.ts` exports `pathConverter` and
> `PathFormat` with `detectPathFormat()` and `wslToWindows()`. If the current
> repo's API differs, adapt `toWinArg` accordingly (on native Windows it can be
> a passthrough).

---

## NEW FILE: `src/tools/ahk-eval.ts`

```typescript
import { z } from 'zod';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import type { McpToolResponse } from '../types/mcp-types.js';
import { ReplSession, formatEval } from '../repl.js';

/**
 * Shared persistent interpreter backing AHK_Eval / AHK_Repl_Reset. State
 * (variables defined via Eval) survives across calls until the session is reset.
 * Exported so the server can stop it on shutdown.
 */
export const replSession = new ReplSession();

// ---------------------------------------------------------------------------
// AHK_Eval
// ---------------------------------------------------------------------------

export const AhkEvalArgsSchema = z.object({
  expr: z.string().describe('A single AHK v2 expression, e.g. "2**10".'),
  timeout_ms: z.number().optional(),
});

export const ahkEvalToolDefinition = {
  name: 'AHK_Eval',
  description: `Ahk eval
Evaluate a single AutoHotkey v2 expression in a PERSISTENT interpreter; variables
persist across calls until AHK_Repl_Reset. Expression-level only — use AHK_Run for
multi-line scripts. Requires the alpha.30+Console fork (Print()/Eval()).
Example: { "expr": "x := 41" } then { "expr": "x + 1" } → 42.`,
  inputSchema: {
    type: 'object',
    properties: {
      expr: {
        type: 'string',
        description: 'A single AHK v2 expression, e.g. "2**10".',
      },
      timeout_ms: {
        type: 'number',
        description: 'Per-call timeout in milliseconds (default 10000).',
      },
    },
    required: ['expr'],
  },
};

export class AhkEvalTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkEvalArgsSchema, 'AHK_Eval');
    if (!parsed.success) return parsed.error;

    const { expr, timeout_ms } = parsed.data;

    try {
      const result = await replSession.send(expr, timeout_ms);
      return { content: [{ type: 'text', text: formatEval(result) }] };
    } catch (error) {
      logger.error('Error in AHK_Eval tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `[ERROR]: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// AHK_Repl_Reset
// ---------------------------------------------------------------------------

export const AhkReplResetArgsSchema = z.object({});

export const ahkReplResetToolDefinition = {
  name: 'AHK_Repl_Reset',
  description: `Ahk repl reset
Restart the persistent AHK_Eval interpreter, clearing all variables and state.`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export class AhkReplResetTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkReplResetArgsSchema, 'AHK_Repl_Reset');
    if (!parsed.success) return parsed.error;

    try {
      replSession.reset();
      return {
        content: [{ type: 'text', text: 'Interpreter reset — state cleared.' }],
      };
    } catch (error) {
      logger.error('Error in AHK_Repl_Reset tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `[ERROR]: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
}
```

> NOTE: confirm import paths against the real repo: `../logger.js`,
> `../core/validation-middleware.js` (`safeParse`), `../types/mcp-types.js`
> (`McpToolResponse`). Match whatever the sibling tools in `src/tools/` actually
> import.

---

## MODIFY: `src/core/config.ts`

In the `AhkMcpConfig` interface, add two optional fields:

```typescript
  /** Absolute path to the AutoHotkey v2 executable used for running/eval. */
  ahkPath?: string;
  /** VS Code workspace (.code-workspace file or folder) opened by AHK_VSCode_Open. */
  vscodeWorkspace?: string;
```

Add two exported functions (place them after `saveConfig`, before
`normalizeDir`):

```typescript
/**
 * Resolve the configured AutoHotkey v2 executable path.
 * Precedence: the AHK_PATH environment override, then the persisted `ahkPath`
 * config value. Returns undefined when neither is set, so callers can fall back
 * to a PATH lookup (e.g. `where AutoHotkey64.exe`).
 */
export function getAhkPath(): string | undefined {
  const fromEnv = process.env.AHK_PATH?.trim();
  if (fromEnv) return fromEnv;
  const cfg = loadConfig();
  return cfg.ahkPath?.trim() || undefined;
}

/**
 * Resolve the configured VS Code workspace path (persisted `vscodeWorkspace`).
 */
export function getVscodeWorkspace(): string | undefined {
  const cfg = loadConfig();
  return cfg.vscodeWorkspace?.trim() || undefined;
}
```

> These also fix 8 pre-existing build errors: `getAhkPath` is imported by
> `ahk-run-script.ts`, `ahk-cloud-validate.ts`, `ahk-test-interactive.ts`;
> `getVscodeWorkspace` by `ahk-vscode-open.ts`; `ahkPath`/`vscodeWorkspace` are
> used by `ahk-system-config.ts`. **If the current repo already defines these**
> (because of the divergence), do not duplicate — reconcile instead. Run a build
> to confirm.

---

## MODIFY: `src/core/server-interface.ts`

In the `IToolServer` interface, add (next to the other `...ToolInstance`
members):

```typescript
ahkEvalToolInstance: IExecutableTool;
ahkReplResetToolInstance: IExecutableTool;
```

---

## MODIFY: `src/core/tool-metadata.ts`

Add the import near the other tool-definition imports:

```typescript
import {
  ahkEvalToolDefinition,
  ahkReplResetToolDefinition,
} from '../tools/ahk-eval.js';
```

Add two entries in the **execution** category of the `TOOL_METADATA` array:

```typescript
  entry(ahkEvalToolDefinition, 'eval', 'execution'),
  entry(ahkReplResetToolDefinition, 'repl-reset', 'execution'),
```

---

## MODIFY: `src/core/tool-registry.ts`

In the `coreTools` array (where each entry maps a tool name to its instance
field), add:

```typescript
      { name: 'AHK_Eval', instance: 'ahkEvalToolInstance' },
      { name: 'AHK_Repl_Reset', instance: 'ahkReplResetToolInstance' },
```

---

## MODIFY: `src/server.ts`

1. Add the import near the other tool imports:

```typescript
import {
  AhkEvalTool,
  AhkReplResetTool,
  replSession,
} from './tools/ahk-eval.js';
```

2. Add the public field declarations (next to the other `...ToolInstance`
   fields):

```typescript
  public ahkEvalToolInstance: AhkEvalTool;
  public ahkReplResetToolInstance: AhkReplResetTool;
```

3. In the constructor (next to the other `this.x = new XTool();` lines):

```typescript
this.ahkEvalToolInstance = new AhkEvalTool();
this.ahkReplResetToolInstance = new AhkReplResetTool();
```

4. In `handleShutdownSignal()` (near the top, before the existing shutdownHook
   logic):

```typescript
// Stop the persistent AHK_Eval interpreter so its child process doesn't linger.
try {
  replSession.stop();
} catch (error) {
  logger.error('Failed to stop REPL session:', error);
}
```

---

## Build, commit, push, PR

```
npm install        # if needed
npm run build      # MUST be zero type errors — this is the gate
```

Then:

```
git add scripts/repl-host.ahk src/repl.ts src/tools/ahk-eval.ts \
        src/core/config.ts src/core/server-interface.ts \
        src/core/tool-metadata.ts src/core/tool-registry.ts src/server.ts
git commit -m "Add persistent AHK interpreter tools (AHK_Eval, AHK_Repl_Reset)"
git push -u origin feat/persistent-repl-eval
gh pr create --draft \
  --title "feat: persistent AHK interpreter (AHK_Eval, AHK_Repl_Reset)" \
  --body "Adds AHK_Eval and AHK_Repl_Reset backed by a single persistent alpha.30+Console AHK interpreter (variables persist across calls until reset). Also defines the previously-missing getAhkPath()/getVscodeWorkspace() config helpers and ahkPath/vscodeWorkspace fields, fixing 8 pre-existing build errors."
```

## Live verification (needs the alpha.30+Console binary; set AHK_PATH or config ahkPath)

- `AHK_Eval {"expr":"2**10"}` → `1024`
- `AHK_Eval {"expr":"x := 41"}` then `AHK_Eval {"expr":"x + 1"}` → `42` (state
  persists)
- `AHK_Repl_Reset` then `AHK_Eval {"expr":"x"}` → error (state cleared)
