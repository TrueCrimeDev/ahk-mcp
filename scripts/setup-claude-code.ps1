#Requires -Version 5.1
<#
.SYNOPSIS
    Set up Claude Code on Windows to use this repo's AutoHotkey v2 MCP server.

.DESCRIPTION
    Idempotent: re-run it after pulling, after installing AutoHotkey or the THQBY
    VS Code extension, or to change toolsets. It

      1. checks for node >= 20, npm and the claude CLI;
      2. runs npm ci (node_modules missing or older than package-lock.json) and
         npm run build (dist\index.js missing or older than src\);
      3. smoke-tests the server over stdio (initialize + tools/list, 20 s limit);
      4. finds AutoHotkey v2 and the THQBY AHK v2 language server;
      5. removes stale registrations (ahk, plus ahk-server / ahk-mcp / ahk_mcp /
         autohotkey-v2 / autohotkey when they point at an ahk-mcp checkout) and
         registers the server as "ahk" with `claude mcp add-json`, using the
         absolute path to node.exe;
      6. merges .claude\settings.example.json into .claude\settings.json (project,
         gitignored), puts machine-specific values in .claude\settings.local.json,
         and adds the MCP timeouts to your user settings when -Scope user;
      7. optionally installs a short list of claude-code-templates components;
      8. verifies with `claude mcp list` / `claude mcp get ahk` and prints a summary
         with undo steps.

    -WhatIf (or -DryRun) previews every change without making it.

.PARAMETER RepoPath
    The ahk-mcp checkout. Default: the repo this script lives in.

.PARAMETER Toolsets
    Tool groups the server advertises (AHK_MCP_TOOLSETS): core, debug, library, uia,
    extras, legacy, all. Comma list or array. Default: core.

.PARAMETER AhkPath
    AutoHotkey v2 executable. Default: AHK_PATH, then the standard install locations.

.PARAMETER Scope
    Where Claude Code stores the registration: user (all projects, default),
    local (this repo, private) or project (this repo's .mcp.json, gitignored here).

.PARAMETER ThqbyLspPath
    vscode-autohotkey2-lsp server\dist\server.js. Default: newest THQBY extension found
    under %USERPROFILE%\.vscode\extensions (and Insiders / VSCodium / Cursor).

.PARAMETER NodePath
    node.exe to register. Default: node on PATH.

.PARAMETER ScriptDir
    Your AutoHotkey scripts folder (AHK_MCP_SCRIPT_DIR). The file tools may read and
    write there in addition to the folder Claude Code was started in.

.PARAMETER AllowedDirs
    Extra folders the file tools may use (AHK_MCP_ALLOWED_DIRS).

.PARAMETER LogLevel
    Server log level (AHK_MCP_LOG_LEVEL). Default: warn.

.PARAMETER UserHook
    Also add the validate-ahk hook to your user settings, so .ahk edits are checked
    in every project, not only in this repo.

.PARAMETER InstallTemplates
    Install the claude-code-templates components listed in $TemplateComponents.

.PARAMETER DryRun
    Same as -WhatIf.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-claude-code.ps1

.EXAMPLE
    .\scripts\setup-claude-code.ps1 -Toolsets core,uia -ScriptDir "$HOME\Documents\AutoHotkey" -WhatIf
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
    Justification = 'Interactive setup script; output is for the person running it.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSShouldProcess', '',
    Justification = 'Test-ShouldApply routes every change through the script-level $PSCmdlet.ShouldProcess.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
    Justification = 'Helpers are gated by Test-ShouldApply (script-level ShouldProcess).')]
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$RepoPath,
    [string[]]$Toolsets = @('core'),
    [string]$AhkPath,
    [ValidateSet('user', 'local', 'project')]
    [string]$Scope = 'user',
    [string]$ThqbyLspPath,
    [string]$NodePath,
    [string]$ScriptDir,
    [string[]]$AllowedDirs,
    [ValidateSet('error', 'warn', 'info', 'debug')]
    [string]$LogLevel = 'warn',
    [switch]$SkipBuild,
    [switch]$SkipSmokeTest,
    [switch]$UserHook,
    [switch]$InstallTemplates,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------------------------
$ServerName = 'ahk'
# Names earlier docs registered this server under (YOLO.md, docs/CLAUDE_CODE_SETUP.md,
# docs/CLAUDE_CODE_INSTALL.md, docs/REMOTE_ACCESS_GUIDE.md, the old mcp__ahk_mcp__ hook matcher).
$LegacyServerNames = @('ahk-server', 'ahk-mcp', 'ahk_mcp', 'autohotkey-v2', 'autohotkey')
$ValidToolsets = @('core', 'debug', 'library', 'uia', 'extras', 'legacy', 'all')
$MinNodeVersion = [version]'20.0'
$SmokeTimeoutSec = 20

# claude-code-templates components installed by -InstallTemplates. Everything else this setup
# takes from that catalog is applied directly from .claude\settings.example.json instead:
#   settings/mcp/mcp-timeouts            -> "env" (MCP_TIMEOUT 30000, MCP_TOOL_TIMEOUT 60000,
#                                           MAX_MCP_OUTPUT_TOKENS 50000)
#   settings/permissions/deny-sensitive-files -> "permissions.deny", narrowed to this repo's .env files
#   settings/mcp/enable-specific-servers -> enabledMcpjsonServers ["ahk"] when -Scope project
# Rejected: every catalog hook and statusline (bash + jq / osascript / notify-send: Unix-only),
# typescript-mcp-expert (written for the v1 @modelcontextprotocol/sdk API; this repo is on the
# v2 @modelcontextprotocol/server packages), powershell-5.1/7 experts (AD/Azure/M365 focus),
# and re-installing mcp-expert / typescript-pro (already in .claude\agents).
$TemplateComponents = @(
    # MCP QA specialist: schema, tool-annotation and error-path checks against the server.
    # Complements .claude\agents\mcp-expert.md, which covers client configuration.
    [pscustomobject]@{
        Flag = '--agent'
        Name = 'mcp-dev-team/mcp-testing-engineer'
        File = '.claude\agents\mcp-testing-engineer.md'
    }
)

# ---------------------------------------------------------------------------------------------
# Output and bookkeeping
# ---------------------------------------------------------------------------------------------
$script:Changes = New-Object System.Collections.Generic.List[string]
$script:Warnings = New-Object System.Collections.Generic.List[string]
$script:Undo = New-Object System.Collections.Generic.List[string]
$script:PreviewOnly = [bool]$DryRun -or [bool]$WhatIfPreference
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Section([string]$Title) {
    Write-Host ''
    Write-Host "== $Title" -ForegroundColor Cyan
}
function Write-Ok([string]$Message) { Write-Host "  [ok]   $Message" -ForegroundColor Green }
function Write-Note([string]$Message) { Write-Host "  [..]   $Message" }
function Write-Warn([string]$Message) {
    Write-Host "  [warn] $Message" -ForegroundColor Yellow
    $script:Warnings.Add($Message)
}
function Add-Change([string]$Message) { $script:Changes.Add($Message) }
function Add-Undo([string]$Message) { if (-not $script:Undo.Contains($Message)) { $script:Undo.Add($Message) } }

function Test-ShouldApply([string]$Target, [string]$Action) {
    if ($DryRun -and -not $WhatIfPreference) {
        Write-Host "  [dry-run] $Action : $Target" -ForegroundColor DarkYellow
        return $false
    }
    return $PSCmdlet.ShouldProcess($Target, $Action)
}

function Test-IsWindowsHost {
    return [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

# Run a native command and capture its output without Windows PowerShell 5.1 turning
# stderr lines into terminating errors under $ErrorActionPreference = 'Stop'.
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    try {
        $output = & $FilePath @ArgumentList 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ ExitCode = $code; Output = ((@($output) -join "`n").Trim()) }
}

# Stream a native command's output to the console; throw on a non-zero exit code.
function Invoke-NativeStreaming {
    param([string]$FilePath, [string[]]$ArgumentList, [string]$Description)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    try {
        & $FilePath @ArgumentList | Out-Host
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { throw "$Description failed (exit code $code)." }
}

function Resolve-CommandPath([string[]]$Names) {
    foreach ($name in $Names) {
        $cmd = Get-Command -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) { return $cmd.Source }
    }
    return $null
}

function Get-FullPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($full -match '^[A-Za-z]:$') { $full += '\' }  # keep drive roots absolute
    if (-not $full) { $full = '/' }
    return $full
}

# ---------------------------------------------------------------------------------------------
# Native argument passing: JSON for `claude mcp add-json`
# ---------------------------------------------------------------------------------------------
# Windows PowerShell 5.1 (and 7.x in Legacy mode, or for .cmd shims) passes embedded double
# quotes to native programs unescaped, which corrupts JSON arguments. The JSON built here has
# no spaces or cmd.exe metacharacters (they are written as \uXXXX escapes, which JSON.parse
# restores), so the only thing left to fix in legacy mode is escaping the quotes.
function Test-LegacyNativeArgumentPassing([string]$CommandPath) {
    if ($PSVersionTable.PSVersion -lt [version]'7.3') { return $true }
    $mode = Get-Variable -Name PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue
    if ($null -eq $mode -or "$mode" -eq 'Legacy') { return $true }
    if ("$mode" -eq 'Windows' -and $CommandPath -match '\.(cmd|bat)$') { return $true }
    return $false
}

function ConvertTo-SafeJsonString([string]$Value) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $Value.ToCharArray()) {
        $code = [int]$ch
        if ($ch -eq [char]'\') {
            [void]$sb.Append('\\')
        } elseif ($code -lt 0x21 -or $code -gt 0x7E -or ' "&|<>^%''()!`'.IndexOf($ch) -ge 0) {
            [void]$sb.Append(('\u{0:x4}' -f $code))
        } else {
            [void]$sb.Append($ch)
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function ConvertTo-McpServerJson {
    param([string]$Command, [string[]]$ArgumentList, [System.Collections.IDictionary]$Environment)
    $argJson = @($ArgumentList | ForEach-Object { ConvertTo-SafeJsonString $_ }) -join ','
    $envJson = @($Environment.Keys | ForEach-Object {
            (ConvertTo-SafeJsonString $_) + ':' + (ConvertTo-SafeJsonString ([string]$Environment[$_]))
        }) -join ','
    return '{"type":"stdio","command":' + (ConvertTo-SafeJsonString $Command) +
        ',"args":[' + $argJson + '],"env":{' + $envJson + '}}'
}

# MSVCRT command-line rules: before each double quote, double the preceding backslashes and
# add one. Valid only for arguments without whitespace (PowerShell then adds no outer quotes).
function ConvertTo-LegacyNativeArgument([string]$Argument) {
    $sb = New-Object System.Text.StringBuilder
    $backslashes = 0
    foreach ($ch in $Argument.ToCharArray()) {
        if ($ch -eq [char]'\') { $backslashes++; continue }
        if ($ch -eq [char]'"') {
            [void]$sb.Append(('\' * ($backslashes * 2 + 1)) + '"')
        } else {
            [void]$sb.Append(('\' * $backslashes) + $ch)
        }
        $backslashes = 0
    }
    [void]$sb.Append('\' * $backslashes)
    return $sb.ToString()
}

# ---------------------------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------------------------
function Get-AhkMajorVersion([string]$Path) {
    try { return [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path).FileMajorPart } catch { return 0 }
}

function Resolve-AhkExecutable([string]$Explicit) {
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit -PathType Leaf)) { throw "-AhkPath not found: $Explicit" }
        return (Resolve-Path -LiteralPath $Explicit).ProviderPath
    }
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($env:AHK_PATH) { $candidates.Add($env:AHK_PATH.Trim().Trim('"')) }
    if ($env:ProgramFiles) {
        $candidates.Add([System.IO.Path]::Combine($env:ProgramFiles, 'AutoHotkey', 'v2', 'AutoHotkey64.exe'))
        $candidates.Add([System.IO.Path]::Combine($env:ProgramFiles, 'AutoHotkey', 'AutoHotkey64.exe'))
    }
    if ($env:LOCALAPPDATA) {
        $candidates.Add([System.IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'AutoHotkey', 'v2', 'AutoHotkey64.exe'))
    }
    foreach ($candidate in $candidates) {
        if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        if ((Get-AhkMajorVersion $candidate) -eq 1) {
            Write-Warn "skipping $candidate (AutoHotkey v1; this server needs v2)"
            continue
        }
        return (Resolve-Path -LiteralPath $candidate).ProviderPath
    }
    $onPath = Resolve-CommandPath @('AutoHotkey64.exe')
    if ($onPath -and (Get-AhkMajorVersion $onPath) -ne 1) { return $onPath }
    return $null
}

function Resolve-ThqbyLspServer([string]$Explicit) {
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit -PathType Leaf)) { throw "-ThqbyLspPath not found: $Explicit" }
        return (Resolve-Path -LiteralPath $Explicit).ProviderPath
    }
    if ($env:AHK_THQBY_LSP_SERVER -and (Test-Path -LiteralPath $env:AHK_THQBY_LSP_SERVER -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $env:AHK_THQBY_LSP_SERVER).ProviderPath
    }
    $homeDir = $env:USERPROFILE
    if (-not $homeDir) { $homeDir = $HOME }
    $found = @()
    foreach ($editorDir in '.vscode', '.vscode-insiders', '.vscode-oss', '.cursor', '.windsurf') {
        $extensions = [System.IO.Path]::Combine($homeDir, $editorDir, 'extensions')
        if (-not (Test-Path -LiteralPath $extensions -PathType Container)) { continue }
        foreach ($dir in Get-ChildItem -LiteralPath $extensions -Directory -Filter 'thqby.vscode-autohotkey2-lsp-*' -ErrorAction SilentlyContinue) {
            $server = [System.IO.Path]::Combine($dir.FullName, 'server', 'dist', 'server.js')
            if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { continue }
            $version = [version]'0.0'
            if ($dir.Name -match '-(\d+(?:\.\d+){1,3})(?:-[A-Za-z0-9-]+)?$') { $version = [version]$Matches[1] }
            $found += [pscustomobject]@{ Path = $server; Version = $version; Time = $dir.LastWriteTimeUtc }
        }
    }
    if ($found.Count -eq 0) { return $null }
    $best = $found | Sort-Object -Property @{ Expression = 'Version'; Descending = $true }, @{ Expression = 'Time'; Descending = $true } |
        Select-Object -First 1
    return $best.Path
}

function Resolve-NodeExecutable([string]$Explicit) {
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit -PathType Leaf)) { throw "-NodePath not found: $Explicit" }
        return (Resolve-Path -LiteralPath $Explicit).ProviderPath
    }
    $cmd = Get-Command -Name node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { return $null }
    return $cmd.Source
}

# ---------------------------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------------------------
function Get-NewestWriteTimeUtc([string[]]$Paths) {
    $newest = [datetime]::MinValue
    foreach ($path in $Paths) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $item = Get-Item -Force -LiteralPath $path
        $items = if ($item.PSIsContainer) { Get-ChildItem -Force -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue } else { @($item) }
        foreach ($file in $items) { if ($file.LastWriteTimeUtc -gt $newest) { $newest = $file.LastWriteTimeUtc } }
    }
    return $newest
}

function Get-RunningServerProcess([string]$Entry) {
    if (-not (Test-IsWindowsHost)) { return @() }
    try {
        return @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
                Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($Entry, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    } catch {
        return @()
    }
}

# ---------------------------------------------------------------------------------------------
# Stdio smoke test: initialize + tools/list
# ---------------------------------------------------------------------------------------------
function Read-JsonRpcResponse {
    param($Reader, [int]$Id, [datetime]$Deadline, [hashtable]$State)
    while ($true) {
        if ($null -eq $State.Pending) { $State.Pending = $Reader.ReadLineAsync() }
        $remainingMs = [int][Math]::Max(0, ($Deadline - [datetime]::UtcNow).TotalMilliseconds)
        if (-not $State.Pending.Wait($remainingMs)) { return $null }
        $line = $State.Pending.Result
        $State.Pending = $null
        if ($null -eq $line) { throw 'the server closed stdout (it exited)' }
        $line = $line.Trim()
        if (-not $line.StartsWith('{')) { continue }
        try { $message = $line | ConvertFrom-Json } catch { continue }
        $idProperty = $message.PSObject.Properties['id']
        if ($idProperty -and "$($idProperty.Value)" -eq "$Id") { return $message }
    }
}

function Invoke-StdioSmokeTest {
    param([string]$Node, [string]$Entry, [System.Collections.IDictionary]$Environment, [int]$TimeoutSec)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Node
    $psi.Arguments = '"' + $Entry + '"'
    $psi.WorkingDirectory = $RepoPath
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $Utf8NoBom
    $psi.StandardErrorEncoding = $Utf8NoBom
    foreach ($key in $Environment.Keys) { $psi.EnvironmentVariables[[string]$key] = [string]$Environment[$key] }

    $started = [datetime]::UtcNow
    $deadline = $started.AddSeconds($TimeoutSec)
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    # Own writer over the raw stream: no BOM, LF line endings.
    $stdin = New-Object System.IO.StreamWriter($proc.StandardInput.BaseStream, $Utf8NoBom)
    $stdin.NewLine = "`n"
    $stdin.AutoFlush = $true
    $state = @{ Pending = $null }
    $failure = $null
    $names = @()
    $serverInfo = ''
    try {
        $stdin.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"setup-claude-code","version":"1.0.0"}}}')
        $init = Read-JsonRpcResponse -Reader $proc.StandardOutput -Id 1 -Deadline $deadline -State $state
        if ($null -eq $init) { throw "no response to initialize within $TimeoutSec s" }
        if ($init.PSObject.Properties['error']) { throw "initialize failed: $($init.error.message)" }
        $info = $init.result.PSObject.Properties['serverInfo']
        if ($info) { $serverInfo = "$($info.Value.name) $($info.Value.version)" }
        $stdin.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}')

        $cursor = $null
        $id = 2
        do {
            $params = if ($cursor) { '{"cursor":' + (ConvertTo-SafeJsonString $cursor) + '}' } else { '{}' }
            $stdin.WriteLine('{"jsonrpc":"2.0","id":' + $id + ',"method":"tools/list","params":' + $params + '}')
            $page = Read-JsonRpcResponse -Reader $proc.StandardOutput -Id $id -Deadline $deadline -State $state
            if ($null -eq $page) { throw "no response to tools/list within $TimeoutSec s" }
            if ($page.PSObject.Properties['error']) { throw "tools/list failed: $($page.error.message)" }
            $names += @($page.result.tools | ForEach-Object { $_.name })
            $next = $page.result.PSObject.Properties['nextCursor']
            $cursor = if ($next -and $next.Value) { [string]$next.Value } else { $null }
            $id++
        } while ($cursor -and $id -lt 50)
    } catch {
        $failure = $_.Exception.Message
    } finally {
        try { $stdin.Close() } catch { Write-Verbose "closing server stdin: $_" }
        if (-not $proc.WaitForExit(3000)) { try { $proc.Kill() } catch { Write-Verbose "stopping server: $_" } }
    }
    if ($failure) {
        $stderr = ''
        if ($stderrTask.Wait(2000)) { $stderr = $stderrTask.Result }
        $tail = @($stderr -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 15) -join "`n    "
        if ($tail) { $failure += "`n  server stderr (last lines):`n    $tail" }
        throw "Stdio smoke test failed: $failure"
    }
    return [pscustomobject]@{
        ServerInfo = $serverInfo
        ToolNames  = @($names)
        ElapsedMs  = [int]([datetime]::UtcNow - $started).TotalMilliseconds
    }
}

# ---------------------------------------------------------------------------------------------
# Claude Code CLI
# ---------------------------------------------------------------------------------------------
function Invoke-Claude([string[]]$ArgumentList) {
    return Invoke-Native -FilePath $script:ClaudeCli -ArgumentList $ArgumentList
}

function Get-McpRegistration([string]$Name) {
    $result = Invoke-Claude @('mcp', 'get', $Name)
    if ($result.ExitCode -ne 0) { return $null }
    return $result.Output
}

# Pull "Scope:", "Command:", "Args:" and the "Environment:" block out of `claude mcp get`.
function ConvertFrom-McpGetOutput([string]$Text) {
    $info = @{ Scope = ''; Command = ''; Args = ''; Env = @() }
    $inEnv = $false
    foreach ($line in ($Text -split "`n")) {
        if ($line -match '^\s*Environment:\s*$') { $inEnv = $true; continue }
        if ($inEnv) {
            if ($line -match '^\s{3,}(\S.*)$' -and $line -notmatch '^\s*To remove') { $info.Env += $Matches[1].TrimEnd(); continue }
            $inEnv = $false
        }
        if ($line -match '^\s*(Scope|Command|Args):\s*(.*)$') { $info[$Matches[1]] = $Matches[2].Trim() }
    }
    return $info
}

function Test-RegistrationCurrent {
    param([string]$Details, [string]$ExpectedScope, [string]$Command, [string]$Arguments, [System.Collections.IDictionary]$Environment)
    $info = ConvertFrom-McpGetOutput $Details
    $scopeWord = @{ user = 'User'; local = 'Local'; project = 'Project' }[$ExpectedScope]
    if ($info.Scope -notmatch "^$scopeWord\b") { return $false }
    if ($info.Command -ne $Command -or $info.Args -ne $Arguments) { return $false }
    $want = @($Environment.Keys | ForEach-Object { "$_=$($Environment[$_])" } | Sort-Object)
    $have = @($info.Env | Sort-Object)
    return (($want -join "`n") -eq ($have -join "`n"))
}

function Remove-McpRegistration([string]$Name, [string]$Reason) {
    $removed = $false
    if (-not (Test-ShouldApply "$Name (local, project and user scopes)" "Remove MCP registration ($Reason)")) { return $removed }
    foreach ($s in 'local', 'project', 'user') {
        $result = Invoke-Claude @('mcp', 'remove', $Name, '-s', $s)
        if ($result.ExitCode -eq 0) {
            Write-Ok "removed '$Name' from $s scope"
            Add-Change "Removed MCP server '$Name' ($s scope)"
            $removed = $true
        }
    }
    return $removed
}

# ---------------------------------------------------------------------------------------------
# Settings merge (scripts\merge-claude-settings.mjs does the JSON work)
# ---------------------------------------------------------------------------------------------
function Invoke-SettingsMerge {
    param(
        [string]$Target,
        [string]$PatchFile,
        [string]$Label,
        [string[]]$ExtraArguments = @()
    )
    $apply = Test-ShouldApply $Target "Merge $Label"
    $helperArgs = @($script:MergeHelper, '--target', $Target, '--patch', $PatchFile) + $ExtraArguments
    if (-not $apply) { $helperArgs += '--dry-run' }
    $result = Invoke-Native -FilePath $script:NodeExe -ArgumentList $helperArgs
    if ($result.ExitCode -ne 0) { throw "Settings merge failed for ${Target}: $($result.Output)" }
    $report = ($result.Output -split "`n" | Select-Object -Last 1) | ConvertFrom-Json
    $verb = if ($apply) { 'updated' } else { 'would update' }
    if ($report.changed) {
        Write-Ok "$verb $Target ($Label)"
        foreach ($change in $report.changes) { Write-Note "  $change" }
        if ($apply) {
            Add-Change "Settings: $Target ($($report.changes.Count) change(s))"
            if ($report.backup) {
                Add-Undo "Restore $Target from $($report.backup)"
            } elseif (-not $report.existed) {
                Add-Undo "Delete $Target (created by this script)"
            }
        }
    } else {
        Write-Ok "$Target already has the $Label"
    }
    foreach ($warning in $report.warnings) { Write-Warn "${Target}: $warning" }
}

function Write-TempJsonFile([string]$Json) {
    $path = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "ahk-mcp-setup-$([guid]::NewGuid().ToString('N')).json")
    [System.IO.File]::WriteAllText($path, $Json, $Utf8NoBom)
    return $path
}

# =============================================================================================
# Main
# =============================================================================================
$originalOutputEncoding = $null
$tempFiles = New-Object System.Collections.Generic.List[string]
$exitCode = 0
try {
    try {
        $originalOutputEncoding = [Console]::OutputEncoding
        [Console]::OutputEncoding = $Utf8NoBom  # decode claude/npm output as UTF-8
    } catch {
        $originalOutputEncoding = $null
    }

    if (-not $RepoPath) { $RepoPath = Split-Path -Parent $PSScriptRoot }
    $RepoPath = Get-FullPath $RepoPath
    if (-not (Test-Path -LiteralPath ([System.IO.Path]::Combine($RepoPath, 'package.json')) -PathType Leaf)) {
        throw "$RepoPath does not look like the ahk-mcp repo (no package.json). Pass -RepoPath."
    }
    $Entry = [System.IO.Path]::Combine($RepoPath, 'dist', 'index.js')
    $script:MergeHelper = [System.IO.Path]::Combine($RepoPath, 'scripts', 'merge-claude-settings.mjs')
    $SettingsTemplate = [System.IO.Path]::Combine($RepoPath, '.claude', 'settings.example.json')
    $HookScript = [System.IO.Path]::Combine($RepoPath, '.claude', 'hooks', 'validate-ahk.ps1')
    $UserClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }

    $toolsetList = @($Toolsets | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLowerInvariant() } |
            Where-Object { $_ } | Select-Object -Unique)
    if ($toolsetList.Count -eq 0) { $toolsetList = @('core') }
    $unknown = @($toolsetList | Where-Object { $ValidToolsets -notcontains $_ })
    if ($unknown.Count -gt 0) {
        throw "Unknown toolset(s): $($unknown -join ', '). Valid: $($ValidToolsets -join ', ')."
    }
    if ($toolsetList -contains 'all') { $toolsetList = @('all') }
    $ToolsetCsv = $toolsetList -join ','

    Write-Host "ahk-mcp -> Claude Code setup" -ForegroundColor Cyan
    Write-Note "repo:     $RepoPath"
    Write-Note "scope:    $Scope"
    Write-Note "toolsets: $ToolsetCsv"
    if ($script:PreviewOnly) { Write-Note 'preview only: nothing will be changed' }

    # -----------------------------------------------------------------------------------------
    Write-Section '1. Preflight'
    $problems = New-Object System.Collections.Generic.List[string]

    $script:NodeExe = Resolve-NodeExecutable $NodePath
    if (-not $script:NodeExe) {
        $problems.Add('node not found. Install Node.js 20 LTS or newer (winget install OpenJS.NodeJS.LTS), then open a new terminal.')
    } else {
        $nodeVersionText = (Invoke-Native -FilePath $script:NodeExe -ArgumentList @('-p', 'process.versions.node')).Output
        $nodeVersion = $null
        if (-not [version]::TryParse(($nodeVersionText -split "`n")[-1].Trim(), [ref]$nodeVersion)) {
            $problems.Add("could not read the version of $($script:NodeExe)")
        } elseif ($nodeVersion -lt $MinNodeVersion) {
            $problems.Add("node $nodeVersion is too old (need >= $MinNodeVersion). Install Node.js 20 LTS or newer (winget install OpenJS.NodeJS.LTS, or nvm install lts).")
        } else {
            Write-Ok "node $nodeVersion ($($script:NodeExe))"
            if ($script:NodeExe -match 'fnm_multishells') {
                Write-Warn ("node resolves to an fnm per-shell path that disappears when this terminal closes; " +
                    're-run with -NodePath pointing at the installed node.exe.')
            }
        }
    }

    $NpmCli = if (Test-IsWindowsHost) { Resolve-CommandPath @('npm.cmd', 'npm') } else { Resolve-CommandPath @('npm') }
    if (-not $NpmCli) {
        $problems.Add('npm not found. It ships with Node.js; reinstall Node.js or add its folder to PATH.')
    } else {
        Write-Ok "npm $((Invoke-Native -FilePath $NpmCli -ArgumentList @('--version')).Output)"
    }

    $script:ClaudeCli = if (Test-IsWindowsHost) { Resolve-CommandPath @('claude.exe', 'claude.cmd', 'claude') } else { Resolve-CommandPath @('claude') }
    if (-not $script:ClaudeCli) {
        $problems.Add('claude CLI not found. Install Claude Code (irm https://claude.ai/install.ps1 | iex), make sure its bin folder (usually %USERPROFILE%\.local\bin) is on PATH, then open a new terminal.')
    } else {
        $claudeVersion = (Invoke-Claude @('--version')).Output
        Write-Ok "claude $claudeVersion ($($script:ClaudeCli))"
    }

    if (Test-IsWindowsHost) {
        $enforced = @(Get-ExecutionPolicy -List | Where-Object {
                ($_.Scope -eq 'MachinePolicy' -or $_.Scope -eq 'UserPolicy') -and "$($_.ExecutionPolicy)" -ne 'Undefined'
            })
        foreach ($policy in $enforced) {
            if ("$($policy.ExecutionPolicy)" -notin @('Bypass', 'Unrestricted', 'RemoteSigned')) {
                Write-Warn ("Group Policy sets ExecutionPolicy=$($policy.ExecutionPolicy) ($($policy.Scope)); " +
                    '-ExecutionPolicy Bypass cannot override it, so the validate-ahk hook will not run.')
            }
        }
    }

    if ($problems.Count -gt 0) {
        foreach ($problem in $problems) { Write-Host "  [fail] $problem" -ForegroundColor Red }
        throw 'Preflight failed; fix the items above and re-run.'
    }

    # -----------------------------------------------------------------------------------------
    Write-Section '2. Dependencies and build'
    $nodeModules = [System.IO.Path]::Combine($RepoPath, 'node_modules')
    $lockFile = [System.IO.Path]::Combine($RepoPath, 'package-lock.json')
    $installedLock = [System.IO.Path]::Combine($nodeModules, '.package-lock.json')
    $needsInstall = -not (Test-Path -LiteralPath $installedLock -PathType Leaf)
    if (-not $needsInstall -and (Test-Path -LiteralPath $lockFile)) {
        $needsInstall = (Get-Item -Force -LiteralPath $lockFile).LastWriteTimeUtc -gt (Get-Item -Force -LiteralPath $installedLock).LastWriteTimeUtc
    }
    $needsBuild = -not (Test-Path -LiteralPath $Entry -PathType Leaf)
    if (-not $needsBuild) {
        $inputs = @('src', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json') |
            ForEach-Object { [System.IO.Path]::Combine($RepoPath, $_) }
        $needsBuild = (Get-NewestWriteTimeUtc $inputs) -gt (Get-Item -Force -LiteralPath $Entry).LastWriteTimeUtc
    }

    if ($SkipBuild) {
        Write-Note '-SkipBuild: not running npm ci / npm run build'
        if (-not (Test-Path -LiteralPath $Entry -PathType Leaf)) { throw "$Entry is missing; run without -SkipBuild." }
    } else {
        if ($needsInstall) {
            $running = @(Get-RunningServerProcess $Entry)
            if ($running.Count -gt 0) {
                Write-Warn ("$($running.Count) ahk-mcp server process(es) are running (open Claude Code sessions); " +
                    'npm ci can fail with EBUSY/EPERM until they exit.')
            }
            if (Test-ShouldApply $RepoPath 'npm ci') {
                Push-Location -LiteralPath $RepoPath
                try { Invoke-NativeStreaming -FilePath $NpmCli -ArgumentList @('ci', '--no-audit', '--no-fund') -Description 'npm ci' } finally { Pop-Location }
                Add-Change 'Ran npm ci'
            }
        } else {
            Write-Ok 'node_modules is up to date with package-lock.json'
        }
        if ($needsBuild -or $needsInstall) {
            if (Test-ShouldApply $RepoPath 'npm run build') {
                Push-Location -LiteralPath $RepoPath
                try { Invoke-NativeStreaming -FilePath $NpmCli -ArgumentList @('run', 'build') -Description 'npm run build' } finally { Pop-Location }
                Add-Change 'Built dist\index.js'
            }
        } else {
            Write-Ok 'dist\index.js is newer than src\'
        }
    }

    # -----------------------------------------------------------------------------------------
    Write-Section '3. AutoHotkey and THQBY language server'
    $AhkExe = Resolve-AhkExecutable $AhkPath
    if ($AhkExe) {
        Write-Ok "AutoHotkey v2: $AhkExe"
    } else {
        Write-Warn ('AutoHotkey v2 not found; AHK_Run / AHK_Check / the validate hook need it. ' +
            'Install it (winget install AutoHotkey.AutoHotkey) or pass -AhkPath, then re-run.')
    }
    $ThqbyServer = Resolve-ThqbyLspServer $ThqbyLspPath
    if ($ThqbyServer) {
        Write-Ok "THQBY LSP: $ThqbyServer"
    } else {
        Write-Warn ('THQBY AutoHotkey v2 language server not found; AHK_Navigate needs it. Install the VS Code ' +
            'extension "AutoHotkey v2 Language Support" (thqby.vscode-autohotkey2-lsp) or pass -ThqbyLspPath, then re-run.')
    }

    $ServerEnv = [ordered]@{
        NODE_ENV          = 'production'
        AHK_MCP_LOG_LEVEL = $LogLevel
        AHK_MCP_TOOLSETS  = $ToolsetCsv
    }
    if ($AhkExe) { $ServerEnv['AHK_PATH'] = $AhkExe }
    if ($ThqbyServer) { $ServerEnv['AHK_THQBY_LSP_SERVER'] = $ThqbyServer }
    if ($ScriptDir) {
        if (-not (Test-Path -LiteralPath $ScriptDir -PathType Container)) { throw "-ScriptDir not found: $ScriptDir" }
        $ServerEnv['AHK_MCP_SCRIPT_DIR'] = Get-FullPath $ScriptDir
    }
    if ($AllowedDirs) {
        $dirs = @($AllowedDirs | ForEach-Object { $_ -split ';' } | Where-Object { $_.Trim() } | ForEach-Object { Get-FullPath $_.Trim() })
        if ($dirs.Count -gt 0) { $ServerEnv['AHK_MCP_ALLOWED_DIRS'] = $dirs -join ';' }
    }

    # -----------------------------------------------------------------------------------------
    Write-Section '4. Stdio smoke test'
    $Smoke = $null
    if ($SkipSmokeTest) {
        Write-Note '-SkipSmokeTest: skipped'
    } elseif (-not (Test-Path -LiteralPath $Entry -PathType Leaf)) {
        Write-Note "skipped: $Entry does not exist yet (preview)"
    } elseif ($script:PreviewOnly) {
        Write-Note "skipped in preview: would start $($script:NodeExe) $Entry, send initialize + tools/list, and fail after $SmokeTimeoutSec s"
    } else {
        $Smoke = Invoke-StdioSmokeTest -Node $script:NodeExe -Entry $Entry -Environment $ServerEnv -TimeoutSec $SmokeTimeoutSec
        Write-Ok "$($Smoke.ServerInfo) answered initialize + tools/list in $($Smoke.ElapsedMs) ms"
        Write-Ok "$($Smoke.ToolNames.Count) tool(s): $($Smoke.ToolNames -join ', ')"
        if ($Smoke.ToolNames -notcontains 'AHK_Check') {
            Write-Note ("this build does not advertise AHK_Check yet, so AHK_MCP_TOOLSETS has no effect until the " +
                'consolidated tool surface is built; the variable is registered anyway.')
        }
    }

    # -----------------------------------------------------------------------------------------
    Write-Section "5. Register '$ServerName' with Claude Code ($Scope scope)"
    Push-Location -LiteralPath $RepoPath  # local and project scopes are keyed to this folder
    try {
        $repoLeaf = Split-Path -Leaf $RepoPath
        foreach ($legacy in $LegacyServerNames) {
            $details = Get-McpRegistration $legacy
            if (-not $details) { continue }
            $info = ConvertFrom-McpGetOutput $details
            $target = "$($info.Command) $($info.Args)".Replace('\', '/').ToLowerInvariant()
            $ours = $target.Contains($RepoPath.Replace('\', '/').ToLowerInvariant()) -or $target.Contains('ahk-mcp') -or
                $target.Contains("/$($repoLeaf.ToLowerInvariant())/dist/")
            if ($ours) {
                if (Remove-McpRegistration $legacy 'old name for this server') {
                    Add-Undo "Re-add the old '$legacy' registration if you still need it (it pointed at $($info.Args))"
                }
            } else {
                Write-Warn "found an MCP server named '$legacy' that does not point at ahk-mcp ($($info.Command) $($info.Args)); left it alone"
            }
        }

        $serverArgs = @($Entry)
        $json = ConvertTo-McpServerJson -Command $script:NodeExe -ArgumentList $serverArgs -Environment $ServerEnv
        Write-Note "command: $($script:NodeExe) $Entry"
        foreach ($key in $ServerEnv.Keys) { Write-Note "env:     $key=$($ServerEnv[$key])" }

        $previous = Get-McpRegistration $ServerName
        $register = $true
        if ($previous) {
            if (Test-RegistrationCurrent -Details $previous -ExpectedScope $Scope -Command $script:NodeExe -Arguments ($serverArgs -join ' ') -Environment $ServerEnv) {
                Write-Ok "'$ServerName' is already registered with these settings ($Scope scope)"
                $register = $false
            } else {
                Write-Note "existing '$ServerName' registration (replaced below):"
                foreach ($line in ($previous -split "`n")) { if ($line.Trim()) { Write-Note "  $($line.TrimEnd())" } }
                $null = Remove-McpRegistration $ServerName 're-registering'
            }
        }

        if ($register -and (Test-ShouldApply "$ServerName ($Scope scope)" 'claude mcp add-json')) {
            $jsonArg = if (Test-LegacyNativeArgumentPassing $script:ClaudeCli) { ConvertTo-LegacyNativeArgument $json } else { $json }
            $added = Invoke-Claude @('mcp', 'add-json', $ServerName, $jsonArg, '-s', $Scope)
            if ($added.ExitCode -ne 0) {
                Write-Warn "claude mcp add-json failed ($($added.Output)); retrying with claude mcp add"
                $plain = @('mcp', 'add', $ServerName, '-s', $Scope)
                foreach ($key in $ServerEnv.Keys) { $plain += @('-e', "$key=$($ServerEnv[$key])") }
                $plain += @('--', $script:NodeExe) + $serverArgs
                $added = Invoke-Claude $plain
                if ($added.ExitCode -ne 0) { throw "Could not register '$ServerName': $($added.Output)" }
            }
            Write-Ok "registered '$ServerName'"
            Add-Change "Registered MCP server '$ServerName' ($Scope scope) -> $($script:NodeExe) $Entry"
            Add-Undo "claude mcp remove $ServerName -s $Scope"
        }
    } finally {
        Pop-Location
    }

    # -----------------------------------------------------------------------------------------
    Write-Section '6. Claude Code settings'
    if (-not (Test-Path -LiteralPath $SettingsTemplate -PathType Leaf)) { throw "Missing $SettingsTemplate" }
    if (-not (Test-Path -LiteralPath $script:MergeHelper -PathType Leaf)) { throw "Missing $($script:MergeHelper)" }
    if (-not (Test-Path -LiteralPath $HookScript -PathType Leaf)) { throw "Missing $HookScript" }

    # Project settings: portable content only (no machine paths); gitignored in this repo.
    $projectSettings = [System.IO.Path]::Combine($RepoPath, '.claude', 'settings.json')
    Invoke-SettingsMerge -Target $projectSettings -PatchFile $SettingsTemplate -Label 'project permissions, MCP timeouts and validate-ahk hook'

    # Patches below are built as JSON text (not ConvertTo-Json) so 5.1 and 7 produce the same.
    # Local settings: machine-specific values.
    $localParts = @()
    if ($AhkPath) {
        # Lets the hook (and the Bash/PowerShell tools) find a non-standard AutoHotkey install.
        $localParts += '"env":{"AHK_PATH":' + (ConvertTo-SafeJsonString $AhkExe) + '}'
    }
    if ($Scope -eq 'project') {
        # Pre-approves the .mcp.json entry so Claude Code does not ask on first start.
        $localParts += '"enabledMcpjsonServers":[' + (ConvertTo-SafeJsonString $ServerName) + ']'
    }
    if ($localParts.Count -gt 0) {
        $patchFile = Write-TempJsonFile ('{' + ($localParts -join ',') + '}')
        $tempFiles.Add($patchFile)
        $localSettings = [System.IO.Path]::Combine($RepoPath, '.claude', 'settings.local.json')
        Invoke-SettingsMerge -Target $localSettings -PatchFile $patchFile -Label 'machine-specific settings' -ExtraArguments @('--overwrite-env')
    }

    # User settings: MCP timeouts follow the server to every project when it is registered
    # at user scope; -UserHook also validates .ahk edits everywhere.
    $userParts = @()
    $userLabels = @()
    $template = Get-Content -LiteralPath $SettingsTemplate -Raw | ConvertFrom-Json
    if ($Scope -eq 'user') {
        $envPairs = @($template.env.PSObject.Properties | ForEach-Object {
                (ConvertTo-SafeJsonString $_.Name) + ':' + (ConvertTo-SafeJsonString ([string]$_.Value))
            })
        $userParts += '"env":{' + ($envPairs -join ',') + '}'
        $userLabels += 'MCP timeouts'
    }
    if ($UserHook) {
        $group = @($template.hooks.PostToolUse)[0]
        $hook = @($group.hooks)[0]
        $command = $hook.command.Replace('${CLAUDE_PROJECT_DIR}/.claude/hooks/validate-ahk.ps1', $HookScript.Replace('\', '/'))
        $userParts += '"hooks":{"PostToolUse":[{"matcher":' + (ConvertTo-SafeJsonString $group.matcher) +
            ',"hooks":[{"type":"command","command":' + (ConvertTo-SafeJsonString $command) +
            ',"timeout":' + [int]$hook.timeout + '}]}]}'
        $userLabels += 'validate-ahk hook'
    }
    if ($userParts.Count -gt 0) {
        $patchFile = Write-TempJsonFile ('{' + ($userParts -join ',') + '}')
        $tempFiles.Add($patchFile)
        $userSettings = [System.IO.Path]::Combine($UserClaudeDir, 'settings.json')
        Invoke-SettingsMerge -Target $userSettings -PatchFile $patchFile -Label "user settings ($($userLabels -join ', '))"
    }

    # -----------------------------------------------------------------------------------------
    Write-Section '7. claude-code-templates components'
    if (-not $InstallTemplates) {
        Write-Note "not requested (-InstallTemplates adds: $(@($TemplateComponents | ForEach-Object { $_.Name }) -join ', '))"
    } else {
        $NpxCli = if (Test-IsWindowsHost) { Resolve-CommandPath @('npx.cmd', 'npx') } else { Resolve-CommandPath @('npx') }
        if (-not $NpxCli) { throw 'npx not found (it ships with npm).' }
        foreach ($component in $TemplateComponents) {
            $target = [System.IO.Path]::Combine($RepoPath, $component.File)
            if (Test-Path -LiteralPath $target) {
                Write-Ok "$($component.Name) already installed ($($component.File))"
                continue
            }
            if (-not (Test-ShouldApply $RepoPath "npx claude-code-templates@latest $($component.Flag) $($component.Name) --yes")) { continue }
            $previousTracking = $env:CCT_NO_TRACKING
            $env:CCT_NO_TRACKING = 'true'  # the catalog CLI reports installs unless told not to
            Push-Location -LiteralPath $RepoPath
            try {
                Invoke-NativeStreaming -FilePath $NpxCli -ArgumentList @('--yes', 'claude-code-templates@latest', $component.Flag, $component.Name, '--yes') -Description "install $($component.Name)"
            } finally {
                Pop-Location
                $env:CCT_NO_TRACKING = $previousTracking
            }
            if (Test-Path -LiteralPath $target) {
                Add-Change "Installed $($component.Name) -> $($component.File)"
                Add-Undo "Delete $target"
            } else {
                Write-Warn "$($component.Name): installer finished but $($component.File) is missing"
            }
        }
    }

    # -----------------------------------------------------------------------------------------
    Write-Section '8. Verify'
    $connected = $false
    if ($script:PreviewOnly) {
        Write-Note "skipped in preview: would run 'claude mcp list' and 'claude mcp get $ServerName'"
    } else {
        Push-Location -LiteralPath $RepoPath
        try {
            $list = Invoke-Claude @('mcp', 'list')
            $line = @($list.Output -split "`n" | Where-Object { $_ -match "^\s*$([regex]::Escape($ServerName)):\s" }) | Select-Object -First 1
            if ($line) { Write-Note "claude mcp list: $($line.Trim())" } else { Write-Warn "'$ServerName' is missing from 'claude mcp list'" }

            $details = Invoke-Claude @('mcp', 'get', $ServerName)
            foreach ($detail in ($details.Output -split "`n")) { if ($detail.Trim()) { Write-Note "  $($detail.TrimEnd())" } }
            $status = @($details.Output -split "`n" | Where-Object { $_ -match '^\s*Status:' }) | Select-Object -First 1
            $connected = [bool]($status -and $status -match '\bConnected\b' -and $status -notmatch 'Fail')
            $commandLine = @($details.Output -split "`n" | Where-Object { $_ -match '^\s*Command:\s*(.+)$' }) | Select-Object -First 1
            if ($commandLine -and ($commandLine -replace '^\s*Command:\s*', '').Trim() -ne $script:NodeExe) {
                Write-Warn "registered command is '$(($commandLine -replace '^\s*Command:\s*', '').Trim())', expected '$($script:NodeExe)'"
            }
            if ($connected) {
                Write-Ok "'$ServerName' is connected"
            } elseif ("$line $status" -match 'Pending approval') {
                Write-Warn ("'$ServerName' is pending approval: Claude Code reads .claude\settings.local.json (which pre-approves it) " +
                    "only for a trusted folder. Run 'claude' in $RepoPath once, accept the trust prompt, then check /mcp.")
            } else {
                Write-Warn ("'$ServerName' is not reported as connected. See docs\CLAUDE_CODE_WINDOWS.md (Troubleshooting); " +
                    "'claude --debug' shows the server's stderr.")
            }
        } finally {
            Pop-Location
        }
    }

    # -----------------------------------------------------------------------------------------
    Write-Section 'Summary'
    if ($script:PreviewOnly) {
        Write-Note 'preview only: no changes were made. Re-run without -WhatIf/-DryRun to apply.'
    } elseif ($script:Changes.Count -eq 0) {
        Write-Ok 'nothing to change; already set up'
    } else {
        foreach ($change in $script:Changes) { Write-Ok $change }
    }
    if ($Smoke) { Write-Note "smoke test: $($Smoke.ToolNames.Count) tools in $($Smoke.ElapsedMs) ms" }
    if (-not $script:PreviewOnly) {
        if ($connected) { Write-Note "claude: '$ServerName' connected" } else { Write-Note "claude: '$ServerName' NOT confirmed connected" }
    }
    if ($script:Warnings.Count -gt 0) {
        Write-Host ''
        Write-Host '  Warnings:' -ForegroundColor Yellow
        foreach ($warning in $script:Warnings) { Write-Host "   - $warning" -ForegroundColor Yellow }
    }
    if ($script:Undo.Count -gt 0) {
        Write-Host ''
        Write-Host '  To undo:'
        foreach ($step in $script:Undo) { Write-Host "   - $step" }
    }
    Write-Host ''
    Write-Note 'Restart Claude Code (or run /mcp in an open session) to pick up the server and settings.'
    Write-Note "More tool groups: re-run with -Toolsets core,uia (valid: $($ValidToolsets -join ', '))."
} catch {
    Write-Host ''
    Write-Host "[fail] $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
} finally {
    foreach ($file in $tempFiles) { try { [System.IO.File]::Delete($file) } catch { Write-Verbose "temp file: $_" } }
    if ($null -ne $originalOutputEncoding) { try { [Console]::OutputEncoding = $originalOutputEncoding } catch { Write-Verbose "console encoding: $_" } }
}
exit $exitCode
