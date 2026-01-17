# MCP Error & Workflow Fixes Design

**Date:** 2026-01-12 **Status:** In Progress

## Issues Identified

### 1. Error Message Formatting in Claude Desktop

**Problem:** Error messages render on a single line instead of with proper line
breaks **Location:** `src/core/error-response-builder.ts:509-567`
(`formatErrorText()`) **Cause:** Single `\n` doesn't render as line breaks in
Claude Desktop markdown

**Fix:** Use double newlines `\n\n` between sections for proper markdown
paragraph spacing

### 2. Lint Regex Error: "Nothing to repeat"

**Problem:** `Invalid regular expression: /\b?\b/gi: Nothing to repeat`
**Location:** `src/core/linting/structure-analyzer.ts:481-485` **Cause:**
`decisionKeywords` array includes `'?'` which is a regex metacharacter

```typescript
// Current (broken)
const decisionKeywords = ['if', 'else', 'while', 'for', '&&', '||', '?'];
const regex = new RegExp(`\\b${keyword}\\b`, 'gi'); // Creates /\b?\b/ for '?'
```

**Fix:** Escape regex special characters or remove `?` and `||`/`&&` (they don't
have word boundaries anyway)

### 3. Workflow Not Detecting Script Crashes

**Problem:** Workflow reports "Script Ran: Yes" even when script crashes
**Location:** `src/tools/ahk-workflow-analyze-fix-run.ts:273-281` **Cause:**
Only checks `!runResult.isError`, but `AHK_Run` doesn't set `isError: true` for
non-zero exit codes

**Fix:**

- Option A: Have `AHK_Run` set `isError: true` when exit code != 0
- Option B: Have workflow parse the exit code from run result (fragile)

**Recommendation:** Option A - fix at source in `AHK_Run`

### 4. Workflow Not Showing Actual Issues

**Problem:** Summary only shows count ("14 issues") but not what they are
**Location:** `src/tools/ahk-workflow-analyze-fix-run.ts:318-361` **Cause:**
`summaryOnly: true` mode by design, but no option to show issues

**Fix:** When issues exist but no fixes applied, include issue summary in output

## Implementation Plan

### Phase 1: Quick Fixes (Low Risk)

1. **Fix lint regex** - Escape or filter special characters
2. **Fix error formatting** - Double newlines for markdown

### Phase 2: Workflow Improvements

3. **Fix AHK_Run** - Set `isError: true` on non-zero exit code
4. **Fix workflow crash detection** - Check exit code explicitly
5. **Add issue preview** - Show top 5 issues when `issuesFound > 0`

## Files to Modify

- `src/core/error-response-builder.ts` - Error formatting
- `src/core/linting/structure-analyzer.ts` - Regex fix
- `src/tools/ahk-run-script.ts` - Exit code → isError
- `src/tools/ahk-workflow-analyze-fix-run.ts` - Crash detection + issue preview
