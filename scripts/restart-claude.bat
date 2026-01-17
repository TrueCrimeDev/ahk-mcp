@echo off
echo Stopping Claude Desktop...
taskkill /IM "Claude.exe" /F >nul 2>&1
timeout /t 2 /nointerval >nul
echo Starting Claude Desktop...
start "" "%LOCALAPPDATA%\AnthropicClaude\claude.exe"
echo Done.
a
