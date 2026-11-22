const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Walk up from rawPath until an existing directory is found, falling back to fallbackDir or homedir.
 */
function resolveInitialDir(rawPath, fallbackDir) {
  const candidates = [];
  const raw = String(rawPath || '').trim();
  if (raw && path.isAbsolute(raw)) {
    let cur = path.resolve(raw);
    for (let i = 0; i < 8; i++) {
      candidates.push(cur);
      const parent = path.dirname(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
  }
  if (fallbackDir) candidates.push(path.resolve(fallbackDir));
  candidates.push(os.homedir());
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return dir;
    } catch {}
  }
  return os.homedir();
}

/**
 * Build PowerShell script using modern Windows File Explorer (IFileOpenDialog + FOS_PICKFOLDERS)
 * with a TopMost owner window so the picker always opens in front of the browser.
 */
function buildPickDirPowerShellScript({ testAutoCloseMs = 0 } = {}) {
  const autoCloseMs = Number(testAutoCloseMs) > 0 ? Math.trunc(Number(testAutoCloseMs)) : 0;
  const cs = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class AchFolderPicker {
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_SHOWWINDOW = 0x0040;
  const int SW_SHOW = 5;

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("user32.dll")]
  static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

  [DllImport("kernel32.dll")]
  static extern uint GetCurrentProcessId();

  [DllImport("kernel32.dll")]
  static extern uint GetCurrentThreadId();

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem ppv);

  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  class FileOpenDialogRCW {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int alignment);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  private static Form CreateTopMostOwner(string title) {
    var wa = Screen.PrimaryScreen != null ? Screen.PrimaryScreen.WorkingArea : new System.Drawing.Rectangle(0, 0, 1280, 800);
    var owner = new Form();
    owner.Text = string.IsNullOrEmpty(title) ? "Windows Explorer" : title;
    owner.StartPosition = FormStartPosition.Manual;
    owner.Location = new System.Drawing.Point(wa.Left + wa.Width / 2, wa.Top + wa.Height / 2);
    owner.Size = new System.Drawing.Size(1, 1);
    owner.FormBorderStyle = FormBorderStyle.FixedToolWindow;
    owner.ShowInTaskbar = true;
    owner.Opacity = 0.01;
    owner.TopMost = true;
    owner.Show();
    ForceWindowFront(owner.Handle);
    return owner;
  }

  private static void ForceWindowFront(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return;
    ShowWindow(hWnd, SW_SHOW);
    SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    IntPtr fg = GetForegroundWindow();
    uint fgTid = 0;
    uint curTid = GetCurrentThreadId();
    bool attached = false;
    if (fg != IntPtr.Zero) {
      uint dummy;
      fgTid = GetWindowThreadProcessId(fg, out dummy);
      if (fgTid != 0 && fgTid != curTid) attached = AttachThreadInput(curTid, fgTid, true);
    }
    try {
      SetForegroundWindow(hWnd);
      BringWindowToTop(hWnd);
    } finally {
      if (attached) AttachThreadInput(curTid, fgTid, false);
    }
  }

  private static bool PromoteCurrentDialogToFront() {
    uint selfPid = GetCurrentProcessId();
    bool promoted = false;
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == selfPid && IsWindowVisible(h)) {
        var cls = new System.Text.StringBuilder(64);
        GetClassName(h, cls, 64);
        if (cls.ToString() == "#32770") {
          ForceWindowFront(h);
          promoted = true;
        }
      }
      return true;
    }, IntPtr.Zero);
    return promoted;
  }

  private static void CloseCurrentDialog() {
    uint selfPid = GetCurrentProcessId();
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == selfPid) {
        var cls = new System.Text.StringBuilder(64);
        GetClassName(h, cls, 64);
        if (cls.ToString() == "#32770") PostMessage(h, 0x0010u, IntPtr.Zero, IntPtr.Zero);
      }
      return true;
    }, IntPtr.Zero);
  }

  public static string Pick(string initDir, string title, int autoCloseMs) {
    try {
      var dlg = (IFileOpenDialog)new FileOpenDialogRCW();
      try {
        uint opts;
        dlg.GetOptions(out opts);
        // FOS_PICKFOLDERS(0x20) | FOS_FORCEFILESYSTEM(0x40) | FOS_PATHMUSTEXIST(0x800) | FOS_NOCHANGEDIR(0x8)
        dlg.SetOptions(opts | 0x20u | 0x40u | 0x800u | 0x8u);
        if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
        if (!string.IsNullOrEmpty(initDir) && Directory.Exists(initDir)) {
          IShellItem folderItem;
          SHCreateItemFromParsingName(initDir, IntPtr.Zero, typeof(IShellItem).GUID, out folderItem);
          dlg.SetFolder(folderItem);
          Marshal.ReleaseComObject(folderItem);
        }
        using (var owner = CreateTopMostOwner(title)) {
          var frontTimer = new System.Windows.Forms.Timer();
          int ticks = 0;
          frontTimer.Interval = 50;
          frontTimer.Tick += (s, e) => {
            ticks++;
            if (PromoteCurrentDialogToFront() || ticks >= 40) frontTimer.Stop();
          };
          frontTimer.Start();

          System.Windows.Forms.Timer closeTimer = null;
          if (autoCloseMs > 0) {
            closeTimer = new System.Windows.Forms.Timer();
            closeTimer.Interval = autoCloseMs;
            closeTimer.Tick += (s, e) => { closeTimer.Stop(); CloseCurrentDialog(); };
            closeTimer.Start();
          }
          try {
            int hr = dlg.Show(owner.Handle);
            if (hr == 0) {
              IShellItem item;
              dlg.GetResult(out item);
              string chosen;
              item.GetDisplayName(0x80058000u, out chosen);
              Marshal.ReleaseComObject(item);
              return chosen ?? "";
            }
            return "";
          } finally {
            frontTimer.Dispose();
            if (closeTimer != null) closeTimer.Dispose();
          }
        }
      } finally {
        Marshal.ReleaseComObject(dlg);
      }
    } catch {
      using (var owner = CreateTopMostOwner(title))
      using (var fb = new FolderBrowserDialog()) {
        if (!string.IsNullOrEmpty(title)) fb.Description = title;
        if (!string.IsNullOrEmpty(initDir) && Directory.Exists(initDir)) fb.SelectedPath = initDir;
        fb.ShowNewFolderButton = true;
        var frontTimer = new System.Windows.Forms.Timer();
        int ticks = 0;
        frontTimer.Interval = 50;
        frontTimer.Tick += (s, e) => {
          ticks++;
          if (PromoteCurrentDialogToFront() || ticks >= 40) frontTimer.Stop();
        };
        frontTimer.Start();
        try {
          return fb.ShowDialog(owner) == DialogResult.OK ? (fb.SelectedPath ?? "") : "";
        } finally {
          frontTimer.Dispose();
        }
      }
    }
  }
}
`;

  return [
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = "Stop"',
    'Add-Type -ReferencedAssemblies "System.Windows.Forms","System.Drawing" -TypeDefinition @"',
    cs,
    '"@',
    `$chosen = [AchFolderPicker]::Pick($env:ACH_PICK_INIT, $env:ACH_PICK_TITLE, ${autoCloseMs})`,
    'if ($chosen) { Write-Output ("PICKED:" + $chosen) } else { Write-Output "CANCELLED" }',
  ].join('\n');
}

function parsePickDirOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('PICKED:')) {
      const picked = lines[i].slice('PICKED:'.length).trim();
      return picked ? { ok: true, cancelled: false, path: picked } : { ok: false, cancelled: true, path: null };
    }
    if (lines[i] === 'CANCELLED') {
      return { ok: false, cancelled: true, path: null };
    }
  }
  return { ok: false, cancelled: false, path: null };
}

let activePicker = null;

/**
 * Open the native Windows File Explorer folder picker dialog and return { ok, path, cancelled?, error? }.
 */
function pickDirectory({ initialPath = '', title = '작업할 프로젝트 폴더를 선택하세요', fallbackDir = '', timeoutMs = 120_000, testAutoCloseMs = 0 } = {}) {
  const initDir = resolveInitialDir(initialPath, fallbackDir);
  const psScript = buildPickDirPowerShellScript({ testAutoCloseMs });
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

  if (activePicker) {
    activePicker.superseded = true;
    try { activePicker.child.kill(); } catch {}
    activePicker = null;
  }

  return new Promise((resolve) => {
    const entry = { child: null, superseded: false };
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-Sta', '-EncodedCommand', encoded],
      {
        timeout: timeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          ACH_PICK_INIT: initDir,
          ACH_PICK_TITLE: String(title || '작업할 프로젝트 폴더를 선택하세요'),
        },
      },
      (err, stdout, stderr) => {
        if (activePicker === entry) activePicker = null;
        if (entry.superseded) {
          return resolve({ ok: false, cancelled: true, path: null });
        }
        if (err) {
          const msg = err.killed
            ? '폴더 선택 창 응답 시간이 초과되었습니다.'
            : (String(stderr || '').trim() || err.message || 'Windows 탐색기를 실행하지 못했습니다.');
          return resolve({ ok: false, cancelled: false, path: null, error: msg });
        }
        const parsed = parsePickDirOutput(stdout);
        if (!parsed.ok && !parsed.cancelled) {
          return resolve({
            ok: false,
            cancelled: false,
            path: null,
            error: String(stderr || '').trim() || 'Windows 탐색기에서 폴더를 선택하지 못했습니다.',
          });
        }
        resolve(parsed);
      }
    );
    entry.child = child;
    activePicker = entry;
  });
}

module.exports = {
  resolveInitialDir,
  buildPickDirPowerShellScript,
  parsePickDirOutput,
  pickDirectory,
};
