@echo off
rem Agent CLI Hub: install the agent skills/guidance, start both servers, open the browser.
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org
  where winget >nul 2>nul && (
    set /p ANS="Install Node.js LTS now with winget? [y/N] "
    if /i "!ANS!"=="y" winget install -e --id OpenJS.NodeJS.LTS && echo Done. Open a new window and run start.bat again.
  )
  pause & exit /b 1
)
if not exist "%~dp0hub\node_modules" (
  echo Installing dependencies ^(first run only^)...
  pushd "%~dp0hub" & call npm install --omit=dev --no-audit --no-fund & popd
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
wscript.exe "%~dp0launch.vbs"
for /f "usebackq delims=" %%u in ("%~dp0hub\url.txt") do start "" "%%u"
