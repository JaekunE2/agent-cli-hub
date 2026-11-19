# Agent CLI Hub System Tray Monitor (no console window)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Single-instance guard
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\AgentCliHubTrayMonitor', [ref]$created)
if (-not $created) { exit 0 }

$BaseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$UrlFile = Join-Path $BaseDir 'hub\url.txt'
$StopBat = Join-Path $BaseDir 'stop.bat'
$LaunchVbs = Join-Path $BaseDir 'launch.vbs'

function Test-Port($port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    $ok = $ar.AsyncWaitHandle.WaitOne(250, $false)
    if ($ok -and $c.Connected) { $c.EndConnect($ar); $c.Close(); return $true }
    $c.Close()
  } catch {}
  return $false
}

function New-StatusIcon($dotColor) {
  $bmp = New-Object System.Drawing.Bitmap(32, 32)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # Agent CLI Hub dark rounded background (#1f1f23)
  $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(31, 31, 35))
  $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 7
  $bgPath.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
  $bgPath.AddArc(31 - $r * 2, 0, $r * 2, $r * 2, 270, 90)
  $bgPath.AddArc(31 - $r * 2, 31 - $r * 2, $r * 2, $r * 2, 0, 90)
  $bgPath.AddArc(0, 31 - $r * 2, $r * 2, $r * 2, 90, 90)
  $bgPath.CloseFigure()
  $g.FillPath($bgBrush, $bgPath)

  # 4-tile hub logo matching hub/public/icon.svg
  $b1 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(224, 130, 95))  # #e0825f
  $b2 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(92, 192, 124))  # #5cc07c
  $b3 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(224, 176, 80))  # #e0b050
  $b4 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(154, 152, 144)) # #9a9890
  $g.FillRectangle($b1, 4, 6, 10, 8)
  $g.FillRectangle($b2, 18, 6, 10, 8)
  $g.FillRectangle($b3, 4, 18, 10, 8)
  $g.FillRectangle($b4, 18, 18, 10, 8)

  # Status indicator dot in bottom-right corner
  $ring = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(31, 31, 35))
  $dot  = New-Object System.Drawing.SolidBrush($dotColor)
  $g.FillEllipse($ring, 19, 19, 12, 12)
  $g.FillEllipse($dot, 21, 21, 8, 8)

  $g.Dispose(); $bgPath.Dispose(); $bgBrush.Dispose()
  $b1.Dispose(); $b2.Dispose(); $b3.Dispose(); $b4.Dispose()
  $ring.Dispose(); $dot.Dispose()
  $hIcon = $bmp.GetHicon()
  return [System.Drawing.Icon]::FromHandle($hIcon)
}

$IconGreen = New-StatusIcon([System.Drawing.Color]::FromArgb(74, 222, 128))
$IconAmber = New-StatusIcon([System.Drawing.Color]::FromArgb(251, 191, 36))
$IconRed   = New-StatusIcon([System.Drawing.Color]::FromArgb(248, 113, 113))

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $IconRed
$notify.Text = 'Agent CLI Hub: 확인 중...'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miHubStatus = New-Object System.Windows.Forms.ToolStripMenuItem('허브 (7777): 확인 중')
$miHubStatus.Enabled = $false
$miUsageStatus = New-Object System.Windows.Forms.ToolStripMenuItem('사용량 (4777): 확인 중')
$miUsageStatus.Enabled = $false
$sep1 = New-Object System.Windows.Forms.ToolStripSeparator
$miOpenHub = New-Object System.Windows.Forms.ToolStripMenuItem('허브 열기 (7777)')
$miOpenUsage = New-Object System.Windows.Forms.ToolStripMenuItem('사용량 대시보드 열기 (4777)')
$sep2 = New-Object System.Windows.Forms.ToolStripSeparator
$miStart = New-Object System.Windows.Forms.ToolStripMenuItem('서버 시작 / 재시작')
$miStop = New-Object System.Windows.Forms.ToolStripMenuItem('서버 중지')
$sep3 = New-Object System.Windows.Forms.ToolStripSeparator
$miExit = New-Object System.Windows.Forms.ToolStripMenuItem('트레이 아이콘 닫기')

$menu.Items.AddRange(@($miHubStatus, $miUsageStatus, $sep1, $miOpenHub, $miOpenUsage, $sep2, $miStart, $miStop, $sep3, $miExit))
$notify.ContextMenuStrip = $menu

function Open-Hub {
  $u = 'http://127.0.0.1:7777'
  if (Test-Path $UrlFile) {
    $raw = (Get-Content $UrlFile -Raw).Trim()
    if ($raw) { $u = $raw }
  }
  Start-Process $u
}

$notify.add_DoubleClick({ Open-Hub })
$miOpenHub.add_Click({ Open-Hub })
$miOpenUsage.add_Click({ Start-Process 'http://127.0.0.1:4777' })

$miStart.add_Click({
  if (Test-Path $StopBat) { Start-Process 'cmd.exe' -ArgumentList "/c `"$StopBat`"" -WindowStyle Hidden -Wait }
  if (Test-Path $LaunchVbs) { Start-Process 'wscript.exe' -ArgumentList "`"$LaunchVbs`"" -WindowStyle Hidden }
})

$miStop.add_Click({
  if (Test-Path $StopBat) { Start-Process 'cmd.exe' -ArgumentList "/c `"$StopBat`"" -WindowStyle Hidden -Wait }
  Update-Status
})

$miExit.add_Click({
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

function Update-Status {
  $hubUp = Test-Port 7777
  $usageUp = Test-Port 4777
  $miHubStatus.Text   = if ($hubUp)   { '● 허브 (7777): 실행 중' } else { '○ 허브 (7777): 중지됨' }
  $miUsageStatus.Text = if ($usageUp) { '● 사용량 (4777): 실행 중' } else { '○ 사용량 (4777): 중지됨' }
  if ($hubUp -and $usageUp) {
    $notify.Icon = $IconGreen
    $notify.Text = 'Agent CLI Hub: 실행 중 (7777 · 4777)'
  } elseif ($hubUp -or $usageUp) {
    $notify.Icon = $IconAmber
    $notify.Text = "Agent CLI Hub: 일부 실행 (7777:$(if($hubUp){'ON'}else{'OFF'}) 4777:$(if($usageUp){'ON'}else{'OFF'}))"
  } else {
    $notify.Icon = $IconRed
    $notify.Text = 'Agent CLI Hub: 중지됨'
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({ Update-Status })
$timer.Start()
Update-Status

[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
