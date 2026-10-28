// Local GPU job launcher, fully outside the caller's process tree.
//
// Jobs used to be children of `ccd gpu run`, which itself is a child of a Claude session's shell.
// When that shell is torn down (Claude Code's low-memory guard, a closed terminal, a dashboard
// restart) the whole tree goes — including a 60k-step training run. So the job is created by WMI
// (Win32_Process.Create): its parent is WmiPrvSE, not us, and no tree-kill of the session reaches it.
//
// The job runs from a generated .cmd that restores the caller's environment (conda env, PATH, ...)
// plus CUDA_VISIBLE_DEVICES / CCD_GPU_TICKET, appends all output to the log and writes the exit
// code to <log>.exit. The wrapper only watches: tails the log, polls the pid, reads the exit code.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// one argv element for cmd.exe
const cmdQuote = (a) => (/^[\w@+=:,./\\-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);
const pct = (s) => String(s).replace(/%/g, '%%'); // .cmd files expand %VAR%

function writeJobCmd({ file, rest, cwd, env, logFile, exitFile }) {
  const cmdline = rest.length === 1 ? rest[0] : rest.map(cmdQuote).join(' ');
  const lines = ['@echo off', 'chcp 65001 >nul'];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][\w().-]*$/.test(k) || /[\r\n]/.test(v)) continue; // skip "=C:" style and multi-line values
    // Claude Code sets this for its own shells; the job should find scripts in its folder like a normal prompt
    if (/^NoDefaultCurrentDirectoryInExePath$/i.test(k)) continue;
    lines.push(`set "${k}=${pct(v).replace(/"/g, '')}"`);
  }
  lines.push(`cd /d "${cwd}"`);
  lines.push(`call ${pct(cmdline)} >> "${logFile}" 2>&1`);
  // redirect first: "echo 3> f" would mean stream 3
  lines.push(`>"${exitFile}" echo %ERRORLEVEL%`);
  // the file holds the caller's whole environment (tokens, keys): delete it when done
  lines.push('(goto) 2>nul & del "%~f0"');
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
}

// → pid of the cmd.exe running the job (hidden window)
function launchViaWmi(cmdFile, cwd) {
  const ps = `$si = ([wmiclass]'Win32_ProcessStartup').CreateInstance(); $si.ShowWindow = 0;
$r = ([wmiclass]'Win32_Process').Create('cmd.exe /d /c "${cmdFile.replace(/'/g, "''")}"', '${cwd.replace(/'/g, "''")}', $si);
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($r.ReturnValue)" }; $r.ProcessId`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const pid = Number(String(out).trim().split(/\s+/).pop());
  if (!pid) throw new Error(`no pid from WMI: ${out}`);
  return pid;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

module.exports = { writeJobCmd, launchViaWmi, alive };
