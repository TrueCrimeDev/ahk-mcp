# Tool Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse four overlapping analyze tools into one mode-driven
`AHK_Analyze`, delete the prose-edit `AHK_File_Edit_Advanced` anti-pattern,
rename `AHK_Summary` → `AHK_Reference`, rewrite every remaining tool's
description to a consistent template, and ship a hidden alias layer so old
clients keep working for one release.

**Architecture:** New `AHK_Analyze` lives in `src/tools/ahk-analyze.ts` and
dispatches on a `mode` param (`diagnostics` | `full` | `fix`) to existing
analyzer internals. Old tool names are wired into `src/core/tool-registry.ts` as
hidden aliases with arg-translation closures; they execute but are filtered out
of `tools/list`. Old tool source files are deleted. All remaining tool
descriptions are rewritten in-file to the "Use when / Don't use when / Example"
template.

**Tech Stack:** TypeScript, Zod, Jest, MCP SDK.

**Reference:** `docs/superpowers/specs/2026-04-22-tool-consolidation-design.md`

---

## Phase 1 — Build the new unified `AHK_Analyze`

### Task 1: Create `AHK_Analyze` tool file with arg schema and description

**Files:**

- Create: `src/tools/ahk-analyze.ts`

- [ ] **Step 1: Create the file with schema, description, and class skeleton**

Create `src/tools/ahk-analyze.ts`:

```ts
import { z } from 'zod';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import type { McpToolResponse } from '../types/mcp-types.js';
import { AhkDiagnosticsTool } from './ahk-analyze-diagnostics.js';
import { AhkAnalyzeTool as AhkAnalyzeCodeTool } from './ahk-analyze-code.js';
import { AhkLspTool } from './ahk-analyze-lsp.js';

export const AhkAnalyzeArgsSchema = z
  .object({
    code: z.string().min(1).optional(),
    filePath: z.string().optional(),

    mode: z.enum(['diagnostics', 'full', 'fix']).default('diagnostics'),

    severity: z.enum(['error', 'warning', 'info', 'all']).default('all'),
    maxIssues: z.number().int().positive().optional(),
    summaryOnly: z.boolean().default(false),

    fixLevel: z.enum(['safe', 'aggressive', 'style-only']).default('safe'),
    returnFixedCode: z.boolean().default(true),

    enableClaudeStandards: z.boolean().default(true),
    includeDocumentation: z.boolean().default(true),
    analyzeComplexity: z.boolean().default(false),
    bypassCache: z.boolean().default(false),
  })
  .refine(args => args.code || args.filePath, {
    message:
      'Either code or filePath must be provided (or an active file must be set)',
  });

export type AhkAnalyzeArgs = z.infer<typeof AhkAnalyzeArgsSchema>;

export const ahkAnalyzeToolDefinition = {
  name: 'AHK_Analyze',
  description: `Statically analyze AutoHotkey v2 code for syntax errors, style issues, and semantic problems. Returns diagnostics with line, column, and severity.

Use when:
  - You need to check a script for errors before running it.
  - The user pastes AHK code and asks what's wrong with it.
  - A script fails at runtime and you want static findings first.

Don't use when:
  - You need to actually execute the script -> use AHK_Run.
  - You need runtime behavior validation -> use AHK_Cloud_Validate.
  - The input is a VS Code Problems JSON dump -> use AHK_VSCode_Problems.

Example: { "filePath": "C:/scripts/app.ahk", "mode": "full" }`,
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          'AutoHotkey v2 code to analyze (wins over filePath if both given)',
      },
      filePath: {
        type: 'string',
        description: 'Path to .ahk file to analyze (defaults to active file)',
      },
      mode: {
        type: 'string',
        enum: ['diagnostics', 'full', 'fix'],
        default: 'diagnostics',
        description:
          'diagnostics = fast syntax + lint; full = deep analysis with standards/complexity; fix = analyze and apply fixes',
      },
      severity: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'all'],
        default: 'all',
      },
      maxIssues: {
        type: 'number',
        description: 'Cap returned issue count to reduce tokens',
      },
      summaryOnly: {
        type: 'boolean',
        default: false,
        description: 'Return counts only, no issue details',
      },
      fixLevel: {
        type: 'string',
        enum: ['safe', 'aggressive', 'style-only'],
        default: 'safe',
        description: 'Only used when mode=fix',
      },
      returnFixedCode: {
        type: 'boolean',
        default: true,
        description: 'Only used when mode=fix',
      },
      enableClaudeStandards: { type: 'boolean', default: true },
      includeDocumentation: { type: 'boolean', default: true },
      analyzeComplexity: { type: 'boolean', default: false },
      bypassCache: { type: 'boolean', default: false },
    },
    required: [],
  },
};

export class AhkAnalyzeUnifiedTool {
  private diagnosticsTool = new AhkDiagnosticsTool();
  private deepAnalyzeTool = new AhkAnalyzeCodeTool();
  private lspTool = new AhkLspTool();

  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkAnalyzeArgsSchema, 'AHK_Analyze');
    if (!parsed.success) return parsed.error;

    const { mode, code, filePath, ...rest } = parsed.data;

    if (code && filePath) {
      logger.warn('AHK_Analyze: both code and filePath provided; using code');
    }

    switch (mode) {
      case 'diagnostics':
        return this.diagnosticsTool.execute({
          code,
          filePath,
          severity: rest.severity,
          enableClaudeStandards: rest.enableClaudeStandards,
          bypassCache: rest.bypassCache,
        });
      case 'full':
        return this.deepAnalyzeTool.execute({
          code,
          filePath,
          includeDocumentation: rest.includeDocumentation,
          analyzeComplexity: rest.analyzeComplexity,
          severityFilter: rest.severity === 'all' ? undefined : [rest.severity],
          maxIssues: rest.maxIssues,
          summaryOnly: rest.summaryOnly,
        });
      case 'fix':
        return this.lspTool.execute({
          code,
          filePath,
          mode: 'fix',
          fixLevel: rest.fixLevel,
          returnFixedCode: rest.returnFixedCode,
        });
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build 2>&1 | tail -20` Expected: Build succeeds with no errors in
`src/tools/ahk-analyze.ts`. If errors, fix import names to match the actual
exports in the three referenced files (verify with
`grep "^export class" src/tools/ahk-analyze-{diagnostics,code,lsp}.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/tools/ahk-analyze.ts
git commit -m "feat: add unified AHK_Analyze tool with mode parameter"
```

---

### Task 2: Wire the new tool into server and registry

**Files:**

- Modify: `src/server.ts:113-200` (add instance)
- Modify: `src/core/tool-registry.ts:29-60` (register name)

- [ ] **Step 1: Add instance declaration in server.ts**

Open `src/server.ts`. Near line 116 (next to
`ahkAnalyzeToolInstance: AhkAnalyzeTool`), add:

```ts
public ahkAnalyzeUnifiedToolInstance: AhkAnalyzeUnifiedTool;
```

At the top of the file, add the import:

```ts
import { AhkAnalyzeUnifiedTool } from './tools/ahk-analyze.js';
```

In the constructor (around line 159), add:

```ts
this.ahkAnalyzeUnifiedToolInstance = new AhkAnalyzeUnifiedTool();
```

- [ ] **Step 2: Register the tool in tool-registry.ts**

Open `src/core/tool-registry.ts`. In the `coreTools` array inside
`registerCoreTools()`, add as the first entry:

```ts
{ name: 'AHK_Analyze_V2', instance: 'ahkAnalyzeUnifiedToolInstance' },
```

(We use `AHK_Analyze_V2` temporarily so it coexists with the existing
`AHK_Analyze`. Phase 3 swaps it to own the canonical name.)

- [ ] **Step 3: Update IToolServer interface**

Open `src/core/server-interface.ts`. Add:

```ts
ahkAnalyzeUnifiedToolInstance: AhkAnalyzeUnifiedTool;
```

(Import `AhkAnalyzeUnifiedTool` at top of file.)

- [ ] **Step 4: Build and verify no compile errors**

Run: `npm run build 2>&1 | tail -15` Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/core/tool-registry.ts src/core/server-interface.ts
git commit -m "feat: register AHK_Analyze_V2 unified tool"
```

---

### Task 3: Test each mode of `AHK_Analyze`

**Files:**

- Create: `Tests/unit/tools/ahk-analyze.test.ts`

- [ ] **Step 1: Create the test file**

```ts
import { AhkAnalyzeUnifiedTool } from '../../../src/tools/ahk-analyze.js';

describe('AHK_Analyze (unified)', () => {
  const tool = new AhkAnalyzeUnifiedTool();

  const sampleBrokenCode = '#Requires AutoHotkey v2.0\n\nMyVar :=\n';
  const sampleCleanCode =
    '#Requires AutoHotkey v2.0\n\nMyVar := "hello"\nMsgBox MyVar\n';

  test('mode=diagnostics returns diagnostic shape for broken code', async () => {
    const result = await tool.execute({
      code: sampleBrokenCode,
      mode: 'diagnostics',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
  });

  test('mode=full returns analysis shape for clean code', async () => {
    const result = await tool.execute({ code: sampleCleanCode, mode: 'full' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();
  });

  test('mode=fix returns fix result for broken code', async () => {
    const result = await tool.execute({
      code: sampleBrokenCode,
      mode: 'fix',
      fixLevel: 'safe',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();
  });

  test('defaults to mode=diagnostics when mode omitted', async () => {
    const result = await tool.execute({ code: sampleCleanCode });
    expect(result.isError).toBeFalsy();
  });

  test('rejects call with neither code nor filePath', async () => {
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
  });

  test('prefers code over filePath when both given', async () => {
    const result = await tool.execute({
      code: sampleCleanCode,
      filePath: '/nonexistent/path.ahk',
      mode: 'diagnostics',
    });
    expect(result.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run tests and confirm they pass**

Run: `npx jest Tests/unit/tools/ahk-analyze.test.ts --no-coverage` Expected: All
6 tests pass. If the "rejects with neither" test fails because the active file
fallback short-circuits validation, adjust the `refine()` in the schema to check
that _at minimum_ a file resolution is possible, or accept this as active-file
fallback behavior and update the test to mock the active file.

- [ ] **Step 3: Commit**

```bash
git add Tests/unit/tools/ahk-analyze.test.ts
git commit -m "test: cover all three modes of AHK_Analyze"
```

---

## Phase 2 — Alias layer in tool-registry

### Task 4: Add alias registration and `tools/list` filtering

**Files:**

- Modify: `src/core/tool-registry.ts`

- [ ] **Step 1: Add alias support to ToolRegistry class**

In `src/core/tool-registry.ts`, inside the `ToolRegistry` class, add a new
private field and method. Place the field near the existing `toolHandlers`:

```ts
private aliasNames = new Set<string>();

private registerAlias(oldName: string, handler: ToolHandler): void {
  this.toolHandlers.set(oldName, handler);
  this.aliasNames.add(oldName);
  friendlyLogger.debug?.(LogCategory.Server, `Registered deprecated alias: ${oldName}`);
}

public isAlias(name: string): boolean {
  return this.aliasNames.has(name);
}

public getVisibleToolNames(): string[] {
  return Array.from(this.toolHandlers.keys()).filter(n => !this.aliasNames.has(n));
}
```

- [ ] **Step 2: Find the tools/list handler and filter aliases**

Run:
`grep -n "getVisibleToolNames\|toolHandlers\|tools/list\|ListToolsRequestSchema" src/server.ts src/core/*.ts | head -20`

Then locate the code that builds the response to `ListToolsRequestSchema`.
Change it to call `getVisibleToolNames()` instead of iterating
`toolHandlers.keys()` directly. If the registration list is built elsewhere
(e.g. from a tool definitions array, not the registry), filter that array by
`!registry.isAlias(name)` instead.

- [ ] **Step 3: Build**

Run: `npm run build 2>&1 | tail -10` Expected: No compile errors.

- [ ] **Step 4: Commit**

```bash
git add src/core/tool-registry.ts src/server.ts
git commit -m "feat: add hidden alias support to tool registry"
```

---

### Task 5: Register the analyze-family aliases

**Files:**

- Modify: `src/core/tool-registry.ts`

- [ ] **Step 1: Add an alias registration section at the end of
      `registerCoreTools()`**

After the `coreTools.forEach(...)` block in `registerCoreTools()`, append:

```ts
// Deprecated aliases. Remove 30 days after merge.
const warnDeprecated = (oldName: string, newName: string) => {
  friendlyLogger.warn?.(
    LogCategory.Server,
    `[deprecated] '${oldName}' is deprecated; use '${newName}' instead`
  );
};

const unified = (args: unknown) =>
  this.serverInstance.ahkAnalyzeUnifiedToolInstance.execute(args);

this.registerAlias('AHK_Diagnostics', (args: ToolArgs) => {
  warnDeprecated('AHK_Diagnostics', 'AHK_Analyze');
  const a = (args ?? {}) as Record<string, unknown>;
  return unified({ ...a, mode: 'diagnostics' });
});

this.registerAlias('AHK_LSP', (args: ToolArgs) => {
  warnDeprecated('AHK_LSP', 'AHK_Analyze');
  const a = (args ?? {}) as Record<string, unknown>;
  const wasFix = a.mode === 'fix' || a.autoFix === true;
  return unified({ ...a, mode: wasFix ? 'fix' : 'diagnostics' });
});
```

- [ ] **Step 2: Remove the original `AHK_Diagnostics` and `AHK_LSP` entries from
      `coreTools`**

In the `coreTools` array earlier in the same function, delete these two lines:

```ts
{ name: 'AHK_Diagnostics', instance: 'ahkDiagnosticsToolInstance' },
{ name: 'AHK_LSP', instance: 'ahkLspToolInstance' },
```

This prevents double-registration (alias would clobber silently, but cleaner
this way).

- [ ] **Step 3: Build**

Run: `npm run build 2>&1 | tail -10` Expected: No errors. The instances still
exist on the server class (they're used internally by `AHK_Analyze`).

- [ ] **Step 4: Commit**

```bash
git add src/core/tool-registry.ts
git commit -m "feat: alias AHK_Diagnostics and AHK_LSP to AHK_Analyze"
```

---

### Task 6: Test alias forwarding

**Files:**

- Create: `Tests/unit/tools/aliases.test.ts`

- [ ] **Step 1: Write alias forwarding tests**

```ts
import { ToolRegistry } from '../../../src/core/tool-registry.js';
import type { IToolServer } from '../../../src/core/server-interface.js';
import { AhkAnalyzeUnifiedTool } from '../../../src/tools/ahk-analyze.js';
import { AhkDiagnosticsTool } from '../../../src/tools/ahk-analyze-diagnostics.js';

describe('Deprecated aliases', () => {
  const unifiedTool = new AhkAnalyzeUnifiedTool();
  const diagnosticsTool = new AhkDiagnosticsTool();

  const minimalServer = {
    ahkAnalyzeUnifiedToolInstance: unifiedTool,
    ahkDiagnosticsToolInstance: diagnosticsTool,
  } as unknown as IToolServer;

  const registry = new ToolRegistry(minimalServer);

  const sampleCode = '#Requires AutoHotkey v2.0\nMyVar := "hi"\n';

  test('AHK_Diagnostics is a hidden alias', () => {
    expect(registry.isAlias('AHK_Diagnostics')).toBe(true);
    expect(registry.getVisibleToolNames()).not.toContain('AHK_Diagnostics');
  });

  test('AHK_LSP is a hidden alias', () => {
    expect(registry.isAlias('AHK_LSP')).toBe(true);
  });

  test('AHK_Analyze is visible (not an alias)', () => {
    expect(registry.isAlias('AHK_Analyze_V2')).toBe(false);
    expect(registry.getVisibleToolNames()).toContain('AHK_Analyze_V2');
  });

  test('AHK_Diagnostics forwards to AHK_Analyze mode=diagnostics', async () => {
    const aliasHandler = (registry as any).toolHandlers.get('AHK_Diagnostics');
    expect(aliasHandler).toBeDefined();
    const result = await aliasHandler({ code: sampleCode });
    expect(result.isError).toBeFalsy();
  });

  test('AHK_LSP with mode=fix forwards to AHK_Analyze mode=fix', async () => {
    const aliasHandler = (registry as any).toolHandlers.get('AHK_LSP');
    const result = await aliasHandler({ code: sampleCode, mode: 'fix' });
    expect(result.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx jest Tests/unit/tools/aliases.test.ts --no-coverage` Expected: 5 tests
pass. If `isAlias` or `getVisibleToolNames` aren't on the registry yet, go back
to Task 4.

- [ ] **Step 3: Commit**

```bash
git add Tests/unit/tools/aliases.test.ts
git commit -m "test: verify deprecated aliases forward and stay hidden"
```

---

## Phase 3 — Swap canonical name and remove old tool files

### Task 7: Rename `AHK_Analyze_V2` → `AHK_Analyze` and remove old Analyze tool

**Files:**

- Modify: `src/core/tool-registry.ts`
- Modify: `src/server.ts`
- Delete: `src/tools/ahk-analyze-code.ts`
- Modify: `src/tools/ahk-analyze.ts` (remove import of deleted file)

- [ ] **Step 1: Inline the deep-analyze logic into the new tool**

The new `AHK_Analyze` currently imports `AhkAnalyzeCodeTool` from
`ahk-analyze-code.ts`. Before deleting that file, the `mode: 'full'` path needs
a new home.

Open `src/tools/ahk-analyze-code.ts`, locate the class `AhkAnalyzeTool` (note:
same class name as the new one — different export), and copy its `execute(...)`
method body plus any private helpers it uses. Move them into
`src/tools/ahk-analyze.ts` as a private method `executeFullAnalysis(args)`.

Then update the `case 'full':` branch in `AhkAnalyzeUnifiedTool.execute` to call
`this.executeFullAnalysis(...)` instead of `this.deepAnalyzeTool.execute(...)`,
and remove the `deepAnalyzeTool` field and its import.

- [ ] **Step 2: Build and test**

Run:
`npm run build 2>&1 | tail -10 && npx jest Tests/unit/tools/ahk-analyze.test.ts --no-coverage`
Expected: Builds and all 6 tests still pass.

- [ ] **Step 3: Change the registry entry name**

In `src/core/tool-registry.ts`, change:

```ts
{ name: 'AHK_Analyze_V2', instance: 'ahkAnalyzeUnifiedToolInstance' },
```

to:

```ts
{ name: 'AHK_Analyze', instance: 'ahkAnalyzeUnifiedToolInstance' },
```

Remove the old entry:

```ts
{ name: 'AHK_Analyze', instance: 'ahkAnalyzeToolInstance' },
```

(There were two `AHK_Analyze` lines in Phase 2 — remove the one pointing at
`ahkAnalyzeToolInstance`.)

- [ ] **Step 4: Add an `AHK_Analyze_Unified` alias**

Callers hitting the old `AHK_Analyze_Unified` name need forwarding. After the
existing aliases in `registerCoreTools()`, add:

```ts
this.registerAlias('AHK_Analyze_Unified', (args: ToolArgs) => {
  warnDeprecated('AHK_Analyze_Unified', 'AHK_Analyze');
  const a = { ...((args ?? {}) as Record<string, unknown>) };
  const oldMode = a.mode as string | undefined;
  const modeMap: Record<string, string> = {
    quick: 'diagnostics',
    deep: 'full',
    complete: 'full',
    fix: 'fix',
  };
  if (oldMode === 'vscode') {
    return Promise.resolve({
      isError: true,
      content: [
        {
          type: 'text',
          text: "mode='vscode' is no longer supported on AHK_Analyze. Use the AHK_VSCode_Problems tool instead.",
        },
      ],
    });
  }
  if (oldMode && modeMap[oldMode]) a.mode = modeMap[oldMode];
  return unified(a);
});
```

- [ ] **Step 5: Delete the old tool files**

```bash
rm src/tools/ahk-analyze-code.ts src/tools/ahk-analyze-complete.ts
```

Also remove the corresponding instance declarations from `src/server.ts` (around
line 116 / 159 for `ahkAnalyzeToolInstance`) and `src/core/server-interface.ts`.
Remove any references the registry still holds to `ahkAnalyzeToolInstance`.

- [ ] **Step 6: Build and test**

Run: `npm run build 2>&1 | tail -15 && npx jest Tests/unit/tools/ --no-coverage`
Expected: Clean build. All tests pass. If imports fail elsewhere (e.g.
`ahk-workflow-analyze-fix-run.ts` imported from the deleted files), update those
to import from `src/tools/ahk-analyze.ts`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: swap AHK_Analyze to the unified implementation, delete old code tool"
```

---

### Task 8: Delete `AhkDiagnosticsTool` and `AhkLspTool` source files

**Files:**

- Delete: `src/tools/ahk-analyze-diagnostics.ts`, `src/tools/ahk-analyze-lsp.ts`
- Modify: `src/tools/ahk-analyze.ts` (inline the logic the same way as Task 7)
- Modify: `src/server.ts`, `src/core/server-interface.ts` (remove fields)

- [ ] **Step 1: Inline diagnostics and LSP logic into `ahk-analyze.ts`**

Repeat the Task 7 Step 1 pattern: copy the `execute()` body of
`AhkDiagnosticsTool` (from `ahk-analyze-diagnostics.ts`) into a new private
method `executeDiagnostics` on `AhkAnalyzeUnifiedTool`. Same for `AhkLspTool` →
`executeFix`. Update the `switch (mode)` branches to call these instead of the
external tool instances. Remove the private fields and imports.

- [ ] **Step 2: Delete the files**

```bash
rm src/tools/ahk-analyze-diagnostics.ts src/tools/ahk-analyze-lsp.ts
```

Remove `ahkDiagnosticsToolInstance` and `ahkLspToolInstance` from
`src/server.ts` (declaration, constructor, and any array that includes them) and
`src/core/server-interface.ts`.

- [ ] **Step 3: Build and test**

Run: `npm run build 2>&1 | tail -15 && npx jest --no-coverage` Expected: Clean
build. All tests pass. If `ahk-workflow-analyze-fix-run.ts` referenced the
deleted tools, update it to use `AhkAnalyzeUnifiedTool`.

- [ ] **Step 4: Update alias test setup**

In `Tests/unit/tools/aliases.test.ts`, the `minimalServer` mock referenced
`ahkDiagnosticsToolInstance`. Remove that field — the alias now forwards through
the unified tool only.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: inline diagnostics/lsp logic into AHK_Analyze, delete old tools"
```

---

### Task 9: Rename `AHK_Summary` → `AHK_Reference`

**Files:**

- Rename: `src/tools/ahk-analyze-summary.ts` → `src/tools/ahk-reference.ts`
- Modify: `src/core/tool-registry.ts`
- Modify: `src/server.ts`, `src/core/server-interface.ts`

- [ ] **Step 1: Rename the file**

```bash
git mv src/tools/ahk-analyze-summary.ts src/tools/ahk-reference.ts
```

- [ ] **Step 2: Update the tool definition inside the file**

In `src/tools/ahk-reference.ts`:

- Rename the exported class `AhkSummaryTool` → `AhkReferenceTool`
- Rename the exported schema `AhkSummaryArgsSchema` → `AhkReferenceArgsSchema`
- Change the definition object:

```ts
export const ahkReferenceToolDefinition = {
  name: 'AHK_Reference',
  description: `Dump AutoHotkey v2 built-in variables, classes, methods, and coding standards as a reference sheet. Returns a structured summary the model can scan for symbol names and types.

Use when:
  - You want to remind yourself what built-in variables or classes AHK v2 has.
  - You need a list of standard library methods before writing code.
  - You're drafting code and want to confirm a symbol exists.

Don't use when:
  - You need documentation for a specific function -> use AHK_Doc_Search.
  - You need to analyze a user's code -> use AHK_Analyze.

Example: {}`,
  inputSchema: { type: 'object', properties: {}, required: [] },
};
```

- Update `safeParse(args, AhkReferenceArgsSchema, 'AHK_Reference')`.

- [ ] **Step 3: Update server.ts and server-interface.ts**

- In `src/server.ts`: change `AhkSummaryTool` import to `AhkReferenceTool`,
  rename `ahkSummaryToolInstance` to `ahkReferenceToolInstance`, update the
  constructor line.
- In `src/core/server-interface.ts`: same rename.

- [ ] **Step 4: Update registry**

In `src/core/tool-registry.ts`, change:

```ts
{ name: 'AHK_Summary', instance: 'ahkSummaryToolInstance' },
```

to:

```ts
{ name: 'AHK_Reference', instance: 'ahkReferenceToolInstance' },
```

Add alias after the existing alias block:

```ts
this.registerAlias('AHK_Summary', (args: ToolArgs) => {
  warnDeprecated('AHK_Summary', 'AHK_Reference');
  return this.serverInstance.ahkReferenceToolInstance.execute(args);
});
```

- [ ] **Step 5: Build and test**

Run: `npm run build 2>&1 | tail -10 && npx jest --no-coverage` Expected: Clean
build, tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: rename AHK_Summary to AHK_Reference"
```

---

### Task 10: Delete `AHK_File_Edit_Advanced`, register error alias

**Files:**

- Delete: `src/tools/ahk-file-edit-advanced.ts`
- Modify: `src/server.ts`, `src/core/server-interface.ts`
- Modify: `src/core/tool-registry.ts`

- [ ] **Step 1: Register the error alias**

In `src/core/tool-registry.ts`, alongside the other aliases, add:

```ts
this.registerAlias('AHK_File_Edit_Advanced', () => {
  warnDeprecated('AHK_File_Edit_Advanced', 'AHK_File_Edit');
  return Promise.resolve({
    isError: true,
    content: [
      {
        type: 'text',
        text: "AHK_File_Edit_Advanced has been removed. Use AHK_File_Edit with structured edit operations (action: 'replace' | 'insert_line' | etc.) instead. See AHK_File_Edit description for examples.",
      },
    ],
  });
});
```

Remove from `coreTools`:

```ts
{ name: 'AHK_File_Edit_Advanced', instance: 'ahkFileEditorToolInstance' },
```

- [ ] **Step 2: Delete the tool file and remove instance**

```bash
rm src/tools/ahk-file-edit-advanced.ts
```

Remove `ahkFileEditorToolInstance` from `src/server.ts` (import, field,
constructor assignment) and from `src/core/server-interface.ts`.

- [ ] **Step 3: Write a rejection test**

Add to `Tests/unit/tools/aliases.test.ts`:

```ts
test('AHK_File_Edit_Advanced returns a structured error', async () => {
  const aliasHandler = (registry as any).toolHandlers.get(
    'AHK_File_Edit_Advanced'
  );
  const result = await aliasHandler({ filePath: 'x.ahk', changes: 'whatever' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/AHK_File_Edit/);
});
```

- [ ] **Step 4: Build and test**

Run: `npm run build 2>&1 | tail -10 && npx jest --no-coverage` Expected: Clean
build, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove AHK_File_Edit_Advanced, register rejection alias"
```

---

## Phase 4 — Description template rewrite for remaining tools

### Task 11: Rewrite descriptions — batch 1 (file operations)

**Files (7):**

- `src/tools/ahk-file-active.ts`, `ahk-file-create.ts`, `ahk-file-detect.ts`,
  `ahk-file-edit.ts`, `ahk-file-edit-small.ts`, `ahk-file-edit-diff.ts`,
  `ahk-file-list.ts`, `ahk-file-recent.ts`, `ahk-file-view.ts`

- [ ] **Step 1: Apply template to each tool**

For each file above, replace the existing `description:` field on the tool
definition with the "Use when / Don't use when / Example" template.

**Template:**

```
<1-2 sentences: what it does and what it returns.>

Use when:
  - <concrete trigger>
  - <concrete trigger>

Don't use when:
  - <nearest alternative tool> -> use <that tool>

Example: <one realistic call as JSON>
```

**Worked example for `ahk-file-list.ts`:**

```ts
description: `List .ahk files in a directory. Returns file paths, sizes, and modification times.

Use when:
  - The user asks what AHK scripts exist in a folder.
  - You need to find a script but only know the directory.

Don't use when:
  - You already know the exact file path -> just use AHK_File_View.
  - You want recently-edited scripts -> use AHK_File_Recent.

Example: { "directoryPath": "C:/scripts" }`,
```

Write similarly concrete "Use when" / "Don't use when" entries for each file,
referencing neighbor tools in the same family.

- [ ] **Step 2: Lint and build**

Run: `npm run lint && npm run build 2>&1 | tail -10` Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add src/tools/ahk-file-*.ts
git commit -m "docs: rewrite file-operation tool descriptions to Use-when template"
```

---

### Task 12: Rewrite descriptions — batch 2 (library tools)

**Files (4):** `ahk-library-import.ts`, `ahk-library-info.ts`,
`ahk-library-list.ts`, `ahk-library-search.ts`

- [ ] **Step 1: Apply the same template to each**

These four form a natural cluster; make each description clearly disambiguate
from the others in the "Don't use when" section. Example for
`ahk-library-search.ts`:

```
Search installed AHK v2 libraries by keyword. Returns matching library names and snippets.

Use when:
  - You need a library but don't know its exact name.
  - You're looking for functionality across many libraries.

Don't use when:
  - You know the library name and want its contents -> use AHK_Library_Info.
  - You want a list of all installed libraries -> use AHK_Library_List.

Example: { "query": "mouse" }
```

- [ ] **Step 2: Lint, build, commit**

```bash
npm run lint && npm run build 2>&1 | tail -10
git add src/tools/ahk-library-*.ts
git commit -m "docs: rewrite library tool descriptions to Use-when template"
```

---

### Task 13: Rewrite descriptions — batch 3 (run / validate / debug)

**Files:** `ahk-run-script.ts`, `ahk-run-process.ts`, `ahk-run-debug.ts`,
`ahk-cloud-validate.ts`, `ahk-cloudahk-validate.ts`, `ahk-debug-dbgp.ts`,
`ahk-lint.ts`

- [ ] **Step 1: Apply template**

Emphasize the distinction between **local run** (`AHK_Run`), **cloud
validation** (`AHK_Cloud_Validate`), and **debugger** (`AHK_Debug_DBGp`) in
"Don't use when" entries. Example for `ahk-run-script.ts`:

```
Execute an AutoHotkey v2 script locally. Optionally waits for a window to appear. Returns exit code, stdout, stderr, and detected window title.

Use when:
  - You need to actually run a script and see its output.
  - You need to verify a GUI script shows a window.

Don't use when:
  - You want to check for errors without executing -> use AHK_Analyze.
  - You need cloud-side isolated validation -> use AHK_Cloud_Validate.
  - You need step-through debugging -> use AHK_Debug_DBGp.

Example: { "scriptPath": "C:/scripts/app.ahk", "waitForWindow": true }
```

- [ ] **Step 2: Lint, build, commit**

```bash
npm run lint && npm run build 2>&1 | tail -10
git add src/tools/ahk-run-*.ts src/tools/ahk-cloud*.ts src/tools/ahk-debug-*.ts src/tools/ahk-lint.ts
git commit -m "docs: rewrite run/validate/debug tool descriptions"
```

---

### Task 14: Rewrite descriptions — batch 4 (docs / context / search)

**Files:** `ahk-docs-context.ts`, `ahk-docs-prompts.ts`, `ahk-docs-samples.ts`,
`ahk-docs-search.ts`, `ahk-tools-search.ts`, `ahk-thqby-document-symbols.ts`

- [ ] **Step 1: Apply template**

The `AHK_Context_Injector` and `AHK_Sampling_Enhancer` tools currently have
placeholder names and opaque purposes — write descriptions that make their
purpose obvious, or flag them as candidates for deletion in a follow-up. Example
for `ahk-docs-search.ts`:

```
Search official AutoHotkey v2 documentation by keyword. Returns doc entries with title, category, and body.

Use when:
  - You need the official signature or description for an AHK v2 function/class/variable.
  - The user asks "how does X work in AHK?"

Don't use when:
  - You want a dump of all built-ins -> use AHK_Reference.
  - You want to find AHK MCP tools (not AHK language features) -> use AHK_Tools_Search.

Example: { "query": "SetTimer" }
```

- [ ] **Step 2: Lint, build, commit**

```bash
npm run lint && npm run build 2>&1 | tail -10
git add src/tools/ahk-docs-*.ts src/tools/ahk-tools-search.ts src/tools/ahk-thqby-document-symbols.ts
git commit -m "docs: rewrite docs/context/search tool descriptions"
```

---

### Task 15: Rewrite descriptions — batch 5 (system / config / meta)

**Files:** `ahk-system-analytics.ts`, `ahk-system-config.ts`,
`ahk-system-settings.ts`, `ahk-system-alpha.ts`, `ahk-cache-stats.ts`,
`ahk-smart-orchestrator.ts`, `ahk-workflow-analyze-fix-run.ts`,
`ahk-memory-context.ts`, `ahk-test-interactive.ts`, `ahk-trace-viewer.ts`,
`ahk-parse-ast.ts`, `ahk-analyze-vscode.ts`, `ahk-reference.ts`,
`ahk-vscode-open.ts`

- [ ] **Step 1: Apply template**

For `ahk-smart-orchestrator.ts`, be especially crisp in "Don't use when" — the
orchestrator should be the tool of last resort when the model can't decide;
every other path is preferable. Example:

```
Orchestrate a multi-step AHK workflow (analyze -> fix -> run -> report) in one call. Returns a structured trace of every step with timings.

Use when:
  - The user asks for an end-to-end "analyze, fix, and run this" in one shot.
  - You need a single call that produces a full diagnostic + execution report.

Don't use when:
  - You only need analysis -> use AHK_Analyze.
  - You only need execution -> use AHK_Run.
  - You only need a fix -> use AHK_Analyze with mode=fix.

Example: { "filePath": "C:/scripts/app.ahk" }
```

- [ ] **Step 2: Lint, build, commit**

```bash
npm run lint && npm run build 2>&1 | tail -10
git add src/tools/ahk-system-*.ts src/tools/ahk-cache-stats.ts src/tools/ahk-smart-orchestrator.ts src/tools/ahk-workflow-analyze-fix-run.ts src/tools/ahk-memory-context.ts src/tools/ahk-test-interactive.ts src/tools/ahk-trace-viewer.ts src/tools/ahk-parse-ast.ts src/tools/ahk-analyze-vscode.ts src/tools/ahk-reference.ts src/tools/ahk-vscode-open.ts
git commit -m "docs: rewrite system/config/meta tool descriptions"
```

---

### Task 16: Verify no tool still has a placeholder-style description

**Files:** all `src/tools/*.ts`

- [ ] **Step 1: Grep for placeholder descriptions**

Run:

```bash
grep -l "description: \`Ahk " src/tools/*.ts
```

Expected: no matches. Any file returned still has a `Ahk <toolname>`-style
description; go back and rewrite it with the template.

- [ ] **Step 2: Grep for template presence**

Run:

```bash
grep -L "Use when:" src/tools/*.ts | grep -v "\.test\.ts"
```

Expected: either empty, or only utility files that don't export a tool
definition. Any file listed that _does_ export a tool definition needs the
template applied.

- [ ] **Step 3: Commit any remaining fixes**

```bash
git add src/tools/
git commit -m "docs: apply Use-when template to remaining tools"
```

(Skip if no changes.)

---

## Phase 5 — Docs find-and-replace

### Task 17: Update docs/ references

**Files:** `docs/**/*.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Run find-and-replace as a single commit (for easy revert)**

```bash
cd /path/to/ahk-mcp

# Replace in docs/ and top-level .md files
find docs -name "*.md" -type f -exec sed -i \
  -e 's/\bAHK_Analyze_Unified\b/AHK_Analyze/g' \
  -e 's/\bAHK_Diagnostics\b/AHK_Analyze (mode=diagnostics)/g' \
  -e 's/\bAHK_Summary\b/AHK_Reference/g' \
  {} \;

sed -i \
  -e 's/\bAHK_Analyze_Unified\b/AHK_Analyze/g' \
  -e 's/\bAHK_Summary\b/AHK_Reference/g' \
  README.md CLAUDE.md
```

**Do not** auto-rewrite `AHK_LSP` — its old callers may have passed `mode=fix`,
which needs `AHK_Analyze (mode=fix)`, not `mode=diagnostics`. Handle `AHK_LSP`
mentions manually.

**Do not** auto-rewrite `AHK_File_Edit_Advanced` mentions — remove them
case-by-case.

- [ ] **Step 2: Diff review**

Run:

```bash
git diff --stat docs/ README.md CLAUDE.md | tail -20
```

Scan the stat output for surprises — if a changelog file has a huge diff, that's
probably historical content that should be reverted.

- [ ] **Step 3: Manually pass over `AHK_LSP` and `AHK_File_Edit_Advanced`
      mentions**

```bash
grep -rln "AHK_LSP\|AHK_File_Edit_Advanced" docs/ README.md CLAUDE.md
```

For each file returned, read the context and either (a) rewrite to the correct
`AHK_Analyze` mode, (b) remove the `AHK_File_Edit_Advanced` mention, or (c)
preserve as-is if it's a historical note/changelog.

- [ ] **Step 4: Commit**

```bash
git add docs/ README.md CLAUDE.md
git commit -m "docs: update tool-name references for consolidation"
```

---

## Phase 6 — Integration check

### Task 18: Run the full test suite

- [ ] **Step 1: Run unit tests**

Run: `npx jest --no-coverage 2>&1 | tail -25` Expected: All tests pass. Any test
that still references the old tool names will fail — go fix the test to use the
new names (or the alias, if testing alias behavior).

- [ ] **Step 2: Run integration tests**

Run: `npm run test:integration 2>&1 | tail -25` (or whatever the integration
command is per `package.json`) Expected: Pass. If any integration test addresses
a deleted tool directly, update it.

- [ ] **Step 3: Smoke test `tools/list` output**

Run the server smoke test:

```bash
npm run smoke:mcp
```

Then inspect the `tools/list` response. Verify:

- `AHK_Analyze` present
- `AHK_Reference` present
- `AHK_Diagnostics`, `AHK_LSP`, `AHK_Analyze_Unified`, `AHK_Summary`,
  `AHK_File_Edit_Advanced` **not** present
- Total tool count dropped by ~4–5

- [ ] **Step 4: Commit fixes**

```bash
git add -A
git commit -m "test: fix test references to renamed/removed tools"
```

(Skip if no changes.)

---

### Task 19: Manual smoke — Claude Desktop check

- [ ] **Step 1: Restart Claude Desktop with the new build**

After `npm run build`, Claude Desktop needs to reconnect to pick up the new tool
surface.

- [ ] **Step 2: Verify tool picking**

Ask Claude:

- "What's wrong with this broken AHK code?" + paste broken code. Expect: Claude
  picks `AHK_Analyze` with `mode: "diagnostics"`.
- "Please review this AHK script carefully." + paste code. Expect: Claude picks
  `AHK_Analyze` with `mode: "full"`.
- "Can you fix this AHK script?" + paste code. Expect: Claude picks
  `AHK_Analyze` with `mode: "fix"`.

If Claude reaches for `AHK_Smart_Orchestrator` on the simple cases, the
description boundaries need sharpening — iterate on the "Don't use when"
sections.

- [ ] **Step 3: No commit** — manual verification only.

---

### Task 20: Mark deprecation window in spec

**Files:** `docs/superpowers/specs/2026-04-22-tool-consolidation-design.md`

- [ ] **Step 1: Change Status header**

Change the top of the spec from:

```
**Status:** Design approved, awaiting implementation plan
```

to:

```
**Status:** Implemented. Deprecation window for aliases ends 2026-05-22.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-04-22-tool-consolidation-design.md
git commit -m "docs: mark consolidation spec implemented; record alias removal date"
```

---

## Done

All tasks above complete when:

- `npm run build` clean
- `npx jest` clean
- `tools/list` exposes `AHK_Analyze`, `AHK_Reference`, and the ~29 other tools —
  no deprecated names
- A calendar reminder exists for 2026-05-22 to delete the alias layer (outside
  this plan)
