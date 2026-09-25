@echo off
setlocal

rem Attempts to close the listener window by title; falls back to killing node processes running scripts\start-debug.js

rem Close the titled window if it exists
for /f "tokens=2 delims==" %%I in ('wmic process where "name='cmd.exe' and CommandLine like '%%AHK Debug Listener%%'" get ProcessId /value ^| find "ProcessId="') do (
  echo Stopping listener window PID %%I ...
  taskkill /PID %%I /F >nul 2>&1
)

rem Also try to kill node that runs scripts\start-debug.js (safer match)
for /f "tokens=*" %%P in ('wmic process where "name='node.exe' and CommandLine like '%%scripts\\start-debug.js%%'" get ProcessId ^| findstr /r "^[0-9]"') do (
  echo Stopping node PID %%P ...
  taskkill /PID %%P /F >nul 2>&1
)

echo Stop command issued. If the listener persists, close its window manually.
exit /b 0


