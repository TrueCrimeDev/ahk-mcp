# Claude Code Hooks Integration

> **Active hook:** `.claude/hooks/validate-ahk.ps1`, which checks edited `.ahk`
> files with AutoHotkey v2 `/Validate`. `scripts/setup-claude-code.ps1` wires it
> from `.claude/settings.example.json`; see
> [CLAUDE_CODE_WINDOWS.md](CLAUDE_CODE_WINDOWS.md). The Python auto-run hook
> described below is kept for reference and is not wired. Its matcher uses the
> old server name `ahk_mcp`; with the server registered as `ahk` it would be
> `mcp__ahk__AHK_File_Edit.*`.

## Overview

The ahk-mcp server integrates with Claude Code's hook system to provide
automatic script execution after file edits.

## Architecture

```
Claude Code
    ↓
[User Request] → "Edit script.ahk"
    ↓
[MCP Tool] → AHK_File_Edit
    ↓
[Edit Complete] → Success response
    ↓
[PostToolUse Hook] → run-after-edit.py
    ↓
[AutoHotkey] → Script execution
    ↓
[Result] → Back to Claude Code
```

## Hook Configuration

Located in `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__ahk_mcp__AHK_File_Edit.*",
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/run-after-edit.py\"",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

## Hook Implementation

### File: `.claude/hooks/run-after-edit.py`

**Purpose**: Automatically execute AHK scripts after successful edits

**Features**:

- Validates edit success from tool response
- Extracts file paths using regex patterns
- Respects `runAfter` parameter
- Honors environment variables
- Auto-detects AutoHotkey v2 installation
- Timeout protection
- Verbose logging mode

### Environment Variables

| Variable             | Type    | Default | Description                        |
| -------------------- | ------- | ------- | ---------------------------------- |
| `AHK_AUTO_RUN`       | boolean | `true`  | Master enable/disable switch       |
| `AHK_RUN_TIMEOUT`    | integer | `30`    | Script execution timeout (seconds) |
| `AHK_HOOK_VERBOSE`   | boolean | `false` | Enable detailed logging            |
| `CLAUDE_PROJECT_DIR` | string  | (auto)  | Project root (set by Claude Code)  |

## Integration with MCP Tools

### Supported Tools

Hook responds to these MCP tools:

- `AHK_File_Edit` - Primary edit tool
- `AHK_File_Edit_Advanced` - Orchestrator tool
- `AHK_File_Edit_Small` - Small file editor
- `AHK_File_Edit_Diff` - Diff-based editor

### Tool Parameter: runAfter

Tools support `runAfter` boolean parameter:

- `runAfter: true` → MCP tool runs script directly (hook skips)
- `runAfter: false` → Hook skips execution
- `runAfter: undefined` → Hook provides auto-run

### MCP Setting: autoRunAfterEdit

Server setting in `tool-settings.json`:

```json
{
  "autoRunAfterEdit": false
}
```

When `true`, MCP tools auto-run by default. Hook provides fallback when `false`.

## Control Flow

### Decision Tree

```
PostToolUse Event
    ↓
Is edit tool? → No → Skip
    ↓ Yes
Edit successful? → No → Skip
    ↓ Yes
File is .ahk? → No → Skip
    ↓ Yes
runAfter=false? → Yes → Skip
    ↓ No
AHK_AUTO_RUN=false? → Yes → Skip
    ↓ No
AutoHotkey found? → No → Error
    ↓ Yes
Execute Script
```

### Response Formats

**Success (Exit 0)**:

```
✅ Auto-run: Script executed successfully in 0.32s
```

**Skip (Exit 0)**:

```
(Silent - no output)
```

**Error (Exit 1)**:

```
⚠️ Auto-run failed: <reason>
```

## Error Handling

### AutoHotkey Not Found

```python
return False, "AutoHotkey v2 not found. Please install from https://autohotkey.com"
```

### Script Execution Failed

```python
return False, f"Script failed with exit code {result.returncode}: {stderr}"
```

### Timeout

```python
return False, f"Script execution timed out after {config.timeout}s"
```

## Performance Considerations

### Hook Overhead

- Invocation: ~10-50ms
- Path detection: ~50-100ms
- Decision logic: ~5-10ms
- Total: ~65-160ms

### Script Execution

- Simple scripts: 0.1-1s
- GUI scripts: 0.5-5s
- Complex scripts: Varies

### Optimization

- Early exit on non-matching events
- Cached AutoHotkey path detection
- Lazy regex compilation

## Security

### Path Validation

- Scripts must exist on filesystem
- Must have `.ahk` extension
- Paths extracted from trusted tool responses

### Command Injection Protection

- No user input in shell commands
- All arguments properly escaped
- Subprocess with explicit argument lists

### Resource Limits

- Configurable timeout prevents runaway scripts
- Process cleanup on timeout
- No persistent state between invocations

## Debugging

### Enable Verbose Mode

```bash
export AHK_HOOK_VERBOSE=true
claude --debug
```

### Verbose Output Example

```
[VERBOSE] Hook event: PostToolUse
[VERBOSE] Tool name: mcp__ahk_mcp__AHK_File_Edit
[VERBOSE] Should run: true, Reason: Edit completed successfully
[VERBOSE] Script path: C:\Scripts\test.ahk
[VERBOSE] AutoHotkey path: C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe
[VERBOSE] Executing: C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe /ErrorStdOut=utf-8 C:\Scripts\test.ahk
✅ Auto-run: Script executed successfully in 0.45s
```

### Testing

```bash
# Test hook logic
bash .claude/hooks/test-hook.sh

# Test with sample input
python3 .claude/hooks/run-after-edit.py < test-input.json

# Validate syntax
python3 -m py_compile .claude/hooks/run-after-edit.py
```

## Customization

### Custom AutoHotkey Paths

Edit `run-after-edit.py`:

```python
self.ahk_paths = [
    r'C:\Custom\Path\AutoHotkey.exe',
    r'C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe',
    # ...
]
```

### Custom Execution Logic

Modify `should_run_script()`:

```python
def should_run_script(...) -> tuple[bool, str]:
    # Add custom conditions
    if custom_condition_not_met:
        return False, "Custom reason"
    # ... default logic
```

### Custom Output Format

Modify `run_autohotkey_script()`:

```python
if result.returncode == 0:
    return True, f"Custom success message: {elapsed:.2f}s"
```

## Future Enhancements

### Potential Features

- [ ] Pre-execution validation hooks
- [ ] Post-execution result parsing
- [ ] Script output capture and display
- [ ] GUI window detection integration
- [ ] Multi-script batch execution
- [ ] Conditional execution based on file content
- [ ] Integration with AHK_Diagnostics for pre-run validation

### Considered but Deferred

- Input parameter passing (complex, edge cases)
- Persistent script instances (resource management issues)
- Automatic error correction (too opinionated)

## References

- Claude Code Hooks: https://docs.claude.com/en/docs/claude-code/hooks-reference
- AutoHotkey v2: https://www.autohotkey.com/docs/v2/
- MCP Protocol: https://modelcontextprotocol.io/

## Support

See `.claude/hooks/README.md` for user documentation and troubleshooting.
