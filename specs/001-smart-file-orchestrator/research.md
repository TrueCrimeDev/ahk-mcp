# Research: Smart File Operation Orchestrator

**Feature**: Smart File Operation Orchestrator
**Date**: 2025-10-02
**Status**: Complete

## Overview

Research findings for building an intelligent MCP tool that orchestrates file operations (detect → analyze → read → edit) to minimize redundant tool calls.

---

## 1. MCP Tool Orchestration Patterns

### Decision
Use the **Coordinator Pattern** where one high-level tool delegates to existing specialized tools.

### Rationale
- MCP tools should be stateless by design (per MCP protocol)
- A coordinator tool can maintain transient session context
- Existing tools remain unchanged (backward compatibility)
- Clear separation of concerns: orchestration logic vs. domain logic

### Implementation Approach
```typescript
class AhkSmartOrchestrator {
  private detectTool: AhkAutoFileTool;
  private analyzeTool: AhkAnalyzeTool;
  private viewTool: AhkFileViewTool;
  private contextCache: SmartContextCache;

  async execute(request: OrchestrationRequest) {
    // 1. Check cache
    // 2. Delegate to appropriate tools
    // 3. Update cache
    // 4. Return consolidated result
  }
}
```

### Alternatives Considered
1. **Client-Side Orchestration** (rejected)
   - Would require Claude to manually chain tools
   - Defeats the purpose of reducing tool calls
   - Increases token usage in prompts

2. **Server-Side State Machine** (rejected)
   - Violates MCP stateless principle for individual tools
   - Adds complexity to server lifecycle management
   - Difficult to reason about failure modes

### Best Practices from MCP Documentation
- Tools should have single, clear purpose
- Tools can call other tools internally (composition is allowed)
- State should be request-scoped or session-scoped (not persistent)

---

## 2. Session Context Management

### Decision
In-memory Map-based cache with file path as key and analysis results as value.

### Rationale
- **Fast**: O(1) lookups by file path
- **Simple**: No external dependencies
- **Session-scoped**: Automatically cleared on process restart
- **Sufficient**: For typical Claude Code sessions (2-10 files)

### Data Structure
```typescript
class SmartContextCache {
  private cache: Map<string, OrchestrationContext>;
  private hitCount: number = 0;
  private missCount: number = 0;

  get(filePath: string): OrchestrationContext | null {
    const ctx = this.cache.get(filePath);
    if (ctx) this.hitCount++;
    else this.missCount++;
    return ctx || null;
  }
}
```

### Alternatives Considered
1. **Persistent Cache (File System)** (rejected)
   - Staleness issues: Hard to detect when source file changes
   - File system overhead: Slower than in-memory
   - Cleanup complexity: Need TTL and eviction policies

2. **LRU Cache with Size Limits** (future consideration)
   - Current approach: Simple Map (no eviction)
   - Future: If sessions grow to 100+ files, add LRU eviction
   - Decision: YAGNI for now, add if needed

3. **Redis/External Cache** (rejected)
   - Massive overkill for transient session data
   - Adds deployment complexity
   - Network latency

---

## 3. Cache Invalidation Strategy

### Decision
Timestamp-based staleness detection by comparing file modification time (mtime).

### Rationale
- **Accurate**: Detects external file modifications
- **Efficient**: Single stat() call to check mtime
- **Reliable**: Works cross-platform (Node.js fs.stat)

### Implementation
```typescript
async isStale(filePath: string): Promise<boolean> {
  const ctx = this.cache.get(filePath);
  if (!ctx) return false; // Not cached = not stale

  const stats = await fs.stat(filePath);
  return stats.mtimeMs > ctx.fileModifiedTime;
}
```

### Alternatives Considered
1. **Content Hashing** (rejected)
   - Pro: Detects actual content changes (not just metadata)
   - Con: Expensive for large files (need to read entire file)
   - Con: Not worth the cost for our use case

2. **No Invalidation** (rejected)
   - Pro: Simplest possible approach
   - Con: Users would see stale data after external edits
   - Con: Confusing UX ("Why doesn't it see my changes?")

3. **File Watchers (fs.watch)** (rejected for now)
   - Pro: Real-time invalidation on file changes
   - Con: Adds complexity (event handling, cleanup)
   - Con: Cross-platform issues (polling vs. inotify)
   - Decision: Could add later if needed

### Edge Case Handling
- File deleted after caching → Cache returns stale context, next tool call fails with clear error
- File replaced (same mtime) → Rare edge case, acceptable risk
- File on network share → mtime still works, but may be slightly delayed

---

## 4. Existing Tool Integration

### Decision
Import tool classes directly and call their `execute()` methods programmatically.

### Rationale
- **DRY**: Single source of truth for tool logic
- **Type-Safe**: TypeScript ensures correct args
- **Maintainable**: Changes to tools automatically propagate
- **Testable**: Can mock tool instances for unit tests

### Integration Pattern
```typescript
// In ahk-smart-orchestrator.ts
import { AhkAnalyzeTool } from './ahk-analyze-code.js';
import { AhkFileViewTool } from './ahk-file-view.js';

class AhkSmartOrchestrator {
  private analyzeTool = new AhkAnalyzeTool();
  private viewTool = new AhkFileViewTool();

  async orchestrate(request: OrchestrationRequest) {
    // Call tool directly
    const analysisResult = await this.analyzeTool.execute({
      file: request.filePath
    });

    // Parse result
    const analysis = this.parseAnalysis(analysisResult);

    // Determine what to read based on analysis
    const lineRange = this.calculateLineRange(analysis, request.targetEntity);

    // Read specific section
    const viewResult = await this.viewTool.execute({
      file: request.filePath,
      lineStart: lineRange.start,
      lineEnd: lineRange.end,
      maxLines: lineRange.end - lineRange.start + 1
    });

    return this.formatResult(viewResult);
  }
}
```

### Alternatives Considered
1. **Duplicate Tool Logic** (rejected)
   - Violates DRY principle
   - Maintenance nightmare (bugs need fixing in multiple places)
   - Out of sync risks

2. **Sub-Process Tool Calls** (rejected)
   - Would need to spawn separate processes
   - IPC overhead (JSON serialization, process startup)
   - Complexity in error handling

3. **MCP Protocol Internal Calls** (rejected)
   - Would go through MCP JSON-RPC layer unnecessarily
   - Adds serialization/deserialization overhead
   - Harder to debug

---

## 5. Error Recovery Patterns

### Decision
Graceful degradation with explicit fallback options provided to user.

### Rationale
- **User Control**: Claude can override auto-detection if it fails
- **Transparent**: Error messages explain what failed and why
- **Recoverable**: Partial failures don't block entire workflow

### Error Handling Strategy
```typescript
async orchestrate(request: OrchestrationRequest) {
  try {
    // Step 1: Detect/validate file
    const filePath = request.filePath || await this.detectFile(request.intent);

    // Step 2: Analyze
    let analysis = this.contextCache.get(filePath)?.analysisResult;
    if (!analysis || await this.contextCache.isStale(filePath)) {
      const result = await this.analyzeTool.execute({ file: filePath });
      analysis = this.parseAnalysis(result);
      this.contextCache.set(filePath, { analysis, timestamp: Date.now() });
    }

    // Step 3: Calculate what to read
    const target = this.findTarget(analysis, request.targetEntity);
    if (!target) {
      return this.suggestAlternatives(analysis);
    }

    // Step 4: Read section
    const content = await this.viewTool.execute({
      file: filePath,
      lineStart: target.startLine,
      lineEnd: target.endLine
    });

    return this.formatSuccess(content);

  } catch (error) {
    return this.formatError(error, {
      fallbacks: [
        "Provide direct file path with filePath parameter",
        "Specify line range manually with AHK_File_View",
        "Use AHK_Analyze first to see file structure"
      ]
    });
  }
}
```

### Error Scenarios
1. **File Detection Fails**
   - Error: "Could not auto-detect file. Provide direct path."
   - Fallback: User provides `filePath` parameter

2. **Analysis Fails (Syntax Errors)**
   - Error: "File has syntax errors. Analysis incomplete."
   - Fallback: Show what was analyzed + offer manual line ranges

3. **Target Entity Not Found**
   - Error: "Class '_Dark' not found. Available: [list]"
   - Fallback: Show all classes/functions found

4. **File Too Large**
   - Error: "File exceeds 10,000 lines. Specify target entity."
   - Fallback: Require `targetEntity` to narrow scope

### Alternatives Considered
1. **Fail-Fast** (rejected)
   - Aborts on first error
   - Poor UX: User has to start over
   - Wastes previous successful steps

2. **Silent Fallback** (rejected)
   - Tries alternative approaches without telling user
   - Confusing: User doesn't know what happened
   - Debugging nightmare

---

## 6. Performance Considerations

### Expected Performance
- **Analysis**: ~500ms for typical AHK file (1000-2000 lines)
- **Cache lookup**: <1ms (in-memory Map)
- **File read**: ~100ms for 500-line section
- **Total (cache miss)**: ~600ms
- **Total (cache hit)**: ~100ms

### Optimization Strategies
1. **Lazy Analysis**: Only analyze when needed
2. **Incremental Reads**: Read only requested sections
3. **Cache Reuse**: Maximize cache hit rate
4. **Parallel Ops**: Where independent (future: analyze multiple files concurrently)

### Scalability Limits
- **Files per session**: 10 (current cache size)
- **File size**: 10,000 lines (practical limit for parsing)
- **Requests per second**: Not a concern (interactive use case)

---

## 7. Integration with Existing Codebase

### Files to Modify
1. **src/server.ts** - Register new tool
2. **src/tools/** - Add new orchestrator tool

### Files to Create
1. **src/core/smart-context.ts** - Session cache
2. **src/core/orchestration-engine.ts** - Core logic
3. **src/tools/ahk-smart-orchestrator.ts** - MCP tool wrapper
4. **tests/unit/smart-context.test.ts** - Cache tests
5. **tests/unit/orchestration-engine.test.ts** - Engine tests
6. **tests/integration/orchestrator-workflow.test.ts** - E2E tests

### Backward Compatibility
- ✅ No changes to existing tool APIs
- ✅ New tool is opt-in (existing workflows unaffected)
- ✅ Can be added without breaking changes

---

## Summary of Decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| **Architecture** | Coordinator pattern | Maintains separation of concerns, reuses existing tools |
| **Cache** | In-memory Map | Fast, simple, sufficient for session scope |
| **Invalidation** | mtime-based | Accurate, efficient, cross-platform |
| **Integration** | Direct method calls | DRY, type-safe, maintainable |
| **Errors** | Graceful degradation | User control, transparent, recoverable |

---

## Open Questions & Future Enhancements

### Resolved
- ✅ How to handle file detection? → Use existing AHK_File_Detect tool
- ✅ How to parse analysis results? → Parse text output from AHK_Analyze
- ✅ What if file is too large? → Require targetEntity to narrow scope

### Future Considerations
1. **LRU Cache Eviction** - If sessions grow beyond 10 files
2. **Parallel Analysis** - Analyze multiple files concurrently
3. **Incremental Analysis** - Only re-analyze changed sections
4. **File Watchers** - Real-time cache invalidation

---

**Status**: Research complete ✅
**Next Phase**: Design & Contracts (Phase 1)
