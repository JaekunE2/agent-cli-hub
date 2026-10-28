Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AgentCliHub' -ErrorAction SilentlyContinue
"autostart removed"
