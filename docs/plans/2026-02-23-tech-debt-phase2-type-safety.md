# Technical Debt Phase 2: Type Safety Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Eliminate all 169 type-safety warnings (144 `no-explicit-any` + 25
`no-non-null-assertion`) across 40 source files.

**Architecture:** Three fix patterns account for ~95% of warnings: (1) variadic
`any[]` → `unknown[]`, (2) map/filter callbacks on already-typed arrays (remove
annotation, let TypeScript infer), (3) regex group non-null assertions →
optional chaining. One new interface (`AhkDocumentationFull`) is needed to
properly type unstructured JSON doc data.

**Tech Stack:** TypeScript strict mode, ESLint `@typescript-eslint`, existing
types in `src/types/tool-types.ts` and `src/types/mcp-types.ts`.

---

## Pre-conditions

### Status check

Before starting, confirm current warning count:

```bash
cd /path/to/ahk-mcp
npm run lint 2>&1 | tail -3
# Expected: ✖ 169 problems (0 errors, 169 warnings)
```

> **Note:** The Jan-12 bug fixes and Phase 1 unused-code cleanup are already
> complete. This plan targets only the remaining 169 warnings.

---

## Task 1: Define `AhkDocumentationFull` interface

**Files:**

- Modify: `src/types/tool-types.ts` (after line 151)

This interface is referenced in Tasks 2, 3, 5, and 6. Do it first.

**Step 1: Add interface after `AhkIndex`**

Open `src/types/tool-types.ts`. After the closing `}` of `AhkIndex` (line ~151),
add:

```typescript
/** Shape of items in ahk_documentation_full.json */
export interface AhkDocFullVariable {
  Name: string;
  Type?: string;
  ReturnType?: string;
  Description?: string;
}

export interface AhkDocFullClassItem {
  Name: string;
  Type?: string;
  Path?: string;
  ReturnType?: string;
  Description?: string;
}

export interface AhkDocumentationFull {
  data: {
    BuiltInVariables?: AhkDocFullVariable[];
    Classes?: AhkDocFullClassItem[];
    [key: string]: unknown;
  };
}
```

**Step 2: Verify TypeScript still compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
# Expected: no errors
```

**Step 3: Commit**

```bash
git add src/types/tool-types.ts
git commit -m "feat(types): add AhkDocumentationFull interface for typed doc data"
```

---

## Task 2: Fix `src/core/loader.ts` (10 warnings → 0)

**Files:**

- Modify: `src/core/loader.ts`

**Step 1: Update imports**

Add `AhkDocumentationFull`, `AhkIndexFunction`, `AhkIndexClass`,
`AhkIndexVariable` to the import from `../types/index.js`:

```typescript
// BEFORE
import type { AhkIndex } from '../types/index.js';

// AFTER
import type {
  AhkIndex,
  AhkDocumentationFull,
  AhkIndexFunction,
  AhkIndexClass,
  AhkIndexVariable,
} from '../types/index.js';
```

**Step 2: Fix `ahkDocumentationFull` variable type (line 9)**

```typescript
// BEFORE
let ahkDocumentationFull: any = null;

// AFTER
let ahkDocumentationFull: AhkDocumentationFull | null = null;
```

**Step 3: Fix `dynamicJsonImport` generic default (line 17)**

```typescript
// BEFORE
async function dynamicJsonImport<T = any>(relPathFromData: string): Promise<T> {

// AFTER
async function dynamicJsonImport<T>(relPathFromData: string): Promise<T> {
```

**Step 4: Fix `mod as any` casts in `dynamicJsonImport` (lines 21-23)**

```typescript
// BEFORE
const mod = await import(relFromCore, { with: { type: 'json' } } as any);
// Some bundlers put value on .default
return (mod as any).default ?? (mod as any);

// AFTER
const mod = await import(relFromCore, { with: { type: 'json' } } as unknown);
// Some bundlers put value on .default
const m = mod as { default?: T } & T;
return m.default ?? (mod as T);
```

**Step 5: Fix `getAhkDocumentationFull` return type (line 76)**

```typescript
// BEFORE
export function getAhkDocumentationFull(): any {

// AFTER
export function getAhkDocumentationFull(): AhkDocumentationFull | null {
```

**Step 6: Fix search function return types (lines 83, 97, 111)**

```typescript
// BEFORE
export function searchFunctions(query: string): any[] {
// ...
export function searchClasses(query: string): any[] {
// ...
export function searchVariables(query: string): any[] {

// AFTER
export function searchFunctions(query: string): AhkIndexFunction[] {
// ...
export function searchClasses(query: string): AhkIndexClass[] {
// ...
export function searchVariables(query: string): AhkIndexVariable[] {
```

**Step 7: Verify and commit**

```bash
npm run lint src/core/loader.ts
# Expected: 0 warnings

npx tsc --noEmit 2>&1 | head -20
# Expected: no new errors

git add src/core/loader.ts
git commit -m "fix(types): remove any types from loader.ts, use proper typed interfaces"
```

---

## Task 3: Fix `src/tools/ahk-analyze-summary.ts` (13 warnings → 0)

**Files:**

- Modify: `src/tools/ahk-analyze-summary.ts`

**Step 1: Update imports**

```typescript
// Add to existing imports from types
import type {
  AhkDocumentationFull,
  AhkDocFullVariable,
  AhkDocFullClassItem,
  AhkIndexVariable,
  AhkIndexClass,
  AhkIndexMethod,
} from '../types/tool-types.js';
```

**Step 2: Fix execute return type (line 21)**

```typescript
// BEFORE
async execute(args: unknown): Promise<any> {

// AFTER
async execute(args: unknown): Promise<McpToolResponse> {
```

Also add `McpToolResponse` to imports from `../types/mcp-types.js`.

**Step 3: Fix typed arrays (lines 31–33)**

```typescript
// BEFORE
let variables: any[] = [];
let classes: any[] = [];
let methods: any[] = [];

// AFTER
let variables: AhkIndexVariable[] = [];
let classes: AhkIndexClass[] = [];
let methods: AhkIndexMethod[] = [];
```

**Step 4: Fix `fullDocs` type and callbacks (lines 36–66)**

The `fullDocs` comes from `getAhkDocumentationFull()` which now returns
`AhkDocumentationFull | null`. Update the conditional:

```typescript
// BEFORE
if (fullDocs && fullDocs.data) {
  if (fullDocs.data.BuiltInVariables) {
    variables = fullDocs.data.BuiltInVariables.map((v: any) => ({
    // ...
    const classItems = fullDocs.data.Classes.filter(
      (item: any) => item.Type === 'Class' || !item.Path
    );
    const methodItems = fullDocs.data.Classes.filter(
      (item: any) => item.Type === 'Method' && item.Path
    );
    classes = classItems.map((c: any) => ({
    methods = methodItems.map((m: any) => ({

// AFTER
if (fullDocs?.data) {
  if (fullDocs.data.BuiltInVariables) {
    variables = fullDocs.data.BuiltInVariables.map((v: AhkDocFullVariable) => ({
    // ...
    const classItems = (fullDocs.data.Classes ?? []).filter(
      (item: AhkDocFullClassItem) => item.Type === 'Class' || !item.Path
    );
    const methodItems = (fullDocs.data.Classes ?? []).filter(
      (item: AhkDocFullClassItem) => item.Type === 'Method' && item.Path
    );
    classes = classItems.map((c: AhkDocFullClassItem) => ({
    methods = methodItems.map((m: AhkDocFullClassItem) => ({
```

**Step 5: Fix index fallback callbacks (lines 70–86)**

The index data (`index.variables`, `.classes`, `.methods`) is fully typed by
`AhkIndex`. Remove the `: any` annotations — TypeScript will infer the correct
type:

```typescript
// BEFORE
variables = (index.variables || []).map((v: any) => ({
classes = (index.classes || []).map((c: any) => ({
methods = (index.methods || []).map((m: any) => ({
const rules = (standards || []).map((s: any) => ({

// AFTER
variables = (index.variables ?? []).map(v => ({
classes = (index.classes ?? []).map(c => ({
methods = (index.methods ?? []).map(m => ({
const rules = (standards ?? []).map(s => ({
```

**Step 6: Verify and commit**

```bash
npm run lint src/tools/ahk-analyze-summary.ts
# Expected: 0 warnings

npx tsc --noEmit 2>&1 | head -20

git add src/tools/ahk-analyze-summary.ts
git commit -m "fix(types): type ahk-analyze-summary.ts, use AhkDocumentationFull interface"
```

---

## Task 4: Fix `src/lsp/diagnostics.ts` (14 warnings → 0)

**Files:**

- Modify: `src/lsp/diagnostics.ts`

All 14 warnings are non-null assertions on regex named groups
(`fnMatch.groups!.name!`) that appear twice each (7 lines × 2 assertions = 14
warnings).

**Step 1: Understand the pattern**

The code looks like:

```typescript
const fnMatch = trimmed.match(/^(?<name>[A-Za-z_]\w*)\s*\([^)]*\)\s*(\{|=>)?/);
if (fnMatch) {
  const name = (fnMatch.groups?.name || '').toLowerCase();
  // ... later:
  const nameStartInTrimmed = trimmed.indexOf(fnMatch.groups!.name!);  // ← warning
  const endChar = startChar + fnMatch.groups!.name!.length;           // ← warning
  // ... and:
  `Duplicate function definition: ${fnMatch.groups!.name!}`           // ← warning
```

After `if (fnMatch)`, `groups` is guaranteed to be an object (the regex has
named groups), and `name` captured something since the regex matched. The `!` is
logically safe but TypeScript can't prove it.

**Step 2: Fix all 7 affected lines**

For each occurrence of `fnMatch.groups!.name!` and
`leadingIdentMatch.groups!.id!`, replace with optional chaining + nullish
coalescing:

```typescript
// BEFORE
fnMatch.groups!.name!(
  // AFTER
  fnMatch.groups?.name ?? ''
);
```

Similarly:

```typescript
// BEFORE
leadingIdentMatch.groups!.id!(
  // AFTER
  leadingIdentMatch.groups?.id ?? ''
);
```

Apply to all 7 locations at lines 354, 357, 362, 412, 421, 422, 425.

**Step 3: Verify and commit**

```bash
npm run lint src/lsp/diagnostics.ts
# Expected: 0 warnings

npm run test
# Expected: all tests pass

git add src/lsp/diagnostics.ts
git commit -m "fix(types): replace non-null assertions with optional chaining in diagnostics.ts"
```

---

## Task 5: Fix `src/logger.ts` (7 warnings → 0)

**Files:**

- Modify: `src/logger.ts`

All warnings are variadic `any[]` parameters that should be `unknown[]`.

**Step 1: Replace all `any` with `unknown`**

```typescript
// BEFORE
private serialize(arg: any, level: string): string {
private log(level: string, ...args: any[]): void {
error(...args: any[]): void {
warn(...args: any[]): void {
info(...args: any[]): void {
debug(...args: any[]): void {
console.log = (...args: any[]) => {

// AFTER
private serialize(arg: unknown, level: string): string {
private log(level: string, ...args: unknown[]): void {
error(...args: unknown[]): void {
warn(...args: unknown[]): void {
info(...args: unknown[]): void {
debug(...args: unknown[]): void {
console.log = (...args: unknown[]) => {
```

**Step 2: Check `serialize` body for type narrowing compatibility**

The existing body already uses `typeof arg === 'string'` and
`typeof arg !== 'object'` guards, which work correctly with `unknown`. Verify no
TypeScript errors.

**Step 3: Verify and commit**

```bash
npm run lint src/logger.ts
# Expected: 0 warnings

npx tsc --noEmit 2>&1 | grep logger
# Expected: no errors

git add src/logger.ts
git commit -m "fix(types): replace any[] with unknown[] in logger variadic methods"
```

---

## Task 6: Fix docs tools batch (35 warnings → 0)

**Files:**

- Modify: `src/tools/ahk-docs-context.ts` (17)
- Modify: `src/tools/ahk-docs-search.ts` (10)
- Modify: `src/tools/ahk-docs-samples.ts` (8)

These files share common patterns (processing doc data, returning results).

### 6a: Fix `ahk-docs-context.ts`

**Step 1: Get the warning lines**

```bash
npm run lint src/tools/ahk-docs-context.ts 2>&1 | grep "warning"
```

**Step 2: Fix `data: any` in interface (line 63)**

```typescript
// BEFORE
data: any;

// AFTER
data: unknown;
```

**Step 3: Fix remaining `any` usages**

For map/filter callbacks on typed arrays — remove the `: any` annotation (let
TypeScript infer). For unstructured JSON data, use `unknown` with `as` casts
where needed, or extend `AhkDocumentationFull`.

Pattern to follow:

```typescript
// BEFORE
someArray.filter((item: any) => item.field === value);

// AFTER
someArray.filter(item => (item as SomeKnownType).field === value);
// OR if the array is already typed:
someArray.filter(item => item.field === value);
```

**Step 4: Fix non-null assertions (lines 229, 666, 952)**

```typescript
// BEFORE
someValue!;

// AFTER
someValue ?? ''; // for strings
someValue ?? []; // for arrays
someValue; // if context makes it clear it's guaranteed non-null
```

**Step 5: Verify**

```bash
npm run lint src/tools/ahk-docs-context.ts
```

### 6b: Fix `ahk-docs-search.ts` and `ahk-docs-samples.ts`

Follow the same approach:

1. `npm run lint src/tools/ahk-docs-search.ts 2>&1 | grep warning` — note the
   lines
2. For map/filter on typed arrays: remove `: any` annotation
3. For unknown JSON data: use `unknown` + narrowing

**Step 6: Commit batch**

```bash
npm run lint src/tools/ahk-docs-context.ts src/tools/ahk-docs-search.ts src/tools/ahk-docs-samples.ts
# Expected: 0 warnings for these files

npx tsc --noEmit 2>&1 | head -20

git add src/tools/ahk-docs-context.ts src/tools/ahk-docs-search.ts src/tools/ahk-docs-samples.ts
git commit -m "fix(types): replace any with typed interfaces in docs tools"
```

---

## Task 7: Fix `ahk-analyze-diagnostics.ts` + `ahk-file-edit-small.ts` (16 warnings → 0)

**Files:**

- Modify: `src/tools/ahk-analyze-diagnostics.ts` (7)
- Modify: `src/tools/ahk-file-edit-small.ts` (9)

**Step 1: Get warning lines for both files**

```bash
npm run lint src/tools/ahk-analyze-diagnostics.ts src/tools/ahk-file-edit-small.ts 2>&1 | grep warning
```

**Step 2: Fix `ahk-analyze-diagnostics.ts`**

- Line 69: likely a Zod schema `z.object({ ... })` with `z.any()` → replace with
  `z.unknown()`
- Lines 157, 182: likely map/filter callbacks on result data

Pattern:

```typescript
// BEFORE
someResults.filter((r: any) => r.severity === 'error');

// AFTER
someResults.filter(r => r.severity === 'error');
// (if r is already typed by the array type)
```

**Step 3: Fix `ahk-file-edit-small.ts` (lines 478, 482, 483, 555, 573, 599, 633,
661, 683)**

These are likely in result processing. Read the specific lines:

```bash
sed -n '475,490p' src/tools/ahk-file-edit-small.ts
sed -n '550,560p' src/tools/ahk-file-edit-small.ts
```

Apply same pattern: typed arrays → remove `: any`; unknown JSON → use `unknown`.

**Step 4: Verify and commit**

```bash
npm run lint src/tools/ahk-analyze-diagnostics.ts src/tools/ahk-file-edit-small.ts
# Expected: 0 warnings

git add src/tools/ahk-analyze-diagnostics.ts src/tools/ahk-file-edit-small.ts
git commit -m "fix(types): remove any in analyze-diagnostics and file-edit-small"
```

---

## Task 8: Fix medium-count files (29 warnings → 0)

**Files (5 warnings each):**

- `src/tools/ahk-run-process.ts` (5)
- `src/tools/ahk-run-debug.ts` (5)
- `src/core/validation-middleware.ts` (5)
- `src/core/parameter-aliases.ts` (5)

**Files (4 warnings each):**

- `src/types/ahk-ast.ts` (4)
- `src/tools/ahk-smart-orchestrator.ts` (4)
- `src/tools/ahk-file-edit-diff.ts` (4)
- `src/tools/ahk-analyze-vscode.ts` (4)
- `src/core/opentelemetry.ts` (4)
- `src/compiler/ahk-linter.ts` (4) - but only 4 warnings shown earlier

**Step 1: Get all warning lines at once**

```bash
npm run lint src/tools/ahk-run-process.ts src/tools/ahk-run-debug.ts \
  src/core/validation-middleware.ts src/core/parameter-aliases.ts \
  src/types/ahk-ast.ts src/tools/ahk-smart-orchestrator.ts \
  src/tools/ahk-file-edit-diff.ts src/tools/ahk-analyze-vscode.ts \
  src/core/opentelemetry.ts src/compiler/ahk-linter.ts \
  2>&1 | grep warning
```

**Step 2: Apply fixes by pattern**

- `ahk-ast.ts` - likely type definitions with `any` fields → use `unknown` or
  specific types
- `opentelemetry.ts` - likely span attribute values → `AttributeValue` type or
  `unknown`
- For each file, read the flagged lines, apply the appropriate fix pattern

**Step 3: Verify batch**

```bash
npm run lint src/tools/ahk-run-process.ts src/tools/ahk-run-debug.ts \
  src/core/validation-middleware.ts src/core/parameter-aliases.ts \
  src/types/ahk-ast.ts src/tools/ahk-smart-orchestrator.ts \
  src/tools/ahk-file-edit-diff.ts src/tools/ahk-analyze-vscode.ts \
  src/core/opentelemetry.ts src/compiler/ahk-linter.ts
# Expected: 0 warnings for these files
```

**Step 4: Commit**

```bash
git add src/tools/ahk-run-process.ts src/tools/ahk-run-debug.ts \
  src/core/validation-middleware.ts src/core/parameter-aliases.ts \
  src/types/ahk-ast.ts src/tools/ahk-smart-orchestrator.ts \
  src/tools/ahk-file-edit-diff.ts src/tools/ahk-analyze-vscode.ts \
  src/core/opentelemetry.ts src/compiler/ahk-linter.ts
git commit -m "fix(types): eliminate any/non-null warnings in medium-warning-count files"
```

---

## Task 9: Fix `src/compiler/ahk-compiler.ts` + `src/compiler/ahk-linter.ts` (7 warnings → 0)

**Files:**

- Modify: `src/compiler/ahk-compiler.ts` (3)
- Modify: `src/compiler/ahk-linter.ts` (4)

**Step 1: Check warning lines**

```bash
npm run lint src/compiler/ahk-compiler.ts src/compiler/ahk-linter.ts 2>&1 | grep warning
```

**Step 2: Apply fixes**

Common compiler pattern:

```typescript
// BEFORE
const result: any = await runProcess(cmd);

// AFTER
const result: { stdout: string; stderr: string; exitCode: number } =
  await runProcess(cmd);
// OR use an existing ProcessResult type if one exists
```

**Step 3: Verify and commit**

```bash
npm run lint src/compiler/ahk-compiler.ts src/compiler/ahk-linter.ts
# Expected: 0 warnings

git add src/compiler/ahk-compiler.ts src/compiler/ahk-linter.ts
git commit -m "fix(types): remove any types from compiler files"
```

---

## Task 10: Fix tail files (27 warnings → 0)

**Files (2 warnings each):**

- `src/utils/path-auto-retry.ts` (1 non-null, 1 any)
- `src/tools/ahk-tools-search.ts` (2)
- `src/tools/ahk-file-list.ts` (2)
- `src/server.ts` (2)
- `src/core/path-converter-config.ts` (2)
- `src/core/parser.ts` (2)
- `src/core/metadata-extractor.ts` (2)

**Files (1 warning each):**

- `src/utils/debug-formatter.ts`
- `src/tools/ahk-system-settings.ts`
- `src/tools/ahk-system-alpha.ts`
- `src/tools/ahk-lint.ts`
- `src/tools/ahk-file-recent.ts`
- `src/tools/ahk-file-edit-advanced.ts`
- `src/tools/ahk-file-detect.ts`
- `src/tools/ahk-file-create.ts`
- `src/tools/ahk-docs-prompts.ts`
- `src/tools/ahk-cloudahk-validate.ts`
- `src/tools/ahk-cloud-validate.ts`
- `src/core/tracing.ts`
- `src/core/resource-subscriptions.ts`
- `src/core/observability-server.ts`

**Step 1: Get all warning lines**

```bash
npm run lint 2>&1 | grep -E "(path-auto-retry|ahk-tools-search|ahk-file-list|src/server|path-converter-config|src/core/parser|metadata-extractor|debug-formatter|ahk-system-settings|ahk-system-alpha|ahk-lint\.ts|ahk-file-recent|ahk-file-edit-advanced|ahk-file-detect|ahk-file-create|ahk-docs-prompts|ahk-cloudahk|ahk-cloud-validate|src/core/tracing|resource-subscriptions|observability-server)" | head -40
```

**Step 2: Apply fixes file by file**

For `src/utils/path-auto-retry.ts:518` (non-null assertion):

```typescript
// BEFORE
someValue!;

// AFTER
someValue ?? defaultValue;
```

For each 1-warning file: read the specific line, apply `any` → `unknown` or
remove needless `: any` annotation.

**Step 3: Verify all files clean**

```bash
npm run lint 2>&1 | tail -3
# Expected: ✖ 0 problems (0 errors, 0 warnings)
```

**Step 4: Final build verification**

```bash
npm run build
npm run test
```

**Step 5: Commit**

```bash
git add -p  # stage each file selectively
git commit -m "fix(types): eliminate remaining any/non-null warnings across tail files"
```

---

## Final Verification

```bash
npm run lint 2>&1 | tail -3
# Expected: 0 problems (0 errors, 0 warnings)

npm run build
# Expected: successful build

npm run test
# Expected: all tests pass

npx tsc --noEmit 2>&1 | wc -l
# Expected: 0 or minimal type errors
```

---

## Fix Pattern Reference

### Pattern A: Variadic logger/callback `any[]` → `unknown[]`

```typescript
// BEFORE: error(...args: any[]): void
// AFTER:  error(...args: unknown[]): void
```

### Pattern B: Map/filter on typed arrays — drop `: any` annotation

```typescript
// BEFORE: index.variables.map((v: any) => ({ name: v.Name }))
// AFTER:  index.variables.map(v => ({ name: v.Name }))
// Why: array is already AhkIndexVariable[], TypeScript infers v correctly
```

### Pattern C: Untyped JSON callbacks → use interface

```typescript
// BEFORE: fullDocs.data.Classes.map((c: any) => ({ name: c.Name }))
// AFTER:  fullDocs.data.Classes.map((c: AhkDocFullClassItem) => ({ name: c.Name }))
```

### Pattern D: Non-null assertion → optional chaining

```typescript
// BEFORE: regex.groups!.name!
// AFTER:  regex.groups?.name ?? ''
```

### Pattern E: Return type `any` → `unknown` or specific type

```typescript
// BEFORE: async execute(args: unknown): Promise<any>
// AFTER:  async execute(args: unknown): Promise<McpToolResponse>
```

### Pattern F: Field type `any` → `unknown`

```typescript
// BEFORE: data: any;
// AFTER:  data: unknown;
```
