# Claude Code on Windows

How to use this server from Claude Code running natively on Windows (PowerShell,
not WSL). One script does the setup; this page says what it changes and how to
fix the usual problems.

## Prerequisites

| Need                                   | Install                                                 | Used for                                                                                                 |
| -------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Node.js 20 or newer                    | `winget install OpenJS.NodeJS.LTS`                      | building and running the server                                                                          |
| Claude Code CLI                        | `irm https://claude.ai/install.ps1 \| iex`              | `claude mcp ...`                                                                                         |
| AutoHotkey v2                          | `winget install AutoHotkey.AutoHotkey`                  | `AHK_Run`, `AHK_Check`, the validate hook                                                                |
| THQBY "AutoHotkey v2 Language Support" | `code --install-extension thqby.vscode-autohotkey2-lsp` | `AHK_Navigate` (optional)                                                                                |
| Git for Windows (recommended)          | `winget install Git.Git`                                | Claude Code's Bash tool; hooks run in Git Bash when it is installed, otherwise in PowerShell (both work) |

Open a new terminal after installing so `node` and `claude` are on `PATH`.

## Run the setup

From the repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-claude-code.ps1
```

Add `-WhatIf` (or `-DryRun`) to preview every change first. The script is
idempotent: re-run it after pulling, after installing AutoHotkey or the THQBY
extension, or to change options. It works in Windows PowerShell 5.1 and
PowerShell 7.

| Option                         | Default          | Effect                                                                             |
| ------------------------------ | ---------------- | ---------------------------------------------------------------------------------- |
| `-Toolsets core,uia`           | `core`           | Tool groups the server advertises (`AHK_MCP_TOOLSETS`)                             |
| `-Scope user\|local\|project`  | `user`           | Where the registration lives (see below)                                           |
| `-ScriptDir <dir>`             | none             | Your AHK scripts folder (`AHK_MCP_SCRIPT_DIR`); file tools may use it              |
| `-AllowedDirs <dirs>`          | none             | More folders for the file tools (`AHK_MCP_ALLOWED_DIRS`)                           |
| `-AhkPath <exe>`               | auto-detected    | AutoHotkey v2 executable; also saved for the hook in `.claude\settings.local.json` |
| `-ThqbyLspPath <js>`           | auto-detected    | THQBY `server\dist\server.js`                                                      |
| `-NodePath <exe>`              | `node` on `PATH` | node.exe to register                                                               |
| `-LogLevel`                    | `warn`           | `AHK_MCP_LOG_LEVEL`                                                                |
| `-UserHook`                    | off              | Also validate `.ahk` edits in every project (user settings)                        |
| `-InstallTemplates`            | off              | Install the claude-code-templates components listed below                          |
| `-SkipBuild`, `-SkipSmokeTest` | off              | Skip `npm ci` / `npm run build`, or the stdio check                                |

## What it does

1. Checks `node` >= 20, `npm` and `claude`, with install hints when missing.
2. Runs `npm ci` when `node_modules` is missing or older than
   `package-lock.json`, and `npm run build` when `dist\index.js` is missing or
   older than `src\`.
3. Starts `node dist\index.js`, sends `initialize` and `tools/list` over stdio,
   prints the tools, and stops if there is no answer within 20 s.
4. Finds AutoHotkey v2 and the newest THQBY language server.
5. Registers the server as **`ahk`** with `claude mcp add-json`. An existing
   `ahk` with the same command, environment and scope is left alone; any other
   `ahk` is removed from every scope first (a local or project entry would
   shadow a user one). The older names `ahk-server`, `ahk-mcp`, `ahk_mcp`,
   `autohotkey-v2` and `autohotkey` are removed only if they point at an ahk-mcp
   checkout. The registration uses the absolute path to `node.exe`, because
   Claude Code does not always pass your `PATH` to MCP servers.
6. Merges the settings below.
7. With `-InstallTemplates`, installs the selected catalog components.
8. Runs `claude mcp list` and `claude mcp get ahk`, reports whether `ahk` is
   connected, and prints what changed and how to undo it.

### Registration

| `-Scope`  | Stored in                                        | Available                                        |
| --------- | ------------------------------------------------ | ------------------------------------------------ |
| `user`    | `%USERPROFILE%\.claude.json`                     | every project                                    |
| `local`   | `%USERPROFILE%\.claude.json`, keyed to this repo | this repo, only for you                          |
| `project` | `.mcp.json` in this repo (gitignored here)       | this repo; pre-approved in `settings.local.json` |

Server environment: `NODE_ENV=production`, `AHK_MCP_LOG_LEVEL`,
`AHK_MCP_TOOLSETS`, plus `AHK_PATH`, `AHK_THQBY_LSP_SERVER`,
`AHK_MCP_SCRIPT_DIR` and `AHK_MCP_ALLOWED_DIRS` when known. Check it with
`claude mcp get ahk`.

### Settings

| File                                  | Gets                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude\settings.json`               | everything in `.claude\settings.example.json`: `mcp__ahk` and npm build/test/lint permissions, `.env` read denies, MCP timeouts, the validate hook |
| `.claude\settings.local.json`         | `AHK_PATH` (only with `-AhkPath`), `enabledMcpjsonServers: ["ahk"]` (only with `-Scope project`)                                                   |
| `%USERPROFILE%\.claude\settings.json` | the MCP timeouts (with `-Scope user`), the validate hook with an absolute path (with `-UserHook`)                                                  |

The merge only adds. Existing entries are never removed or overwritten (a
conflicting value is kept and reported), and a changed file is first copied to
`<file>.<timestamp>.bak`.

`.claude\settings.json` stays gitignored, as commit 273c33d set it up, because
git silently replaces an ignored local file when a tracked one arrives on pull.
The shared, path-free content is committed as `.claude\settings.example.json`.
Anything machine-specific belongs in `.claude\settings.local.json` or your user
settings.

Permissions use `mcp__ahk`, which covers every tool the server advertises, so
the allow list does not go stale when toolsets or tool names change. The rule
auto-approves script execution (`AHK_Run`, `AHK_Eval`) too. To be asked first,
add this to `.claude\settings.local.json`:

```json
{ "permissions": { "ask": ["mcp__ahk__AHK_Run", "mcp__ahk__AHK_Eval"] } }
```

MCP timeouts come from the claude-code-templates `settings/mcp/mcp-timeouts`
component: `MCP_TIMEOUT=30000` (server start), `MCP_TOOL_TIMEOUT=60000` (one
tool call, above the server's own 45 s `AHK_MCP_TOOL_TIMEOUT_MS`, so the server
reports its timeout first) and `MAX_MCP_OUTPUT_TOKENS=50000`.

## Toolsets

`AHK_MCP_TOOLSETS` is a comma list; the default is `core`. The setup script's
smoke test prints the tools the server actually advertises.

| Toolset   | Tools                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`    | `AHK_Check`, `AHK_Navigate`, `AHK_File_View`, `AHK_File_List`, `AHK_File_Active`, `AHK_File_Edit`, `AHK_File_Create`, `AHK_Run`, `AHK_Doc_Search`, `AHK_Eval`, `AHK_Config`, `AHK_Settings` |
| `debug`   | `AHK_Debug_DBGp`, `AHK_Debug_Agent`, `AHK_Cloud_Validate` (runs the code)                                                                                                                   |
| `library` | `AHK_Library_List`, `AHK_Library_Info`, `AHK_Library_Import`, `AHK_Library_Search`                                                                                                          |
| `uia`     | `uia_windows`, `uia_tree`, `uia_find`, `uia_element`, `uia_under_cursor`, `uia_highlight` (see [UIA_INSPECTION.md](UIA_INSPECTION.md))                                                      |
| `extras`  | `AHK_VSCode_Open`, `AHK_VSCode_Problems`, `AHK_Analytics`, `AHK_Tools_Search`                                                                                                               |
| `legacy`  | tools superseded by `AHK_Check`, `AHK_Navigate` and `AHK_File_Edit`, for old prompts and allow-lists                                                                                        |
| `all`     | everything                                                                                                                                                                                  |

You can also switch toolsets from inside a session with `AHK_Settings`
(`enable_toolset`, `disable_toolset`). Those choices are saved in the server's
`tool-settings.json` and take precedence over `AHK_MCP_TOOLSETS` until you run
`AHK_Settings { "action": "reset_toolsets" }`, so re-running this script with
`-Toolsets` has no visible effect after a runtime change until that reset.

To enable more, re-run the script, for example
`.\scripts\setup-claude-code.ps1 -Toolsets core,uia,library`, then restart
Claude Code or reconnect with `/mcp`. Builds from before the tool consolidation
ignore the variable and advertise every tool; the script says so when
`AHK_Check` is missing from the tool list.

## The validate hook

`.claude\hooks\validate-ahk.ps1` runs after `Edit`, `Write`, `MultiEdit` and the
server's `AHK_File_Edit` / `AHK_File_Create`. For anything that is not an
existing `.ahk` file it exits at once. For `.ahk` files it runs

```text
AutoHotkey64.exe /Validate /ErrorStdOut=utf-8 <file>
```

which loads the script without running it. Load-time errors exit with code 2, so
Claude sees the message and fixes the file. A missing AutoHotkey, a v1
interpreter (which would run the script instead of validating it) or a timeout
exits with code 1: shown to you, not blocking Claude. AutoHotkey comes from
`AHK_PATH`, then the standard install folders, then `PATH`;
`AHK_VALIDATE_TIMEOUT_SEC` changes the 15 s limit.

The hook command ends in `; exit $LASTEXITCODE` so exit code 2 survives when
Claude Code runs hooks through PowerShell (no Git Bash); under Git Bash it is a
plain `exit`. Each file edit starts one PowerShell process (a few hundred ms).
With `-UserHook`, edits inside this repo are validated twice (project and user
entries); that is harmless.

Only this hook is wired. The older `.claude\hooks\run-after-edit.py` is kept for
reference but not wired: it runs scripts after every edit, needs Python, and
matches the old server name `ahk_mcp`. The merge warns if your existing settings
still wire it.

Try it by hand:

```powershell
'{"tool_name":"Write","tool_input":{"file_path":"C:\\path\\to\\script.ahk"}}' |
  powershell -NoProfile -ExecutionPolicy Bypass -File .\.claude\hooks\validate-ahk.ps1
$LASTEXITCODE
```

## claude-code-templates components

`-InstallTemplates` runs
`npx claude-code-templates@latest --agent mcp-dev-team/mcp-testing-engineer --yes`
in the repo (with `CCT_NO_TRACKING=true`), skipping components already present.
The agent reviews MCP protocol compliance, tool schemas and annotations; the
repo already has `mcp-expert` and `typescript-pro`. The catalog fetches from its
`main` branch, so review what it writes.

Applied directly instead of through `npx`: `settings/mcp/mcp-timeouts`,
`settings/permissions/deny-sensitive-files` (narrowed to this repo's `.env`
files) and `settings/mcp/enable-specific-servers` (for `-Scope project`).

Not used: the catalog's hooks and status lines (bash, `jq`, `osascript`,
`notify-send`: Unix-only), `typescript-mcp-expert` (written for the v1
`@modelcontextprotocol/sdk` API, while this repo uses the v2
`@modelcontextprotocol/server` packages) and the PowerShell agents (aimed at AD,
Azure and M365 administration).

## Undo

The script prints the exact steps for what it changed. In general:

- `claude mcp remove ahk -s user` (or `-s local` / `-s project`)
- restore a settings file from its `.bak` copy, or delete a settings file the
  script created
- delete `.claude\agents\mcp-testing-engineer.md` if `-InstallTemplates` added
  it

## Troubleshooting

**`ahk` does not connect.** Run `claude mcp get ahk` for the status and
`claude --debug` to see the server's stderr. Start it by hand:
`& (Get-Command node).Source .\dist\index.js` should sit silently waiting on
stdin (Ctrl+C to stop); errors go to stderr. Re-run the setup script to rebuild.
If `claude mcp list` (run in the repo) shows an old `ahk-server` or similar
entry, remove it. A local entry beats a project entry, which beats a user entry.

**Pending approval (`-Scope project`).** Claude Code reads
`.claude\settings.local.json` only in a trusted folder. Run `claude` in the repo
once and accept the trust prompt, then check `/mcp`.

**`PATH` problems.** The registration stores the absolute `node.exe`, so Claude
Code does not need `node` on `PATH`. Re-run the script after moving or
reinstalling Node.js; nvm-windows switches are fine because its
`C:\Program Files\nodejs` link stays put. With fnm, the script warns about the
per-shell path and you should pass `-NodePath`. If `claude` is not found after
installing, open a new terminal and check that the installer's bin folder
(usually `%USERPROFILE%\.local\bin`) is on your user `PATH`.

**THQBY language server not found.** Install the extension. The script looks in
`.vscode`, `.vscode-insiders`, `.vscode-oss`, `.cursor` and `.windsurf` under
`%USERPROFILE%` for
`extensions\thqby.vscode-autohotkey2-lsp-*\server\dist\server.js` and takes the
newest version. The path contains the version, so re-run the script after the
extension updates, or pass `-ThqbyLspPath`.

**AutoHotkey not found.** The script and hook check `AHK_PATH`,
`%ProgramFiles%\AutoHotkey\v2\AutoHotkey64.exe`,
`%ProgramFiles%\AutoHotkey\AutoHotkey64.exe`,
`%LOCALAPPDATA%\Programs\AutoHotkey\v2\AutoHotkey64.exe` and `PATH`, and skip v1
executables. For another location pass `-AhkPath`.

**Execution policy.** Run the script with `-ExecutionPolicy Bypass` as shown,
and run `Unblock-File` on the repo's `.ps1` files if you downloaded a ZIP. The
hook also passes `-ExecutionPolicy Bypass`, but a Group Policy setting
(`MachinePolicy` or `UserPolicy` in `Get-ExecutionPolicy -List`) overrides it;
the script warns when that applies.

**The hook does not run or does not block.** Type `/hooks` in Claude Code to see
the registered hooks, and make sure `.claude\settings.json` is valid JSON. Exit
code 2 blocks; 1 is only shown to you.

**"Path is outside the allowed directories".** The file tools work in the folder
Claude Code was started in plus `AHK_MCP_SCRIPT_DIR` and `AHK_MCP_ALLOWED_DIRS`.
Re-run with `-ScriptDir` or `-AllowedDirs`.
