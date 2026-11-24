$ErrorActionPreference = 'Stop'
$expectedId = [uint32]$env:CCD_VERIFY_PID
$port = [uint16]$env:CCD_VERIFY_PORT
$scriptPath = [IO.Path]::GetFullPath($env:CCD_VERIFY_SCRIPT)
$listeners = @(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $port)
if ($listeners.Count -ne 1 -or ($expectedId -ne 0 -and $listeners[0].OwningProcess -ne $expectedId)) {
    throw 'The PID does not own the expected loopback listener.'
}
$processId = [uint32]$listeners[0].OwningProcess
$proc = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
if (!$proc.ExecutablePath -or [IO.Path]::GetFileName($proc.ExecutablePath) -ine 'node.exe' -or !$proc.ParentProcessId) {
    throw 'The listener executable or parent could not be verified.'
}
$node = [regex]::Escape($proc.ExecutablePath)
$script = [regex]::Escape($scriptPath)
if ($proc.CommandLine -notmatch ('^\s*(?:"' + $node + '"|' + $node + '|node(?:\.exe)?)(?: --use-system-ca)? (?:"' + $script + '"|' + $script + ')\s*$')) {
    throw 'The listener command line does not match the selected Hub script.'
}
$parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)"
# A detached process can outlive its parent, and Windows can reuse the parent PID.
if ($parent -and $parent.CreationDate -le $proc.CreationDate) {
    if (!$parent.ExecutablePath -or !$parent.CommandLine -or
        $parent.ExecutablePath -match '(?i)[\\/](?:ChatGPT|Codex|electron|msedgewebview2)\.exe$') {
        throw 'The listener has an unverified or protected parent.'
    }
}
$processId
