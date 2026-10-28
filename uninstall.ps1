# Removes what setup.ps1 installed: the skills, the guidance blocks and autostart. The folder itself stays.
$enc = New-Object Text.UTF8Encoding $false
$claude = Join-Path $env:USERPROFILE '.claude'
Get-ChildItem (Join-Path $PSScriptRoot 'skills') -Directory | ForEach-Object { Remove-Item -Recurse -Force (Join-Path $claude ('skills\' + $_.Name)) -ErrorAction SilentlyContinue }
foreach ($md in @((Join-Path $claude 'CLAUDE.md'), (Join-Path $env:USERPROFILE '.codex\AGENTS.md'))) {
  if (Test-Path $md) { $t = [IO.File]::ReadAllText($md, $enc); [IO.File]::WriteAllText($md, [regex]::Replace($t, '(?s)\r?\n?<!-- agent-cli-hub:begin.*?<!-- agent-cli-hub:end -->\r?\n?', ''), $enc) }
}
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AgentCliHub' -ErrorAction SilentlyContinue
"removed skills, guidance and autostart (delete this folder to finish)"
