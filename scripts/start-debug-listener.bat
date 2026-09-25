@echo off
setlocal

rem Change to repo root (this file lives in scripts\)
cd /d "%~dp0.."

rem Configuration (edit as needed)
if "%LISTEN_HOST%"=="" set LISTEN_HOST=127.0.0.1
if "%PORTS%"=="" set PORTS=9002,9003,9004,9005,9006
rem Optional forwarding to a real adapter (uncomment and set if needed)
rem set FORWARD_HOST=127.0.0.1
rem set FORWARD_PORT=9002
if "%MAX_EVENTS%"=="" set MAX_EVENTS=500

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found in PATH. Please install Node 18+ and try again.
  pause
  exit /b 1
)

echo Starting AHK Debug Listener window...
start "AHK Debug Listener" cmd /k "set LISTEN_HOST=%LISTEN_HOST% && set PORTS=%PORTS% && if defined FORWARD_HOST set FORWARD_HOST=%FORWARD_HOST% && if defined FORWARD_PORT set FORWARD_PORT=%FORWARD_PORT% && set MAX_EVENTS=%MAX_EVENTS% && npm run debug:start"

echo Launched. A new window titled ^"AHK Debug Listener^" should be open.
echo Close that window or use stop-debug-listener.bat to stop the listener.
exit /b 0


