# AutoHotkey v2 MCP Server

A TypeScript-based MCP server providing AutoHotkey v2 development tools, code analysis, and script execution with window detection.

## Coding Standards

### TypeScript Conventions
- Use strict mode with comprehensive type definitions
- Zod schemas for all tool parameter validation
- Async/await pattern for all I/O operations
- Error handling with informative messages

### AutoHotkey v2 Patterns
- All scripts must use `.ahk` extension (never `.ahv`)
- Validate AHK paths with `endsWith('.ahk')`
- Use AutoHotkey v2 syntax (expression-only)
- Support both GUI and console scripts

### MCP Tool Structure
```typescript
export const ToolArgsSchema = z.object({
  // Required parameters first
  // Optional parameters with defaults
});

export const toolDefinition = {
  name: 'tool_name',
  description: 'Brief description',
  inputSchema: { /* JSON schema */ }
};
```

## Development Commands

```bash
npm run build    # Compile TypeScript to dist/
npm run dev      # Development mode with auto-reload  
npm run clean    # Remove dist/ directory
npm run lint     # ESLint validation
```

## Architecture Patterns

### Process Management
- Track PIDs with `Map<number, ProcessInfo>`
- Graceful shutdown with cleanup handlers
- Timeout handling for long-running processes

### Window Detection
- Use PowerShell queries for window state
- Poll every 100ms with configurable timeout
- Return window title and detection timing

### File Operations
- Async file operations with proper error handling
- Path validation and normalization
- Cross-platform path resolution

## Common Patterns

### Error Response Format
```typescript
return {
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true
};
```

### Success Response Format  
```typescript
return {
  content: [
    { type: 'text', text: 'Action completed' },
    { type: 'text', text: JSON.stringify(data, null, 2) }
  ]
};
```

### AutoHotkey Path Auto-Detection
```typescript
// Check common paths first, fall back to PATH environment
const paths = [
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
  // ... more paths
];
```

## Project Context

- **Language Server**: Not full LSP, but provides completion/diagnostics
- **MCP Protocol**: Uses stdio transport with JSON-RPC 2.0
- **Data Loading**: Smart fallback from import to filesystem read
- **Window Detection**: Unique feature for GUI script verification
- **Documentation**: Complete AutoHotkey v2 reference integration

## File Validation Rules

- AutoHotkey files: Must end with `.ahk`
- Path resolution: Always use `path.resolve()` for security
- File existence: Check with `fs.access()` before operations
- Extension validation: Case-insensitive `.toLowerCase().endsWith('.ahk')`

---

*For project status and implementation details, see docs/PROJECT_STATUS.md*