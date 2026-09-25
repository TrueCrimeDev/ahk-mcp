@echo off
:: Batch wrapper for Claude auto-restart hook
:: This script rebuilds the MCP server and automatically restarts Claude.exe

echo.
echo ========================================
echo    Claude Auto-Restart Build Tool
echo ========================================
echo.

:menu
echo Select an option:
echo.
echo 1. Build once and restart Claude
echo 2. Build and watch for changes (auto-restart)
echo 3. Just restart Claude (no build)
echo 4. Exit
echo.
set /p choice="Enter your choice (1-4): "

if "%choice%"=="1" goto build_once
if "%choice%"=="2" goto build_watch
if "%choice%"=="3" goto restart_only
if "%choice%"=="4" goto end

echo Invalid choice. Please try again.
echo.
goto menu

:build_once
echo.
echo Building and restarting Claude...
call npm run build:restart
echo.
echo Complete! Claude should be restarting.
pause
goto end

:build_watch
echo.
echo Starting build watcher with auto-restart...
echo Press Ctrl+C to stop watching.
echo.
call npm run watch:restart
goto end

:restart_only
echo.
echo Restarting Claude...
call npm run claude:restart
echo.
echo Complete! Claude should be restarting.
pause
goto end

:end
echo.
echo Goodbye!
exit /b 0