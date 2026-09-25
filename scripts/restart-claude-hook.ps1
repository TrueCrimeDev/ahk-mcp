#!/usr/bin/env pwsh
# PowerShell hook to restart Claude.exe after server rebuild
# Usage: ./scripts/restart-claude-hook.ps1 [-Watch] [-Once]

param(
    [switch]$Watch,  # Continuously monitor for changes
    [switch]$Once,   # Run once immediately
    [string]$DistPath = "dist",
    [int]$Delay = 2  # Seconds to wait before restart
)

$ErrorActionPreference = "Continue"

function Write-Status($message, $type = "Info") {
    $timestamp = Get-Date -Format "HH:mm:ss"
    $color = switch ($type) {
        "Success" { "Green" }
        "Warning" { "Yellow" }
        "Error" { "Red" }
        default { "Cyan" }
    }
    Write-Host "[$timestamp] " -NoNewline -ForegroundColor DarkGray
    Write-Host $message -ForegroundColor $color
}

function Get-ClaudeProcess {
    return Get-Process -Name "Claude" -ErrorAction SilentlyContinue
}

function Stop-Claude {
    $claude = Get-ClaudeProcess
    if ($claude) {
        Write-Status "Stopping Claude.exe (PID: $($claude.Id))..." "Warning"
        try {
            $claude | Stop-Process -Force -ErrorAction Stop
            Start-Sleep -Seconds 1
            Write-Status "Claude.exe stopped successfully" "Success"
            return $true
        }
        catch {
            Write-Status "Failed to stop Claude.exe: $_" "Error"
            return $false
        }
    }
    else {
        Write-Status "Claude.exe is not running" "Info"
        return $true
    }
}

function Start-Claude {
    # Common Claude installation paths
    $claudePaths = @(
        "$env:LOCALAPPDATA\AnthropicClaude\claude.exe",
        "$env:LOCALAPPDATA\Programs\claude\Claude.exe",
        "$env:ProgramFiles\Claude\Claude.exe",
        "$env:ProgramFiles(x86)\Claude\Claude.exe",
        "$env:APPDATA\Claude\Claude.exe"
    )

    # Find Claude.exe
    $claudeExe = $null
    foreach ($path in $claudePaths) {
        if (Test-Path $path) {
            $claudeExe = $path
            break
        }
    }

    # If not found in common paths, try to find it via registry or running process
    if (-not $claudeExe) {
        $runningClaude = Get-Process -Name "Claude" -ErrorAction SilentlyContinue
        if ($runningClaude) {
            $claudeExe = $runningClaude.Path
        }
    }

    # Last resort: search in PATH
    if (-not $claudeExe) {
        $claudeInPath = Get-Command "Claude.exe" -ErrorAction SilentlyContinue
        if ($claudeInPath) {
            $claudeExe = $claudeInPath.Source
        }
    }

    if ($claudeExe -and (Test-Path $claudeExe)) {
        Write-Status "Starting Claude.exe from: $claudeExe" "Info"
        try {
            Start-Process $claudeExe -ErrorAction Stop
            Write-Status "Claude.exe started successfully" "Success"
            return $true
        }
        catch {
            Write-Status "Failed to start Claude.exe: $_" "Error"
            return $false
        }
    }
    else {
        Write-Status "Could not find Claude.exe. Please start it manually." "Error"
        Write-Status "Searched paths:" "Info"
        $claudePaths | ForEach-Object { Write-Status "  - $_" "Info" }
        return $false
    }
}

function Restart-Claude {
    Write-Status "Initiating Claude restart..." "Info"

    # Add delay to ensure build is complete
    if ($Delay -gt 0) {
        Write-Status "Waiting $Delay seconds for build to complete..." "Info"
        Start-Sleep -Seconds $Delay
    }

    # Stop Claude
    $stopped = Stop-Claude

    if ($stopped) {
        # Wait a moment before starting
        Start-Sleep -Seconds 1

        # Start Claude
        $started = Start-Claude

        if ($started) {
            Write-Status "Claude restart completed successfully!" "Success"
            return $true
        }
    }

    return $false
}

function Watch-ForChanges {
    $lastWrite = if (Test-Path $DistPath) {
        (Get-Item $DistPath).LastWriteTime
    } else {
        [DateTime]::MinValue
    }

    Write-Status "Monitoring '$DistPath' for changes..." "Info"
    Write-Status "Press Ctrl+C to stop monitoring" "Info"

    while ($true) {
        Start-Sleep -Seconds 2

        if (Test-Path $DistPath) {
            $currentWrite = (Get-Item $DistPath).LastWriteTime

            if ($currentWrite -gt $lastWrite) {
                Write-Status "Build detected! (Changed: $currentWrite)" "Warning"
                Restart-Claude
                $lastWrite = $currentWrite
            }
        }
    }
}

# Main execution
Write-Host "`n===== Claude.exe Restart Hook =====" -ForegroundColor Magenta
Write-Status "Hook initialized" "Info"

if ($Once -or (-not $Watch -and -not $Once)) {
    # Run once (default behavior)
    Restart-Claude
}
elseif ($Watch) {
    # Watch mode
    Watch-ForChanges
}

Write-Host "`n===================================`n" -ForegroundColor Magenta