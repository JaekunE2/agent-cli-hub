# Start both servers automatically at Windows logon (current user only, no admin needed).
$vbs = Join-Path $PSScriptRoot 'launch.vbs'
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AgentCliHub' -Value ('wscript.exe "' + $vbs + '"')
"autostart registered: $vbs  (remove with uninstall-autostart.ps1)"
