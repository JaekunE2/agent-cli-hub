# Installs the agent-facing pieces for THIS folder's location (safe to re-run; start.bat runs it every time):
#   - skills  -> %USERPROFILE%\.claude\skills\ (agent-cli-hub + paper-* skills used by the research harness)
#   - a guidance block -> %USERPROFILE%\.claude\CLAUDE.md  (Claude Code)  and  %USERPROFILE%\.codex\AGENTS.md  (Codex)
#     only the text between the agent-cli-hub markers is managed; the rest of those files is left alone.
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$hub = Join-Path $repo 'hub'
$node = Join-Path $repo 'node.exe'
if (-not (Test-Path $node)) { $cmd = Get-Command node -ErrorAction SilentlyContinue; $node = if ($cmd) { $cmd.Source } else { 'node' } }
$enc = New-Object Text.UTF8Encoding $false
function Fill([string]$t) { $t.Replace('{{NODE}}', $node).Replace('{{HUB}}', $hub).Replace('{{REPO}}', $repo) }

# skills (Claude Code reads %USERPROFILE%\.claude\skills)
$claude = Join-Path $env:USERPROFILE '.claude'
Get-ChildItem (Join-Path $repo 'skills') -Directory | ForEach-Object {
  $src = $_.FullName
  $dst = Join-Path $claude ('skills\' + $_.Name)
  New-Item -ItemType Directory -Force $dst | Out-Null
  Get-ChildItem $src -File -Recurse | ForEach-Object {
    $to = Join-Path $dst $_.FullName.Substring($src.Length + 1)
    New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
    [IO.File]::WriteAllText($to, (Fill ([IO.File]::ReadAllText($_.FullName, $enc))), $enc)
  }
}

# guidance block (Claude Code: CLAUDE.md, Codex: AGENTS.md)
$block = Fill ([IO.File]::ReadAllText((Join-Path $repo 'guidance\CLAUDE-block.md'), $enc))
$re = '(?s)<!-- agent-cli-hub:begin.*?<!-- agent-cli-hub:end -->\r?\n?'
foreach ($md in @((Join-Path $claude 'CLAUDE.md'), (Join-Path $env:USERPROFILE '.codex\AGENTS.md'))) {
  $cur = if (Test-Path $md) { [IO.File]::ReadAllText($md, $enc) } else { '' }
  if ($cur -match $re) { $new = [regex]::Replace($cur, $re, [Text.RegularExpressions.MatchEvaluator]{ param($m) $block }) }
  else { $new = $cur.TrimEnd() + $(if ($cur.Trim()) { "`r`n`r`n" } else { '' }) + $block }
  if ($new -ne $cur) { New-Item -ItemType Directory -Force (Split-Path $md) | Out-Null; [IO.File]::WriteAllText($md, $new, $enc) }
}
New-Item -ItemType Directory -Force (Join-Path $repo 'research') | Out-Null
"setup ok: skills -> $claude\skills, guidance -> CLAUDE.md + .codex\AGENTS.md"
