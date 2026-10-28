@echo off
rem Stops the servers started from THIS folder. Hub terminals (and the agents running in them) close too.
powershell -NoProfile -Command "$b = '%~dp0'; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like ('*' + $b + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo stopped.
