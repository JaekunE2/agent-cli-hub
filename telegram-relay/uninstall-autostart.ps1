# Remove the logon autostart of the Telegram relay.
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ClaudeTelegramRelay' -ErrorAction SilentlyContinue
"autostart removed"
