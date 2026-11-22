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
  [DllImport("user32.dll")]
  static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  static extern bool BringWindowToTop(IntPtr hWnd);

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

  private static Form CreateTopMostOwner() {
    var owner = new Form();
    owner.StartPosition = FormStartPosition.Manual;
    owner.Location = new System.Drawing.Point(-32000, -32000);
    owner.Size = new System.Drawing.Size(1, 1);
    owner.ShowInTaskbar = false;
    owner.Opacity = 0;
    owner.TopMost = true;
    owner.Show();
    owner.Activate();
    SetForegroundWindow(owner.Handle);
    BringWindowToTop(owner.Handle);
    return owner;
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
        using (var owner = CreateTopMostOwner()) {
          System.Windows.Forms.Timer timer = null;
          if (autoCloseMs > 0) {
            timer = new System.Windows.Forms.Timer();
            timer.Interval = autoCloseMs;
            timer.Tick += (s, e) => { timer.Stop(); dlg.Close(-2147023673); };
            timer.Start();
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
            if (timer != null) timer.Dispose();
          }
        }
      } finally {
        Marshal.ReleaseComObject(dlg);
      }
    } catch {
      using (var owner = CreateTopMostOwner())
      using (var fb = new FolderBrowserDialog()) {
        if (!string.IsNullOrEmpty(title)) fb.Description = title;
        if (!string.IsNullOrEmpty(initDir) && Directory.Exists(initDir)) fb.SelectedPath = initDir;
        fb.ShowNewFolderButton = true;
        return fb.ShowDialog(owner) == DialogResult.OK ? (fb.SelectedPath ?? "") : "";
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

/**
 * Open the native Windows File Explorer folder picker dialog and return { ok, path, cancelled?, error? }.
 */
function pickDirectory({ initialPath = '', title = '작업할 프로젝트 폴더를 선택하세요', fallbackDir = '', timeoutMs = 120_000, testAutoCloseMs = 0 } = {}) {
  const initDir = resolveInitialDir(initialPath, fallbackDir);
  const psScript = buildPickDirPowerShellScript({ testAutoCloseMs });
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

  return new Promise((resolve) => {
    execFile(
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
  });
}

module.exports = {
  resolveInitialDir,
  buildPickDirPowerShellScript,
  parsePickDirOutput,
  pickDirectory,
};
