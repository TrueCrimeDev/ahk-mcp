#Requires -Version 5.1
<#
.SYNOPSIS
    Claude Code PostToolUse hook: validate an edited .ahk file with AutoHotkey v2 /Validate.

.DESCRIPTION
    Reads the hook payload (JSON) from stdin, takes the edited file from
    tool_input.file_path (Edit/Write/MultiEdit) or tool_input.filePath (the ahk
    MCP server's AHK_File_Edit / AHK_File_Create), and exits 0 for anything that
    is not an existing .ahk file.

    For .ahk files it runs:
        AutoHotkey64.exe /Validate /ErrorStdOut=utf-8 <file>
    which loads the script, reports load-time errors and exits without running it.

    Exit codes (Claude Code hook contract):
        0  valid, or nothing to check
        1  could not validate (AutoHotkey missing, v1 interpreter, timeout);
           shown to the user, Claude is not blocked
        2  the script has load-time errors; stderr is fed back to Claude

    AutoHotkey is taken from $env:AHK_PATH, then the standard AutoHotkey v2 install
    locations, then PATH. Set AHK_VALIDATE_TIMEOUT_SEC to change the 15 s timeout.

    Wired in .claude/settings.json (see .claude/settings.example.json):
        powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${CLAUDE_PROJECT_DIR}/.claude/hooks/validate-ahk.ps1"
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-HookError {
    param([string]$Text)
    # Write UTF-8 bytes straight to stderr: Console.OutputEncoding is the OEM code
    # page under Windows PowerShell and would mangle non-ASCII paths and messages.
    try {
        $writer = New-Object System.IO.StreamWriter([Console]::OpenStandardError(), $Utf8NoBom)
        $writer.Write($Text)
        if (-not $Text.EndsWith("`n")) { $writer.Write("`n") }
        $writer.Flush()
    } catch {
        [Console]::Error.WriteLine($Text)
    }
}

function Get-JsonProperty {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Test-IsWindowsHost {
    return [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

function Resolve-AhkExecutable {
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
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    $onPath = Get-Command -Name 'AutoHotkey64.exe', 'AutoHotkey.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($onPath) { return $onPath.Source }
    return $null
}

function Get-AhkMajorVersion {
    param([string]$Path)
    try {
        return [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path).FileMajorPart
    } catch {
        return 0
    }
}

# --- read the hook payload ---------------------------------------------------------------
try {
    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $Utf8NoBom)
    $raw = $reader.ReadToEnd()
} catch {
    exit 0
}
if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

try {
    $payload = $raw | ConvertFrom-Json
} catch {
    Write-HookError "validate-ahk: could not parse hook input as JSON: $($_.Exception.Message)"
    exit 1
}

$toolInput = Get-JsonProperty $payload 'tool_input'
$file = $null
foreach ($name in 'file_path', 'filePath') {
    $value = Get-JsonProperty $toolInput $name
    if ($value -is [string] -and $value.Trim()) { $file = $value.Trim(); break }
}
if (-not $file) { exit 0 }
if (-not $file.ToLowerInvariant().EndsWith('.ahk')) { exit 0 }
if ((Get-JsonProperty $toolInput 'dryRun') -eq $true) { exit 0 }

if (-not [System.IO.Path]::IsPathRooted($file)) {
    $cwd = Get-JsonProperty $payload 'cwd'
    if (-not $cwd) { $cwd = $env:CLAUDE_PROJECT_DIR }
    if ($cwd) { $file = [System.IO.Path]::Combine($cwd, $file) }
}
if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { exit 0 }
$file = (Resolve-Path -LiteralPath $file).ProviderPath

# --- find AutoHotkey v2 --------------------------------------------------------------------
$ahk = Resolve-AhkExecutable
if (-not $ahk) {
    if (Test-IsWindowsHost) {
        Write-HookError ("validate-ahk: AutoHotkey v2 not found, so $file was not validated. " +
            'Install it (winget install AutoHotkey.AutoHotkey) or set AHK_PATH to AutoHotkey64.exe.')
        exit 1
    }
    exit 0  # not on Windows and no AHK_PATH: nothing to validate with
}
if ((Get-AhkMajorVersion $ahk) -eq 1) {
    # v1 has no /Validate and would *run* the script instead, so never call it.
    Write-HookError ("validate-ahk: $ahk is AutoHotkey v1; /Validate needs v2. " +
        'Point AHK_PATH at the v2 AutoHotkey64.exe.')
    exit 1
}

# --- validate -------------------------------------------------------------------------------
$timeoutSec = 15
if ($env:AHK_VALIDATE_TIMEOUT_SEC -and ($env:AHK_VALIDATE_TIMEOUT_SEC -as [int]) -gt 0) {
    $timeoutSec = [int]$env:AHK_VALIDATE_TIMEOUT_SEC
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $ahk
# Windows file names cannot contain double quotes, so plain quoting is safe here.
$psi.Arguments = '/Validate /ErrorStdOut=utf-8 "' + $file + '"'
$psi.WorkingDirectory = [System.IO.Path]::GetDirectoryName($file)
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = $Utf8NoBom
$psi.StandardErrorEncoding = $Utf8NoBom

try {
    $proc = [System.Diagnostics.Process]::Start($psi)
} catch {
    Write-HookError "validate-ahk: failed to start ${ahk}: $($_.Exception.Message)"
    exit 1
}
$stdoutTask = $proc.StandardOutput.ReadToEndAsync()
$stderrTask = $proc.StandardError.ReadToEndAsync()

if (-not $proc.WaitForExit($timeoutSec * 1000)) {
    try { $proc.Kill() } catch { Write-Verbose "stopping AutoHotkey: $_" }
    Write-HookError ("validate-ahk: AutoHotkey did not finish validating $file within $timeoutSec s " +
        '(a dialog may have opened). Validate it manually: "' + $ahk + '" /Validate /ErrorStdOut "' + $file + '"')
    exit 1
}
$proc.WaitForExit()  # flush redirected streams
$output = (($stderrTask.Result, $stdoutTask.Result) | Where-Object { $_ -and $_.Trim() }) -join "`n"
$exitCode = $proc.ExitCode

if ($exitCode -eq 0) { exit 0 }

if (-not $output) { $output = '(AutoHotkey reported no message)' }
Write-HookError ("AutoHotkey v2 /Validate failed for $file (exit code $exitCode):`n" + $output.Trim() +
    "`nFix the load-time error above; the file was saved but will not run as-is.")
exit 2
