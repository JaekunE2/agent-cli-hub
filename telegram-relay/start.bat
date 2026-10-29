@echo off
rem Start the relay in the background (no window). Log: data\relay.log
cd /d "%~dp0"
wscript.exe "%~dp0start-hidden.vbs"
echo Telegram relay started. Log: %~dp0data\relay.log   Stop: stop.bat
