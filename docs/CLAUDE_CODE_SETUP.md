# Setting Up AutoHotkey MCP Server for Claude Code

> On native Windows, use [CLAUDE_CODE_WINDOWS.md](CLAUDE_CODE_WINDOWS.md)
> instead: `scripts/setup-claude-code.ps1` registers the server as `ahk` and
> removes the older `autohotkey-v2` registration shown below.

This guide will help you configure your AutoHotkey v2 MCP Server to work with
Claude Code.

## Prerequisites

1. **Node.js installed** (version 18 or higher)
2. **AutoHotkey v2 installed** (for Windows functionality)
3. **Claude Code CLI** installed and authenticated
4. **Your MCP server built** (`npm run build` completed)

## Setup Options

### Option 1: Command Line Setup (Recommended)

```bash
# Navigate to your project directory
cd "C:\path\to\ahk-mcp"

# Add the MCP server to Claude Code
claude mcp add autohotkey-v2 \
  --env NODE_ENV=production \
  --env AHK_MCP_DATA_MODE=full \
  --env AHK_MCP_LIGHT=0 \
  -- node dist/index.js
```

### Option 2: Configuration File Setup

1. Copy the appropriate configation file:
   - **Windows:** Use `.mcp.windows.json`
   - **WSL/Linux:** Use `.mcp.json`

2. For Windows PowerShell:

```powershell
# Copy Windows configuration
Copy-Item .mcp.windows.json .mcp.json
```

3. For WSL/Linux:

```bash
# The .mcp.json is already configured for WSL paths
```

## Environment Variables

| Variable            | Value        | Description                  |
| ------------------- | ------------ | ---------------------------- | --- |
| `NODE_ENV`          | `production` | Optimizes for production use |
| `AHK_MCP_DATA_MODE` | `full`       | Loads complete documentation | ng  |
| `AHK_MCP_LIGHT`     | `0`          | Disables light mode          |

## Verify Installation

```bash
# List configured MCP servers
claude mcp list

# Get details about your AutoHotkey server
claude mcp get autohotkey-v2

# Test the server connection
node dist/index.js
```

## Available Tools

Once configured, Claude Code will have access to these AutoHotkey tools:

### 🔧 Core Tools

- `AHK_Run` - Run AutoHotkey scripts (with window detection!)
- `AHK_Analyze` - Analyze AutoHotkey code syntax
- `AHK_LSP` - Get language-server style completions and diagnostics
- `AHK_Diagnostics` - Check for code issues

### 📝 Documentation Tools

- `AHK_Doc_Search` - Search AutoHotkey documentation
- `AHK_Summary` - Get quick reference summaries
- `AHK_Context_Injector` - Auto-inject relevant docs

### 🛠️ Development Tools

- `AHK_Debug_Agent` - Debug assistance
- `AHK_VSCode_Problems` - VS Code integration
- `AHK_Config` - Configuration management
- `AHK_File_Active` - Active file tracking

### 📋 Utility Tools

- `AHK_File_Recent` - Track recent scripts
- `AHK_Prompts` - Access prompt templates
- `AHK_Sampling_Enhancer` - Enhance code samples

## Testing the Setup

### Basic Test

```bash
# Start Claude Code and try:
/AHK_Summary
```

### Window Detection Test

```bash
# In Claude Code, try running your test script:
{
  "tool": "AHK_Run",
  "args": {
    "mode": "run",
    "filePath": "C:\\path\\to\\your\\script.ahk",
    "wait": false,
    "detectWindow": true,
    "windowDetectTimeout": 5000
  }
}
```

## Troubleshooting

### Common Issues

**"Command not found" errors:**

- Ensure Node.js is in your PATH
- Verify `npm run build` completed successfully
- Check file paths in configuration

**"AutoHotkey not found" errors:**

- Install AutoHotkey v2 from https://autohotkey.com
- Or specify `ahkPath` parameter in tool calls

**Connection issues:**

- Check that the MCP server starts without errors
- Verify environment variables are set correctly
- Ensure no other processes are using the same resources

### Debug Mode

```bash
# Run server manually to see debug output
cd "C:\path\to\ahk-mcp"
NODE_ENV=development node dist/index.js
```

## Configuration Scopes

- **Project scope:** Configuration applies only to this project
- **User scope:** Available across all Claude Code projects
- **Local scope:** Private to your development environment

## Next Steps

1. **Test window detection** with your existing AutoHotkey scripts
2. **Use code analysis tools** to improve your AHK code quality
3. **Leverage documentation search** for faster development
4. **Set up watch mode** for automatic script reloading

## Support

For issues:

- Check server logs with `NODE_ENV=development node dist/index.js`
- Verify AutoHotkey installation with `autohotkey --version`
- Test MCP connection with `claude mcp list`

Your AutoHotkey MCP server is now ready to enhance your AutoHotkey development
workflow in Claude Code!
