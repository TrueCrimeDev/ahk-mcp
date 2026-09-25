# Feature Specification: Smart File Operation Orchestrator

**Feature Branch**: `smart-file-orchestrator`
**Created**: 2025-10-02
**Status**: Draft
**Input**: User description: "Create a toolchain that automatically orchestrates file operations: detect file → analyze structure → read targeted sections → edit efficiently, reducing redundant tool calls from 7-10 down to 3-4"

## Execution Flow (main)
```
1. Parse user description from Input
   → Identify need: Reduce tool calls, improve efficiency
2. Extract key concepts from description
   → Actors: MCP client (Claude), AHK files
   → Actions: detect, analyze, read, edit
   → Data: file structure, class/method locations
   → Constraints: minimize tool calls, maintain context
3. For each unclear aspect:
   → [RESOLVED] Workflow is clear
4. Fill User Scenarios & Testing section
   → User flow: Client requests edit → Orchestrator executes chain
5. Generate Functional Requirements
   → Each requirement is testable
6. Identify Key Entities
   → Orchestration context, file analysis cache
7. Run Review Checklist
   → No implementation details in spec
8. Return: SUCCESS (spec ready for planning)
```

---

## ⚡ Quick Guidelines
- ✅ Focus on WHAT users (Claude/MCP clients) need and WHY
- ❌ Avoid HOW to implement (specific TypeScript patterns)
- 👥 Written for MCP developers and architects

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story
When a Claude Code user asks to "fix the checkbox issues in the _Dark class", the MCP should:
1. Automatically detect/verify the file location
2. Analyze the file structure to find the _Dark class and its methods
3. Read only the relevant sections (the _Dark class methods)
4. Present targeted information for editing
5. Execute edits with full context awareness

**Current State**: 7-10 separate tool calls with manual coordination
**Desired State**: 3-4 automated tool calls with intelligent orchestration

### Acceptance Scenarios

1. **Given** a user request to edit a specific class method in an AHK file
   **When** the orchestrator processes the request
   **Then** it must:
   - Detect or validate the file location (1 call)
   - Analyze the file structure to locate the class (1 call)
   - Read the specific class/method range in a single operation (1 call)
   - Provide editing capability with full context (1 call)
   - Total: ≤4 tool calls

2. **Given** a file that was recently analyzed
   **When** a second edit request is made to the same file
   **Then** it must:
   - Reuse cached analysis data
   - Skip redundant detection/analysis calls
   - Total: ≤2 tool calls (read + edit)

3. **Given** a user provides a direct file path
   **When** the orchestrator processes the request
   **Then** it must:
   - Skip the detect phase
   - Proceed directly to analyze → read → edit
   - Total: ≤3 tool calls

4. **Given** an analysis reveals multiple classes
   **When** the user specifies a particular class to edit
   **Then** the orchestrator must:
   - Calculate precise line ranges for that class
   - Read only those lines (not the entire file)
   - Avoid multiple small chunked reads

### Edge Cases
- What happens when file analysis fails (syntax errors)?
  - Must report error clearly and allow manual override with direct line ranges
- What happens when file is very large (>5000 lines)?
  - Must use targeted reads based on analysis, never full file reads
- What happens when the requested class/method doesn't exist?
  - Must report available classes/methods from analysis
- What happens when user wants to edit multiple classes?
  - Must orchestrate multiple targeted read operations efficiently
- What happens when file changes between analysis and edit?
  - Must detect staleness and offer re-analysis

---

## Requirements *(mandatory)*

### Functional Requirements

**File Discovery & Validation**
- **FR-001**: System MUST accept either a direct file path OR trigger auto-detection
- **FR-002**: System MUST validate file exists and has `.ahk` extension before proceeding
- **FR-003**: System MUST skip detection step if valid absolute path is provided

**Intelligent Analysis**
- **FR-004**: System MUST analyze file structure to identify all classes, methods, functions, and their line ranges
- **FR-005**: System MUST cache analysis results for the duration of the session
- **FR-006**: System MUST detect when cached analysis is stale (file modified)
- **FR-007**: System MUST extract class names, method names, function names, and line number boundaries

**Targeted Reading**
- **FR-008**: System MUST calculate precise line ranges based on analysis results
- **FR-009**: System MUST read requested sections in single operations (no chunking)
- **FR-010**: System MUST support reading multiple non-contiguous sections if needed
- **FR-011**: System MUST set `maxLines` parameter appropriately based on calculated range size

**Orchestration Logic**
- **FR-012**: System MUST execute operations in optimal order: detect → analyze → read → edit
- **FR-013**: System MUST skip redundant operations based on context
- **FR-014**: System MUST maintain session context across multiple related operations
- **FR-015**: System MUST report progress and rationale for each step taken

**Error Handling**
- **FR-016**: System MUST provide clear error messages when any step fails
- **FR-017**: System MUST offer fallback options when auto-detection fails
- **FR-018**: System MUST allow manual override of calculated line ranges
- **FR-019**: System MUST handle partial failures gracefully (e.g., continue if analysis is incomplete)

**Performance Targets**
- **FR-020**: System MUST reduce average tool calls from 7-10 to ≤4 for typical edit operations
- **FR-021**: System MUST reduce to ≤2 calls for subsequent edits to cached files
- **FR-022**: System MUST complete analysis + targeted read in <2 seconds for files <5000 lines

### Key Entities

- **Orchestration Context**
  - Current file path being worked on
  - Cached analysis results (classes, methods, line ranges)
  - Operation history (what steps already completed)
  - Session timestamp for staleness detection

- **File Analysis Result**
  - File path
  - List of classes (name, start line, end line)
  - List of methods per class (name, start line, end line)
  - List of standalone functions (name, start line, end line)
  - Global scope line ranges
  - Analysis timestamp

- **Orchestration Request**
  - User intent (what to edit/view)
  - Target entity (class name, method name, or line range)
  - File identifier (path or detection hints)
  - Operation type (view, edit, analyze)

---

## Review & Acceptance Checklist

### Content Quality
- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs (reducing tool calls, improving efficiency)
- [x] Written for MCP developers and architects
- [x] All mandatory sections completed

### Requirement Completeness
- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable (≤4 tool calls)
- [x] Scope is clearly bounded (file operations orchestration only)
- [x] Dependencies identified (existing AHK tools: detect, analyze, view, edit)

---

## Execution Status

- [x] User description parsed
- [x] Key concepts extracted
- [x] Ambiguities marked (none found)
- [x] User scenarios defined
- [x] Requirements generated
- [x] Entities identified
- [x] Review checklist passed

---

## Dependencies & Assumptions

### Dependencies
- Existing tool: `AHK_File_Detect` - for auto-detection
- Existing tool: `AHK_Analyze` - for structure analysis
- Existing tool: `AHK_File_View` - for reading file sections
- Existing tool: `AHK_File_Edit_Advanced` - for editing

### Assumptions
- Claude Code clients can maintain session context across tool calls
- File analysis via `AHK_Analyze` is sufficiently fast (<1 second for typical files)
- Analysis results format is parseable and includes line number ranges
- MCP protocol supports returning structured orchestration guidance

---

## Success Metrics

### Quantitative
- Tool call reduction: From 7-10 calls → ≤4 calls (60% reduction)
- Cached operation improvement: ≤2 calls for repeat edits (80% reduction)
- Response time: <2 seconds for analyze + read operations

### Qualitative
- User (Claude) no longer needs to manually coordinate tool calls
- Editing workflow feels seamless and automatic
- Clear progress reporting maintains transparency
- Error messages are actionable and helpful
