param(
  [Parameter(Mandatory = $true)][string]$Script
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $py -PathType Leaf)) {
  Write-Host '[setup] .venv가 없어 setup.ps1을 먼저 실행합니다...'
  & (Join-Path $PSScriptRoot 'setup.ps1')
}

& $py (Join-Path $PSScriptRoot $Script)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
