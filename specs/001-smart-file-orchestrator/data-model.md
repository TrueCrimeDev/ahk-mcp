# Data Model: Smart File Operation Orchestrator

**Feature**: Smart File Operation Orchestrator
**Date**: 2025-10-02
**Status**: Complete

## Overview

This document defines the core data structures for the Smart File Orchestrator, which maintains session context and orchestrates file operations efficiently.

---

## Entity Definitions

### 1. OrchestrationContext

**Purpose**: Maintains session state for a single AHK file being worked on.

**TypeScript Definition**:
```typescript
interface OrchestrationContext {
  filePath: string;                        // Absolute path to the AHK file
  analysisResult: FileAnalysisResult | null; // Cached analysis data
  analysisTimestamp: number;               // When analysis was performed (Date.now())
  fileModifiedTime: number;                // File's mtime at analysis (ms since epoch)
  operationHistory: OperationRecord[];     // Recent operations on this file
}
```

**Field Descriptions**:
- `filePath`: Unique identifier for the context. Must be absolute path ending in `.ahk`
- `analysisResult`: Parsed output from AHK_Analyze tool. Null if not yet analyzed.
- `analysisTimestamp`: Used to determine cache age (for potential TTL in future)
- `fileModifiedTime`: Used for staleness detection via mtime comparison
- `operationHistory`: Rolling buffer of last N operations (for debugging/analytics)

**Validation Rules**:
- filePath MUST be absolute (starts with drive letter on Windows or `/` on Unix)
- filePath MUST end with `.ahk` (case-insensitive)
- analysisTimestamp MUST be ≤ Date.now()
- fileModifiedTime MUST be > 0
- operationHistory MUST NOT exceed 100 entries (circular buffer)

**State Transitions**:
```
[NEW] → analysisResult = null
  ↓
[ANALYZED] → analysisResult populated
  ↓
[STALE] → fileModifiedTime < current file mtime
  ↓
[REFRESHED] → new analysis performed
```

---

### 2. FileAnalysisResult

**Purpose**: Structured representation of an AHK file's code structure after parsing.

**TypeScript Definition**:
```typescript
interface FileAnalysisResult {
  filePath: string;              // File that was analyzed
  classes: ClassInfo[];          // All classes found in file
  functions: FunctionInfo[];     // Standalone functions (not in classes)
  hotkeys: HotkeyInfo[];         // Hotkey definitions
  globalLines: LineRange;        // Global scope line numbers
}

interface ClassInfo {
  name: string;                  // Class name (e.g., "_Dark")
  startLine: number;             // Line number where class definition starts
  endLine: number;               // Line number where class ends
  methods: MethodInfo[];         // Methods defined in this class
  properties: PropertyInfo[];    // Class properties
}

interface MethodInfo {
  name: string;                  // Method name (e.g., "ApplyDarkTheme")
  startLine: number;             // Method start line
  endLine: number;               // Method end line
  isStatic: boolean;             // Whether method is static
}

interface PropertyInfo {
  name: string;                  // Property name
  line: number;                  // Line where property is defined
  isStatic: boolean;             // Whether property is static
}

interface FunctionInfo {
  name: string;                  // Function name
  startLine: number;             // Function start line
  endLine: number;               // Function end line
}

interface HotkeyInfo {
  trigger: string;               // Hotkey trigger (e.g., "^!r")
  line: number;                  // Line where hotkey is defined
}

interface LineRange {
  start: number;                 // Starting line number (inclusive)
  end: number;                   // Ending line number (inclusive)
}
```

**Field Descriptions**:
- `classes`: Array of all class definitions found. Empty array if no classes.
- `functions`: Standalone functions (not class methods). Empty array if none.
- `hotkeys`: Hotkey definitions. Empty array if none.
- `globalLines`: Line range for global scope (outside classes/functions)

**Validation Rules**:
- All line numbers MUST be positive integers (≥ 1)
- startLine MUST be ≤ endLine for all ranges
- Class names MUST be unique within a file
- Method names MUST be unique within a class
- Function names MUST be unique in global scope

**Relationships**:
- One FileAnalysisResult per OrchestrationContext
- Multiple ClassInfo per FileAnalysisResult
- Multiple MethodInfo per ClassInfo
- Immutable once created (no in-place updates)

---

### 3. OrchestrationRequest

**Purpose**: Captures the user's high-level intent for a file operation.

**TypeScript Definition**:
```typescript
interface OrchestrationRequest {
  intent: string;                          // Natural language description
  filePath?: string;                       // Optional direct file path
  targetEntity?: string;                   // Optional class/method/function name
  operation: 'view' | 'edit' | 'analyze'; // Operation type
  forceRefresh?: boolean;                  // Force cache invalidation
}
```

**Field Descriptions**:
- `intent`: User's description of what they want to do (required)
  - Examples: "edit the _Dark class", "view checkbox methods", "analyze file structure"
- `filePath`: Direct path to file (optional, skips auto-detection if provided)
- `targetEntity`: Specific entity to focus on (optional, narrows scope)
  - Examples: "_Dark", "_Dark.ColorCheckbox", "GuiForm"
- `operation`: Type of operation to perform
  - `view`: Read-only, show code/structure
  - `edit`: Prepare for editing (set active file + show context)
  - `analyze`: Just analyze structure, don't read content
- `forceRefresh`: Bypass cache, re-analyze file (default: false)

**Validation Rules**:
- intent MUST NOT be empty string
- If filePath provided, MUST be valid AHK file path (.ahk extension)
- operation MUST be one of the three enum values
- targetEntity format: "ClassName" or "ClassName.MethodName"

**Processing Logic**:
```
1. If filePath provided → skip detection
   Else → use AHK_File_Detect with intent
2. Check cache for filePath
   → If hit AND not stale AND not forceRefresh → use cached
   → Else → run AHK_Analyze
3. If targetEntity provided → calculate line range for entity
   Else → return full file structure
4. If operation == 'view' → run AHK_File_View with calculated range
   If operation == 'edit' → set active file + provide guidance
   If operation == 'analyze' → return analysis only
```

---

### 4. OrchestrationResult

**Purpose**: Output of the orchestration process with context and guidance.

**TypeScript Definition**:
```typescript
interface OrchestrationResult {
  success: boolean;              // Whether orchestration succeeded
  toolCallsMade: number;         // Number of tool calls executed
  cacheHit: boolean;             // Whether cached data was used
  context: string;               // Relevant code/data formatted for display
  nextSteps: string[];           // Recommended actions for user
  errors?: string[];             // Error messages if any
  metadata: {
    filePath: string;            // File that was operated on
    targetEntity?: string;       // Entity that was focused on
    linesRead?: LineRange;       // Line range that was read
    analysisAge?: number;        // Age of cached analysis (ms)
  };
}
```

**Field Descriptions**:
- `success`: true if operation completed, false if errors occurred
- `toolCallsMade`: Performance metric (goal: ≤4 for new, ≤2 for cached)
- `cacheHit`: Whether we used cached analysis (important for metrics)
- `context`: Formatted text with code snippets, analysis results, etc.
- `nextSteps`: Array of suggested actions for the user to take next
  - Examples: ["Use AHK_File_Edit to modify line 42", "Run AHK_Run to test changes"]
- `errors`: Array of error messages (optional, present if success=false)
- `metadata`: Additional context about the operation

**Validation Rules**:
- If success=true, MUST have at least one nextStep
- If success=false, MUST have at least one error message
- toolCallsMade MUST be ≥ 0
- context SHOULD be non-empty for view/edit operations

**Example Outputs**:

**Success Case (Cache Hit)**:
```typescript
{
  success: true,
  toolCallsMade: 1,  // Only AHK_File_View (analysis was cached)
  cacheHit: true,
  context: `
📄 **__Lists.ahk** - Class _Dark (lines 880-1559)

\`\`\`autohotkey
class _Dark {
  static Dark := Map(
    "Background", 0x171717,
    "Controls", 0x1b1b1b,
    ...
  )
  ...
}
\`\`\`
  `,
  nextSteps: [
    "Use AHK_File_Edit to modify methods in the _Dark class",
    "Current file is set as active for editing"
  ],
  metadata: {
    filePath: "C:\\...\\__Lists.ahk",
    targetEntity: "_Dark",
    linesRead: { start: 880, end: 1559 },
    analysisAge: 5000  // 5 seconds old
  }
}
```

**Error Case**:
```typescript
{
  success: false,
  toolCallsMade: 2,
  cacheHit: false,
  context: "",
  nextSteps: [],
  errors: [
    "Class 'DarkMode' not found in file",
    "Available classes: _Dark, ResponsiveListManager"
  ],
  metadata: {
    filePath: "C:\\...\\__Lists.ahk"
  }
}
```

---

### 5. OperationRecord

**Purpose**: Tracks individual operations for debugging and analytics.

**TypeScript Definition**:
```typescript
interface OperationRecord {
  timestamp: number;             // When operation occurred (Date.now())
  operation: string;             // Operation type ("analyze", "read", "edit")
  toolsCalled: string[];         // Tools that were invoked
  duration: number;              // Operation duration in ms
  cacheHit: boolean;             // Whether cache was used
  success: boolean;              // Whether operation succeeded
}
```

**Usage**:
- Stored in OrchestrationContext.operationHistory
- Used for debugging (why did this fail?)
- Used for analytics (cache hit rate, performance trends)
- Rolling buffer (keep last 100 operations per file)

---

## Data Flow

```
User Request (via Claude)
  ↓
OrchestrationRequest (parsed from MCP tool call)
  ↓
Orchestration Engine
  ↓
Check SmartContextCache for OrchestrationContext
  ↓
  ├─ Cache Hit → Reuse FileAnalysisResult
  └─ Cache Miss → Call AHK_Analyze → Create FileAnalysisResult
  ↓
Calculate target line range from targetEntity (if provided)
  ↓
Call AHK_File_View with calculated range
  ↓
Format result as OrchestrationResult
  ↓
Update OrchestrationContext with OperationRecord
  ↓
Return to user via MCP protocol
```

---

## Zod Schemas (for validation)

```typescript
import { z } from 'zod';

export const LineRangeSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive()
}).refine(data => data.start <= data.end, {
  message: "start must be <= end"
});

export const ClassInfoSchema = z.object({
  name: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  methods: z.array(z.object({
    name: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    isStatic: z.boolean()
  })),
  properties: z.array(z.object({
    name: z.string().min(1),
    line: z.number().int().positive(),
    isStatic: z.boolean()
  }))
});

export const FileAnalysisResultSchema = z.object({
  filePath: z.string().regex(/\.ahk$/i),
  classes: z.array(ClassInfoSchema),
  functions: z.array(z.object({
    name: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive()
  })),
  hotkeys: z.array(z.object({
    trigger: z.string().min(1),
    line: z.number().int().positive()
  })),
  globalLines: LineRangeSchema
});

export const OrchestrationRequestSchema = z.object({
  intent: z.string().min(1),
  filePath: z.string().regex(/\.ahk$/i).optional(),
  targetEntity: z.string().optional(),
  operation: z.enum(['view', 'edit', 'analyze']),
  forceRefresh: z.boolean().optional().default(false)
});

export const OrchestrationResultSchema = z.object({
  success: z.boolean(),
  toolCallsMade: z.number().int().nonnegative(),
  cacheHit: z.boolean(),
  context: z.string(),
  nextSteps: z.array(z.string()),
  errors: z.array(z.string()).optional(),
  metadata: z.object({
    filePath: z.string(),
    targetEntity: z.string().optional(),
    linesRead: LineRangeSchema.optional(),
    analysisAge: z.number().int().nonnegative().optional()
  })
});
```

---

## Storage & Persistence

**Current Design**: In-memory only (no persistence)

**Rationale**:
- Session-scoped cache (cleared on server restart)
- Avoids staleness issues from file system cache
- Sufficient for typical Claude Code workflows

**Future Enhancement** (if needed):
- Add optional Redis cache for long-running servers
- Add LRU eviction for memory management
- Add file watcher for real-time invalidation

---

**Status**: Data Model Complete ✅
**Next**: API Contracts (Phase 1 continued)
