# AutoHotkey v2 MCP Server

A TypeScript MCP server for AutoHotkey v2 development. It provides script
analysis, file operations, documentation search, and script execution tools for
MCP clients such as Claude Desktop.

## Architecture

![AHK v2 MCP Agent Workflow](Diagram.png)

## Highlights

- 12 core tools by default, more in opt-in toolsets (see
  [Tools and toolsets](#tools-and-toolsets))
- `AHK_Check`: one checker that uses AutoHotkey's own `/Validate` when available
- `AHK_Navigate`: definition, references, rename and symbols through THQBY's v2
  language server
- Six read-only `uia_*` tools that feed live UI Automation ground truth to the
  model, so it writes correct selectors instead of guessing them
- Focused file discovery and active-file aware operations
- Script execution with process tracking and window detection
- Local AutoHotkey validation and diagnostics tools
- Built-in AutoHotkey docs and prompt/context helpers
- Stdio and Streamable HTTP transport support, with opt-in legacy SSE
  compatibility

## UIA inspection

Writing UIA automation without inspecting the live tree means guessing
selectors. These tools remove the guesswork:

```
uia_windows  ->  uia_tree  ->  uia_find / uia_element  ->  paste snippet  ->  uia_highlight
   which          what's         the exact control        into your .ahk      confirm it is
   window         in it          + verified selector      script              the right one
```

They are in the `uia` toolset; enable it with `AHK_MCP_TOOLSETS=core,uia` or
`AHK_Settings { "action": "enable_toolset", "toolset": "uia" }`.

Every element result carries a paste-ready AHK v2 snippet that has been executed
against the live tree and confirmed to resolve back to that exact element. Paths
are property chains, not RuntimeIds, so they still work after the target app
restarts.

All six tools are strictly read-only — they read properties and pattern
availability but never invoke a control pattern, so none of them can press,
toggle, select, or delete anything in the target app.

Full reference, including the selector-validation hook and Electron/WebView2
guidance: [`docs/UIA_INSPECTION.md`](docs/UIA_INSPECTION.md).

## Requirements

- Node.js 20+
- npm
- AutoHotkey v2 (for `AHK_Run`, `AHK_Eval` and `AHK_Check`'s interpreter engine)
- Optional: THQBY's
  [AutoHotkey v2 Language Support](https://marketplace.visualstudio.com/items?itemName=thqby.vscode-autohotkey2-lsp)
  VS Code extension, for `AHK_Navigate` and `AHK_Check`'s language-server
  engine. It is found automatically in the VS Code extensions folder, or set
  `AHK_THQBY_LSP_SERVER` to its `server/dist/server.js`

## Installation

```bash
git clone https://github.com/truecrimedev/ahk-mcp.git
cd ahk-mcp
npm install
npm run build
```

## Run

```bash
npm start
```

Development mode:

```bash
npm run dev
```

Smoke test:

```bash
npm run smoke:mcp
npm run smoke:http
npm run test:evals    # eval grader tests
npm run eval:tasks    # task evals with and without the server (see evals/README.md; costs API credits)
```

## Claude Desktop Configuration

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ahk": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\YourUsername\\path\\to\\ahk-mcp\\dist\\index.js"],
      "env": {
        "NODE_ENV": "production",
        "AHK_MCP_LOG_LEVEL": "warn",
        "AHK_MCP_TOOLSETS": "core",
        "AHK_MCP_SCRIPT_DIR": "C:\\Users\\YourUsername\\Documents\\AutoHotkey"
      }
    }
  }
}
```

Use absolute paths and escape backslashes in JSON. A ready-to-edit template is
in [`.mcp.example.json`](.mcp.example.json).

## Claude Code on Windows

`scripts/setup-claude-code.ps1` builds the server, registers it with Claude Code
as `ahk`, detects AutoHotkey and the THQBY language server, and checks that the
server answers. See
[`docs/CLAUDE_CODE_WINDOWS.md`](docs/CLAUDE_CODE_WINDOWS.md).

## File Access

File tools only read and write inside allowed directories: the client's MCP
roots, `AHK_MCP_SCRIPT_DIR`, the `scriptDir`/`searchDirs` set with `AHK_Config`,
the server's working directory, and `AHK_MCP_ALLOWED_DIRS`. Paths are checked
after resolving symlinks, and writes through a symlink are refused.

| Variable                       | Effect                                                          |
| ------------------------------ | --------------------------------------------------------------- |
| `AHK_MCP_ALLOWED_DIRS`         | Extra allowed folders, `;`-separated (Windows or POSIX paths)   |
| `AHK_MCP_UNRESTRICTED_PATHS=1` | Turn off the allowlist (the symlink guard stays on)             |
| `AHK_MCP_ALLOW_REMOTE_DEBUG=1` | Let `AHK_Debug_Agent` listen on / forward to non-loopback hosts |
| `AHK_MCP_TRANSPORT=http`       | Serve Streamable HTTP instead of stdio (same as `--http`)       |

## Configure AutoHotkey Path and Startup Behavior

Use `AHK_Config` to set the executable path and non-blocking startup behavior:

```json
{
  "action": "set",
  "ahkPath": "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe",
  "waitForStdoutLine": true,
  "stdoutLineTimeoutMs": 300
}
```

This is used by `AHK_Run` (and `AHK_Cloud_Validate` path resolution).

## Tools and toolsets

Every tool a server lists costs context in every session, so only the `core`
toolset is listed by default. Pick toolsets with `AHK_MCP_TOOLSETS`
(comma-separated, or `all`), or at runtime with `AHK_Settings`
(`enable_toolset`, `disable_toolset`, `reset_toolsets`); the server then sends
`tools/list_changed`. `AHK_Settings` is always listed.

| Toolset          | Tools                                                                                                                                                                                                                                                                                                                                                                        |
| :--------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core` (default) | `AHK_Check`, `AHK_Navigate`, `AHK_File_View`, `AHK_File_List`, `AHK_File_Active`, `AHK_File_Edit`, `AHK_File_Create`, `AHK_Run`, `AHK_Doc_Search`, `AHK_Eval`, `AHK_Config`, `AHK_Settings`                                                                                                                                                                                  |
| `debug`          | `AHK_Debug_DBGp`, `AHK_Debug_Agent`, `AHK_Cloud_Validate` (runs the code)                                                                                                                                                                                                                                                                                                    |
| `library`        | `AHK_Library_List`, `AHK_Library_Info`, `AHK_Library_Import`, `AHK_Library_Search`                                                                                                                                                                                                                                                                                           |
| `uia`            | `uia_windows`, `uia_tree`, `uia_find`, `uia_element`, `uia_under_cursor`, `uia_highlight`                                                                                                                                                                                                                                                                                    |
| `extras`         | `AHK_VSCode_Open`, `AHK_VSCode_Problems`, `AHK_Analytics`, `AHK_Tools_Search`                                                                                                                                                                                                                                                                                                |
| `legacy`         | Superseded tools kept for old prompts: `AHK_Diagnostics`, `AHK_Analyze`, `AHK_LSP`, `AHK_Lint`, `AHK_THQBY_Document_Symbols`, `AHK_Workflow_Analyze_Fix_Run`, `AHK_File_Edit_Small`, `AHK_File_Edit_Advanced`, `AHK_File_Recent`, `AHK_File_Detect`, `AHK_Context_Injector`, `AHK_Process_Request`, `AHK_Smart_Orchestrator`, `AHK_Summary`, `AHK_Prompts`, `AHK_Repl_Reset` |

- `AHK_Check` replaces the analysis tools. It runs up to three engines:
  AutoHotkey itself with `/Validate` (loads the script without running it: the
  authoritative load-time errors), THQBY's language server, and built-in static
  checks. Static errors become warnings when an authoritative engine ran.
  Results come back as text and as `structuredContent`.
- `AHK_Navigate` does `symbols`, `definition`, `references`, `hover`,
  `workspace_symbols` and `rename` through one long-lived THQBY process. Without
  THQBY, symbols, definition and references fall back to a text search marked
  `approximate`. Rename previews by default.
- `AHK_Eval { "reset": true }` replaces `AHK_Repl_Reset`.

## Development Commands

```bash
npm run build
npm run clean
npm run lint
npm run test
npm run test:integration
npm run smoke:mcp
npm run smoke:http
```

## Documentation

- `docs/README.md`
- `docs/QUICK_START.md`
- `docs/QUICKREFERENCE.md`
- `docs/MCP_TRANSPORT_COMPATIBILITY.md`
- `docs/ARCHITECTURE_DIAGRAMS.md`
- `docs/RELEASE_NOTES.md`

## Contributing

See `CONTRIBUTING.md` and `AGENTS.md`.

## License

MIT. See `LICENSE`.
