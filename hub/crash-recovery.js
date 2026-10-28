// Crash recovery: when the dashboard starts after the PC went down uncleanly (blue screen, power loss,
// hard hang: System log Kernel-Power 41) or was restarted by the system itself (Windows Update: User32 1074
// by SYSTEM), find what was cut off and bring it back.
//   - sessions that were mid-turn at the crash (last transcript entry = a user turn or a tool call, no
//     entry since) and are not running again → resumed in a dashboard terminal with a note explaining
//     the crash (the dashboard's own terminals come back via recoverTerms and get the same note)
//   - local GPU queue tickets that the crash ended → listed, so their sessions know to rerun them
//   - C: free space at boot
// A report goes to Telegram (bridge notify/ outbox) and crash-recovery.log. crash-state.json remembers the
// last Kernel-Power event handled, so a normal restart of the dashboard does nothing.
'use strict';
const fs = require('fs'), path = require('path'), { execFile } = require('child_process');

const BUGCHECK = { 0x0A: 'IRQL_NOT_LESS_OR_EQUAL', 0x1A: 'MEMORY_MANAGEMENT', 0x1E: 'KMODE_EXCEPTION_NOT_HANDLED',
  0x3B: 'SYSTEM_SERVICE_EXCEPTION', 0x50: 'PAGE_FAULT_IN_NONPAGED_AREA', 0x7E: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED',
  0xD1: 'DRIVER_IRQL_NOT_LESS_OR_EQUAL', 0xEF: 'CRITICAL_PROCESS_DIED', 0x116: 'VIDEO_TDR_FAILURE',
  0x124: 'WHEA_UNCORRECTABLE_ERROR', 0x133: 'DPC_WATCHDOG_VIOLATION', 0x139: 'KERNEL_SECURITY_CHECK_FAILURE' };
const MAX_RESUME = 12;

module.exports = function crashRecovery({ dir, claudeDir, liveSessions, gpuFile, notify, log = console.log }) {
  const STATE = path.join(dir, 'crash-state.json'), LOG = path.join(dir, 'crash-recovery.log');
  const flog = (s) => { log('[crash] ' + s); try { fs.appendFileSync(LOG, `${new Date().toLocaleString('sv-SE')} ${s}\n`); } catch {} };

  const ps = (cmd) => new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
    { timeout: 60000, windowsHide: true, maxBuffer: 8 * 2 ** 20 }, (e, o) => res(e ? '' : String(o))));

  // newest Kernel-Power 41 (unclean boot) after `since`, with its bugcheck code (0 = power loss / hard hang)
  async function lastUncleanBoot(since) {
    const out = await ps(`$e = Get-WinEvent -FilterHashtable @{LogName='System'; Id=41; ProviderName='Microsoft-Windows-Kernel-Power'; StartTime=[datetime]'${new Date(since).toISOString()}'} -MaxEvents 1 -ErrorAction SilentlyContinue
      if ($e) { $x = [xml]$e.ToXml(); $d = @{}; $x.Event.EventData.Data | % { $d[$_.Name] = $_.'#text' }
        # the crash ≈ the last System event before that boot started (Kernel-General 12)
        $b = Get-WinEvent -FilterHashtable @{LogName='System'; Id=12; ProviderName='Microsoft-Windows-Kernel-General'; EndTime=$e.TimeCreated} -MaxEvents 1 -ErrorAction SilentlyContinue
        $p = if ($b) { Get-WinEvent -FilterHashtable @{LogName='System'; EndTime=$b.TimeCreated.AddSeconds(-1)} -MaxEvents 1 -ErrorAction SilentlyContinue }
        @{ t = $e.TimeCreated.ToUniversalTime().ToString('o'); code = [int64]$d.BugcheckCode; p1 = $d.BugcheckParameter1; power = $d.PowerButtonTimestamp
           down = $(if ($p) { $p.TimeCreated.ToUniversalTime().ToString('o') } else { $null }) } | ConvertTo-Json -Compress }
      $b = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime; Write-Output ('BOOT ' + $b.ToUniversalTime().ToString('o'))
      # a restart the system started on its own (Windows Update: User32 1074 by NT AUTHORITY\\SYSTEM) kills
      # running work just the same, though it is a clean shutdown
      if (-not $e) { $u = Get-WinEvent -FilterHashtable @{LogName='System'; Id=1074; ProviderName='User32'; StartTime=[datetime]'${new Date(since).toISOString()}'} -MaxEvents 5 -ErrorAction SilentlyContinue | ? { $_.TimeCreated -lt $b -and $_.UserId -and $_.UserId.Value -eq 'S-1-5-18' } | Select-Object -First 1
        if ($u) { @{ t = $u.TimeCreated.ToUniversalTime().ToString('o'); code = 0; update = $true; by = [IO.Path]::GetFileName(($u.Properties[0].Value -split ' ')[0]); down = $u.TimeCreated.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress } }`);
    const boot = (out.match(/BOOT (\S+)/) || [])[1];
    const j = out.split(/\r?\n/).find((l) => l.startsWith('{'));
    return { ev: j ? JSON.parse(j) : null, boot: boot ? Date.parse(boot) : null };
  }

  // last transcript activity before `before` and the turn state of every session active in the hours before it
  // Only transcripts last written before the boot can have been cut off (anything written since is running
  // again), so only those few are read — asynchronously, a tail at a time, to keep the server responsive.
  async function scanTranscripts(before, floor = 0) {
    const fsp = fs.promises, root = path.join(claudeDir, 'projects'), cand = [];
    let lastAct = 0;
    for (const d of await fsp.readdir(root)) {
      let files; try { files = (await fsp.readdir(path.join(root, d))).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const p = path.join(root, d, f);
        let st; try { st = await fsp.stat(p); } catch { continue; }
        if (st.mtimeMs > before) continue;
        lastAct = Math.max(lastAct, st.mtimeMs);
        cand.push({ p, f, st });
      }
    }
    const out = [];
    for (const { p, f, st } of cand) {
      if (st.mtimeMs < Math.max(lastAct, floor) - 3 * 3600e3) continue;
      let last = null, cwd = null, entry = null, title = '';
      for (const size of [2 ** 20, 8 * 2 ** 20]) { // tool results can be large: retry with a longer tail
        const len = Math.min(st.size, size), buf = Buffer.alloc(len);
        try { const h = await fsp.open(p, 'r'); await h.read(buf, 0, len, st.size - len); await h.close(); } catch { break; }
        for (const l of buf.toString('utf8').split('\n').slice(len < st.size ? 1 : 0)) {
          let j; try { j = JSON.parse(l); } catch { continue; }
          if (j.type === 'summary' && j.summary) title = j.summary;
          if ((j.type !== 'user' && j.type !== 'assistant') || j.isSidechain) continue;
          last = j; cwd = j.cwd || cwd; entry = j.entrypoint || entry;
          if (j.type === 'user' && typeof j.message?.content === 'string' && !title) title = j.message.content.split('\n')[0];
        }
        if (last || len === st.size) break;
      }
      if (!last) continue;
      const c = last.message?.content;
      const midturn = last.type === 'user' || (Array.isArray(c) && c.some((x) => x.type === 'tool_use'));
      out.push({ id: f.slice(0, -6), t: Date.parse(last.timestamp), midturn, after: 0, cwd, entry, title: String(title).slice(0, 50) });
    }
    return { sessions: out, lastAct };
  }

  // step 1 (event log only, quick): was there an unclean boot we haven't handled? → { kind, note, ... } or null
  async function detect() {
    let state = {}; try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
    const since = state.handledAt ? Date.parse(state.handledAt) + 1000 : Date.now() - 3 * 24 * 3600e3;
    const { ev, boot } = await lastUncleanBoot(since);
    const save = (t) => fs.writeFileSync(STATE, JSON.stringify({ handledAt: new Date(t).toISOString() }, null, 1));
    if (!ev) { if (!state.handledAt) save(Date.now()); return null; }
    save(Date.parse(ev.t));
    if (!state.handledAt) { flog(`first run: marking the unclean boot of ${ev.t} as already handled`); return null; }
    const code = Number(ev.code) || 0;
    const kind = ev.update ? `Windows 자동 재시작(${ev.by || '업데이트'})` : code ? `블루스크린 0x${code.toString(16).toUpperCase()} ${BUGCHECK[code] || ''}`.trim() : '비정상 종료(전원 차단·멈춤·강제 종료)';
    const note = `[PC가 ${kind}로 꺼졌다가 재부팅돼 세션이 자동 재개됨] 그 순간 진행 중이던 작업(백그라운드 셸·대기·ccd gpu 작업 포함)이 중단됐을 수 있습니다. 결과 파일과 ccd gpu 상태를 확인하고, 필요한 것은 다시 실행해 이어서 진행하세요.`;
    flog(`unclean boot ${ev.t}: ${kind}`);
    return { ev, code, kind, note, bootT: boot || Date.parse(ev.t), downT: ev.down ? Date.parse(ev.down) : null };
  }

  // step 2 (transcript scan, slower): resume what was cut off and report.
  // skip: sessions the dashboard's own saved terminals bring back (recoverTerms), restored = their count
  async function handle(crash, { resume, skip = new Set(), restored = 0 }) {
    const { code, kind, note, bootT, downT } = crash;
    const { sessions, lastAct } = await scanTranscripts(bootT, downT || 0);
    // the event log can lag the last session activity by minutes (and transcripts can be idle for hours)
    const crashT = Math.max(downT || 0, lastAct) || bootT;
    const when = new Date(crashT).toLocaleString('sv-SE').slice(5, 16);

    // cut off = mid-turn within 2 h of the crash, nothing written since, not running now
    const live = new Set(liveSessions().map((s) => s.sessionId));
    const cut = sessions.filter((s) => s.midturn && s.after === 0 && crashT - s.t < 2 * 3600e3 && !live.has(s.id) && !skip.has(s.id));
    const resumable = cut.filter((s) => s.entry === 'cli' && s.cwd && fs.existsSync(s.cwd)).slice(0, MAX_RESUME);
    const other = cut.filter((s) => !resumable.includes(s));
    const resumed = [];
    for (const s of resumable) {
      try { await resume(s, note); resumed.push(s); } catch (e) { flog(`resume ${s.id.slice(0, 8)} failed: ${e.message}`); other.push(s); }
    }

    // local GPU tickets alive at the crash (waiting or running): their processes died with the PC
    let lost = [];
    try {
      const q = JSON.parse(fs.readFileSync(gpuFile, 'utf8'));
      lost = (q.tickets || []).filter((t) => String(t.gpu || t.asked || '').startsWith('local') && t.createdAt < crashT && (!t.endedAt || t.endedAt > crashT));
    } catch {}

    let freeC = null; try { const f = fs.statfsSync('C:/'); freeC = f.bavail * f.bsize / 2 ** 30; } catch {}
    const lines = [`⚠️ <b>${crash.ev?.update ? 'PC 자동 재시작 감지' : 'PC 비정상 종료 감지'}</b> · ${kind}`, `꺼진 시각 ≈ ${when}, 재부팅 ${new Date(bootT).toLocaleString('sv-SE').slice(5, 16)}`];
    if (restored) lines.push(`대시보드 터미널 ${restored}개 복원 (작업 중이던 세션엔 중단 안내 전송)`);
    if (resumed.length) lines.push(`\n자동 재개한 세션 ${resumed.length}개 (중단 안내 전송):`, ...resumed.map((s) => `• ${s.title || s.id.slice(0, 8)}`));
    if (other.length) lines.push(`\n확인 필요 (자동 재개 안 함: 데스크톱 앱·-p 실행·폴더 없음):`, ...other.slice(0, 10).map((s) => `• ${s.title || s.id.slice(0, 8)} [${s.entry || '?'}]`));
    if (lost.length) lines.push(`\n중단된 로컬 GPU 작업 ${lost.length}개:`, ...lost.map((t) => `• ${t.label} (${t.requester?.title || ''})`));
    if (!restored && !resumed.length && !other.length && !lost.length) lines.push('진행 중이던 세션·GPU 작업 없음');
    if (freeC != null) lines.push(`\nC: 여유 ${freeC.toFixed(0)} GB${freeC < 40 ? ' ⚠️ 부족' : ''}`);
    if (code) lines.push('덤프: C:\\Windows\\Minidump (원인 분석은 세션에 요청)');
    const text = lines.join('\n');
    flog(text.replace(/<[^>]+>/g, '').replace(/\n+/g, ' | '));
    try { notify(text); } catch (e) { flog('notify failed: ' + e.message); }
    return { resumed: resumed.map((s) => s.id) };
  }
  return { detect, handle };
};
