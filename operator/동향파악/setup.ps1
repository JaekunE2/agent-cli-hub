$ErrorActionPreference = 'Stop'
$appPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $appPython -PathType Leaf)) {
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        & $launcher.Source -3.12 -m venv (Join-Path $PSScriptRoot '.venv')
    } else {
        $python = Get-Command python.exe -ErrorAction SilentlyContinue
        if (-not $python) { throw 'Python 3.12 is required. Install it and run setup again.' }
        & $python.Source -m venv (Join-Path $PSScriptRoot '.venv')
    }
    if ($LASTEXITCODE -ne 0) { throw 'Could not create .venv. Check the Python 3.12 installation.' }
}
& $appPython -c "import importlib.util; raise SystemExit(importlib.util.find_spec('pip') is None)"
if ($LASTEXITCODE -ne 0) {
    & $appPython -m ensurepip --upgrade
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize pip in .venv.' }
}
& $appPython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'App dependency installation failed.' }
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    Write-Warning 'Korean summaries require a signed-in Codex CLI on PATH.'
}
