'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const HUB_DIR = path.resolve(__dirname, '..');
const PY = process.env.CCD_PYTHON || 'python';

test('consolehelper.py window enumeration and PNG encoder work cleanly', { skip: process.platform !== 'win32' }, () => {
  const script = `
import base64, subprocess, sys, time
sys.path.insert(0, ${JSON.stringify(HUB_DIR)})
import consolehelper as ch

procs = {10: ("cmd.exe", 1), 20: ("chrome.exe", 10), 30: ("chrome.exe", 20), 40: ("notepad.exe", 1)}
desc = ch._descendant_pids(procs, [10])
assert desc == {10, 20, 30}, f"unexpected desc: {desc}"

png = ch._bgra_to_png(bytes([10, 20, 30, 255] * 16), 4, 4)
assert png[:8] == b"\\x89PNG\\r\\n\\x1a\\n"

p = subprocess.Popen(["powershell", "-NoProfile", "-Sta", "-Command",
  "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.Form; $f.Text='AchWinTest'; $f.Width=320; $f.Height=220; $t=New-Object System.Windows.Forms.Timer; $t.Interval=2500; $t.Add_Tick({$f.Close()}); $t.Start(); [void]$f.ShowDialog()"])
try:
  deadline = time.monotonic() + 8
  w = None
  while p.poll() is None and time.monotonic() < deadline:
    res = ch.cmd_list_windows({"pids": [p.pid]})
    w = next((item for item in res["windows"] if item["pid"] == p.pid and item["title"] == "AchWinTest"), None)
    if w:
      break
    time.sleep(0.1)
  assert w is not None, "Test window did not appear"
  assert w["linked"] is True, f"Test window is not linked: {w}"
  cap = ch.cmd_capture_window({"hwnd": w["hwnd"], "max_width": 240})
  assert cap["ok"] is True, f"capture failed: {cap}"
  raw = base64.b64decode(cap["png"])
  assert raw[:8] == b"\\x89PNG\\r\\n\\x1a\\n"
finally:
  p.wait(timeout=6)
print("PY_WIN_TEST_OK")
`;
  const run = spawnSync(PY, ['-c', script], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.equal(run.status, 0, `stderr=${run.stderr}\nstdout=${run.stdout}`);
  assert.match(run.stdout, /PY_WIN_TEST_OK/);
});
