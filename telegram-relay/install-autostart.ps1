# Start the Telegram relay at Windows logon (current user only, no admin needed).
$vbs = Join-Path $PSScriptRoot 'start-hidden.vbs'
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ClaudeTelegramRelay' -Value ('wscript.exe "' + $vbs + '"')
"autostart registered: $vbs  (remove with uninstall-autostart.ps1)"
