# Claude Code Hooks for AHK-MCP

> **Active hook:** `validate-ahk.ps1` (PostToolUse on `Edit`, `Write`,
> `MultiEdit`, `AHK_File_Edit`, `AHK_File_Create`). It runs AutoHotkey v2
> `/Validate` on edited `.ahk` files and exits 2 on load-time errors so Claude
> fixes them. `scripts/setup-claude-code.ps1` wires it into
> `.claude/settings.json` from `.claude/settings.example.json`; see
> [docs/CLAUDE_CODE_WINDOWS.md](../../docs/CLAUDE_CODE_WINDOWS.md).
>
> `run-after-edit.py` below is kept for reference and is **not wired**: wiring
> both would validate and then run every edited script. Its matcher still uses
> the old server name (`mcp__ahk_mcp__`); the server is now registered as `ahk`.

This directory contains Claude Code hooks that enhance the AutoHotkey MCP
server's behavior when used with Claude Code CLI.

## Overview

Hooks are scripts that run automatically in response to events in Claude Code,
such as tool completions, prompt submissions, or session starts. This project
uses hooks to provide seamless integration between file editing and script
execution.

## Available Hooks

### `run-after-edit.py` - Auto-Run Scripts After Edit

**Event:** `PostToolUse` **Matcher:** `mcp__ahk_mcp__AHK_File_Edit.*`

Automatically executes AutoHotkey v2 scripts after successful file editing
operations.

#### Features

- ✅ **Smart Detection**: Only runs after successful .ahk file edits
- 🔍 **Multi-tool Support**: Works with all AHK file editing tools
  - `AHK_File_Edit`
  - `AHK_File_Edit_Advanced`
  - `AHK_File_Edit_Small`
  - `AHK_File_Edit_Diff`
- ⚙️ **Configurable**: Respects both MCP settings and environment variables
- ⏱️ **Timeout Protection**: Prevents hanging on long-running scripts
- 📊 **Detailed Logging**: Verbose mode for debugging

#### How It Works

1. **Hook Trigger**: Claude Code calls the hook after any `AHK_File_Edit*` tool
   completes
2. **Validation**: Script checks if the edit was successful and involves an .ahk
   file
3. **Path Extraction**: Parses the file path from the tool response
4. **AutoHotkey Execution**: Runs the script using AutoHotkey v2
5. **Result Reporting**: Outputs success/failure to Claude Code transcript

#### Configuration

##### Basic Configuration

The hook is configured in `.claude/settings.json`:

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

##### Environment Variables

Control hook behavior using environment variables:

| Variable           | Default | Description                           |
| ------------------ | ------- | ------------------------------------- |
| `AHK_AUTO_RUN`     | `true`  | Enable/disable auto-run functionality |
| `AHK_RUN_TIMEOUT`  | `30`    | Script execution timeout in seconds   |
| `AHK_HOOK_VERBOSE` | `false` | Enable verbose logging for debugging  |

**Example: Disable auto-run temporarily**

```bash
export AHK_AUTO_RUN=false
claude
```

**Example: Increase timeout for long-running scripts**

```bash
export AHK_RUN_TIMEOUT=60
claude
```

**Example: Enable verbose logging**

```bash
export AHK_HOOK_VERBOSE=true
claude --debug
```

#### Interaction with MCP Settings

This hook complements the MCP server's built-in `autoRunAfterEdit` setting:

**MCP Setting** (`tool-settings.json`):

```json
{
  "autoRunAfterEdit": false
}
```

**Hook Behavior:**

- If `runAfter: false` is explicitly set in tool call → Hook **skips** execution
- If `runAfter: true` is set in tool call → MCP tool **already runs** the script
- If `runAfter` is omitted → Hook **provides** auto-run functionality

This design gives you multiple levels of control:

1. **Per-call control**: Set `runAfter` parameter on individual tool calls
2. **Global MCP setting**: Configure `autoRunAfterEdit` in MCP settings
3. **Per-project hook**: Enable/disable via `.claude/settings.json`
4. **Session override**: Use `AHK_AUTO_RUN` environment variable

#### Usage Examples

##### Example 1: Edit and Auto-Run (Default Behavior)

When the hook is configured, scripts automatically run after successful edits:

```
User: Fix the typo in my script - change "MgsBox" to "MsgBox"

Claude: <uses AHK_File_Edit tool>
  ✅ **Edit Successful**
  📄 **File:** C:\Scripts\hello.ahk
  ⚙️ **Operation:** Replaced first occurrence of "MgsBox" with "MsgBox"

  [Hook automatically runs script]
  ✅ Auto-run: Script executed successfully in 0.32s
```

##### Example 2: Skip Auto-Run for Specific Edit

Use the `runAfter: false` parameter to prevent auto-run:

```
User: Add a comment to line 1 but don't run the script

Claude: <uses AHK_File_Edit with runAfter: false>
  ✅ **Edit Successful**
  📄 **File:** C:\Scripts\hello.ahk

  [Hook skips execution due to runAfter: false]
```

##### Example 3: Disable Auto-Run for Session

Temporarily disable for the entire session:

```bash
export AHK_AUTO_RUN=false
claude
```

##### Example 4: Debugging Hook Issues

Enable verbose logging to troubleshoot:

```bash
export AHK_HOOK_VERBOSE=true
claude --debug
```

You'll see detailed output in transcript mode (Ctrl+R):

```
[VERBOSE] Hook event: PostToolUse
[VERBOSE] Tool name: mcp__ahk_mcp__AHK_File_Edit
[VERBOSE] Should run: true, Reason: Edit completed successfully
[VERBOSE] Script path: C:\Scripts\test.ahk
[VERBOSE] AutoHotkey path: C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe
[VERBOSE] Executing: C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe /ErrorStdOut=utf-8 C:\Scripts\test.ahk
✅ Auto-run: Script executed successfully in 0.45s
```

#### Troubleshooting

##### Hook Not Running

**Problem:** The hook doesn't execute after file edits.

**Solutions:**

1. Check hook is registered: Run `/hooks` in Claude Code to verify
2. Verify Python 3 is installed: `python3 --version`
3. Ensure script is executable: `chmod +x .claude/hooks/run-after-edit.py`
4. Check hook configuration in `.claude/settings.json`
5. Try manually running the hook script to test it

##### AutoHotkey Not Found

**Problem:** `Error: AutoHotkey v2 not found`

**Solutions:**

1. Install AutoHotkey v2 from https://autohotkey.com
2. Add AutoHotkey to your PATH
3. Edit the script to add custom paths to `ahk_paths` list
4. Set `AHK_PATH` environment variable (if you add support for it)

##### Script Times Out

**Problem:** `Script execution timed out after 30s`

**Solutions:**

1. Increase timeout: `export AHK_RUN_TIMEOUT=60`
2. Check if script has infinite loops or blocking operations
3. Use `detectWindow` in MCP tool for GUI scripts instead
4. Consider running script in background instead of blocking

##### Hook Runs But Script Fails

**Problem:** `⚠️ Auto-run failed: Script failed with exit code 1`

**Solutions:**

1. Enable verbose mode: `export AHK_HOOK_VERBOSE=true`
2. Check the script has no syntax errors using `AHK_Diagnostics` tool
3. Verify the script path is correct
4. Check script permissions
5. Look for `/ErrorStdOut` messages in the error output

##### Permission Denied

**Problem:** `Permission denied` when running hook script

**Solutions:**

1. Make script executable: `chmod +x .claude/hooks/run-after-edit.py`
2. Check Python interpreter is accessible: `which python3`
3. Verify file permissions in `.claude/hooks/` directory

#### Advanced Configuration

##### Custom AutoHotkey Paths

Edit `run-after-edit.py` to add custom AutoHotkey installation paths:

```python
self.ahk_paths = [
    r'C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe',
    r'C:\Custom\Path\To\AutoHotkey.exe',  # Add your custom path
    # ... other paths
]
```

##### Per-Project Hook Override

Create project-specific settings in `.claude/settings.local.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__ahk_mcp__AHK_File_Edit.*",
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/custom-hook.py\"",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

##### Conditional Execution

Modify the `should_run_script()` function to add custom logic:

```python
def should_run_script(...) -> tuple[bool, str]:
    # Your custom logic here
    if some_custom_condition:
        return False, "Custom condition not met"

    # ... rest of default logic
```

## Hook Development Guide

### Testing Hooks Locally

Test the hook script manually:

```bash
# Create test input
cat > /tmp/test-hook-input.json << 'EOF'
{
  "hook_event_name": "PostToolUse",
  "tool_name": "mcp__ahk_mcp__AHK_File_Edit",
  "tool_input": {
    "action": "replace",
    "filePath": "C:\\Scripts\\test.ahk"
  },
  "tool_response": {
    "content": [
      {
        "type": "text",
        "text": "✅ **Edit Successful**\n\n📄 **File:** C:\\Scripts\\test.ahk"
      }
    ]
  }
}
EOF

# Run hook with test input
python3 .claude/hooks/run-after-edit.py < /tmp/test-hook-input.json
```

### Adding New Hooks

1. Create new Python script in `.claude/hooks/`
2. Add hook configuration to `.claude/settings.json`
3. Test with sample input
4. Document in this README

### Hook Script Template

```python
#!/usr/bin/env python3
import json
import sys

def main():
    try:
        # Read hook input
        hook_input = json.load(sys.stdin)

        # Your logic here

        # Output results
        print("Hook executed successfully", file=sys.stdout)
        return 0

    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
```

## Additional Resources

- [Claude Code Hooks Documentation](https://docs.claude.com/en/docs/claude-code/hooks-reference)
- [AutoHotkey v2 Documentation](https://www.autohotkey.com/docs/v2/)
- [AHK-MCP Project Documentation](../docs/)

## Support

For issues or questions:

1. Check the troubleshooting section above
2. Review hook execution in transcript mode (Ctrl+R)
3. Enable verbose logging with `AHK_HOOK_VERBOSE=true`
4. Report issues in the project repository

---

**Last Updated:** 2025-10-02 **Version:** 1.0.0
