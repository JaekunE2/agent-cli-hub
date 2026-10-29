@echo off
rem Stop the relay (and a turn it is running).
cd /d "%~dp0"
if not exist "data\relay.pid" ( echo The relay is not running. & exit /b 0 )
set /p PID=<"data\relay.pid"
taskkill /PID %PID% /T /F >nul 2>nul && echo Stopped. || echo The relay is not running.
del "data\relay.pid" >nul 2>nul
