# MCP Fix Validation Tests

After restarting Claude Desktop, run these tests in order:

---

## Test 1: Error Formatting (Line Breaks)

**Trigger a file-exists error:**

```
Create a new file at C:\Users\uphol\Documents\Design\Coding\AHK\!Running\test-mcp-fixes.ahk
```

**Expected:** Error message should render with proper line breaks:

- Header on its own line
- File path on its own line
- "How to fix" section separated
- Footer with metadata separated by `---`

**Pass if:** You see multiple distinct paragraphs, NOT one long line.

---

## Test 2: Lint Regex Fix

**Run lint:**

```
Lint C:\Users\uphol\Documents\Design\Coding\AHK\!Running\test-mcp-fixes.ahk
```

**Expected:** Should complete without "Invalid regular expression: /\b?\b/gi:
Nothing to repeat" error.

**Pass if:** You get a lint report (even with issues), NOT a regex error.

---

## Test 3: Script Crash Detection

**Run the workflow:**

```json
{
  "filePath": "C:\\Users\\uphol\\Documents\\Design\\Coding\\AHK\\!Running\\test-mcp-fixes.ahk",
  "autoFix": false,
  "runAfterFix": true
}
```

**Expected output should show:**

- `Script Ran: ❌ Failed` (NOT "Yes")
- `Error:` with exit code and/or error message
- Next Steps should say "Script execution failed"

**Pass if:** Script failure is clearly indicated with ❌ icon.

---

## Test 4: Issues Preview

**Run workflow or analyze:**

```json
{
  "filePath": "C:\\Users\\uphol\\Documents\\Design\\Coding\\AHK\\!Running\\test-mcp-fixes.ahk",
  "autoFix": false,
  "runAfterFix": false
}
```

**Expected:** Should show "Issues Preview (top X)" section with numbered list of
actual issues.

**Pass if:** You see actual issue descriptions, NOT just "14 issues found".

---

## Quick One-Liner Tests

Copy-paste these into Claude Desktop:

### Test lint regex:

> Lint the file at
> C:\Users\uphol\Documents\Design\Coding\AHK\!Running\test-mcp-fixes.ahk

### Test crash detection:

> Run AHK_Workflow_Analyze_Fix_Run on
> C:\Users\uphol\Documents\Design\Coding\AHK\!Running\test-mcp-fixes.ahk with
> runAfterFix true

### Test error formatting:

> Use AHK_File_Create to create
> C:\Users\uphol\Documents\Design\Coding\AHK\!Running\test-mcp-fixes.ahk (should
> error since it exists)

---

## Cleanup

After testing, delete the test file:

```
del C:\Users\uphol\Documents\Design\Coding\AHK\!Running\test-mcp-fixes.ahk
```
