@echo off
rem Telegram Relay for Claude Code: link a Telegram bot to this PC (once), then start it.
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required: https://nodejs.org
  where winget >nul 2>nul && (
    set /p ANS="Install Node.js LTS now with winget? [y/N] "
    if /i "!ANS!"=="y" winget install -e --id OpenJS.NodeJS.LTS && echo Done. Open a new window and run setup.bat again.
  )
  pause & exit /b 1
)
where claude >nul 2>nul
if errorlevel 1 if not exist "%USERPROFILE%\.local\bin\claude.exe" (
  echo Claude Code CLI not found. Install it first: https://docs.claude.com/claude-code
  pause & exit /b 1
)
call stop.bat >nul 2>nul
node relay.js setup %*
if errorlevel 1 ( pause & exit /b 1 )
echo.
set /p AUTO="Start the relay automatically at Windows logon? [Y/n] "
if /i not "!AUTO!"=="n" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
call start.bat
pause
