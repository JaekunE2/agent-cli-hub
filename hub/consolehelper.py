"""Console bridge: lists console windows, reads their screen, injects keystrokes.

Runs as a long-lived child of server.js. Requests/responses are JSON lines on
stdin/stdout (pipes, so they survive FreeConsole/AttachConsole).
"""
import base64
import ctypes
import ctypes.wintypes as wt
import json
import struct
import sys
import time
import zlib

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
# the hub waits on this for every window list: keep it ahead of CPU-heavy batch jobs (ABOVE_NORMAL)
k32.SetPriorityClass(wt.HANDLE(-1), 0x8000)  # -1 = this process
u32 = ctypes.WinDLL("user32", use_last_error=True)
g32 = ctypes.WinDLL("gdi32", use_last_error=True)

GENERIC_READ, GENERIC_WRITE = 0x80000000, 0x40000000
FILE_SHARE_RW = 0x3
OPEN_EXISTING = 3
INVALID_HANDLE = wt.HANDLE(-1).value
TH32CS_SNAPPROCESS = 0x2
KEY_EVENT = 0x1
LEFT_ALT_PRESSED = 0x2
LEFT_CTRL_PRESSED = 0x8

CANDIDATES = {
    "cmd.exe", "powershell.exe", "pwsh.exe", "claude.exe", "python.exe",
    "pythonw.exe", "node.exe", "bash.exe", "wsl.exe", "ssh.exe", "conda.exe",
}


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD),
                ("th32ProcessID", wt.DWORD), ("th32DefaultHeapID", ctypes.c_void_p),
                ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
                ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wt.DWORD), ("szExeFile", ctypes.c_wchar * 260)]


class COORD(ctypes.Structure):
    _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]


class SMALL_RECT(ctypes.Structure):
    _fields_ = [("Left", ctypes.c_short), ("Top", ctypes.c_short),
                ("Right", ctypes.c_short), ("Bottom", ctypes.c_short)]


class CSBI(ctypes.Structure):
    _fields_ = [("dwSize", COORD), ("dwCursorPosition", COORD),
                ("wAttributes", wt.WORD), ("srWindow", SMALL_RECT),
                ("dwMaximumWindowSize", COORD)]


class KEY_EVENT_RECORD(ctypes.Structure):
    _fields_ = [("bKeyDown", wt.BOOL), ("wRepeatCount", wt.WORD),
                ("wVirtualKeyCode", wt.WORD), ("wVirtualScanCode", wt.WORD),
                ("UnicodeChar", ctypes.c_wchar), ("dwControlKeyState", wt.DWORD)]


class _EV(ctypes.Union):
    _fields_ = [("KeyEvent", KEY_EVENT_RECORD), ("_pad", ctypes.c_byte * 16)]


class INPUT_RECORD(ctypes.Structure):
    _fields_ = [("EventType", wt.WORD), ("Event", _EV)]


k32.CreateFileW.restype = wt.HANDLE
k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
k32.GetConsoleWindow.restype = wt.HWND

# Ctrl+C sent to a console we are attached to must not kill the helper.
k32.SetConsoleCtrlHandler(None, True)


def processes():
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    out = {}
    e = PROCESSENTRY32W()
    e.dwSize = ctypes.sizeof(e)
    ok = k32.Process32FirstW(snap, ctypes.byref(e))
    while ok:
        out[e.th32ProcessID] = (e.szExeFile, e.th32ParentProcessID)
        ok = k32.Process32NextW(snap, ctypes.byref(e))
    k32.CloseHandle(snap)
    return out


class attached:
    """Context manager: attach to pid's console, detach on exit."""

    def __init__(self, pid):
        self.pid = pid

    def __enter__(self):
        k32.FreeConsole()
        if not k32.AttachConsole(self.pid):
            raise OSError(f"AttachConsole({self.pid}) failed: {ctypes.get_last_error()}")
        return self

    def __exit__(self, *a):
        k32.FreeConsole()

    def handle(self, name):
        h = k32.CreateFileW(name, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_RW, None,
                            OPEN_EXISTING, 0, None)
        if h == INVALID_HANDLE:
            raise OSError(f"open {name} failed: {ctypes.get_last_error()}")
        return h


def console_info():
    buf = ctypes.create_unicode_buffer(512)
    k32.GetConsoleTitleW(buf, 512)
    arr = (wt.DWORD * 256)()
    n = k32.GetConsoleProcessList(arr, 256)
    hwnd = k32.GetConsoleWindow()
    return {
        "title": buf.value,
        "pids": sorted(arr[i] for i in range(min(n, 256))),
        "visible": bool(hwnd and u32.IsWindowVisible(hwnd)),
    }


# AttachConsole costs ~0.2 s per process on this PC; with 40 sessions open a full scan took 13-18 s
# and the dashboard's 8 s limit turned every session into "창 없음". Two shortcuts:
# - these programs (almost) never open a console of their own, so when their parent's console was
#   already read they are in it (its process list says so) — no need to attach to them;
# - a process that had no console to attach to once won't get one later: remember it.
#   Except right after start: a claude just spawned by the pty host can't be attached for a moment, and
#   remembering that forever cut its dashboard terminal off from its session (window "gone"). So a failure
#   is retried a few times with growing gaps (10 s, 30 s, 90 s) before it counts as "no console".
INHERITS = {"claude.exe", "node.exe", "python.exe", "pythonw.exe", "bash.exe", "ssh.exe", "conda.exe"}
_no_console = {}  # pid -> (exe name, failures, last failure time), cleared when the pid goes away or is reused
NO_CONSOLE_RETRIES = 3


def cmd_list(_req):
    procs = processes()
    for p in [p for p, v in _no_console.items() if procs.get(p, ("",))[0] != v[0]]:
        del _no_console[p]
    now = time.monotonic()
    def gave_up(pid):
        v = _no_console.get(pid)
        return v is not None and (v[1] > NO_CONSOLE_RETRIES or now - v[2] < 10 * 3 ** (v[1] - 1))
    seen, consoles = set(), []
    me = k32.GetCurrentProcessId()
    # parents before children, so a child's console is usually known when we reach it
    order = sorted(procs.items(), key=lambda kv: (kv[1][0].lower() in INHERITS, kv[0]))
    for pid, (name, ppid) in order:
        if name.lower() not in CANDIDATES or pid in seen or pid == me or gave_up(pid):
            continue
        if name.lower() in INHERITS and ppid in seen:
            continue  # shares its parent's console, whose process list did not include it: it has none
        try:
            with attached(pid):
                info = console_info()
        except OSError:
            v = _no_console.get(pid)
            _no_console[pid] = (name, (v[1] if v else 0) + 1, now)
            continue
        _no_console.pop(pid, None)
        info["pids"] = [p for p in info["pids"] if p != me]
        seen.update(info["pids"])
        info["procs"] = [{"pid": p, "name": procs.get(p, ("?", 0))[0],
                          "ppid": procs.get(p, ("?", 0))[1]} for p in info["pids"]]
        for p in info["procs"]:
            p["parent"] = procs.get(p["ppid"], ("", 0))[0]
        info["id"] = min(info["pids"]) if info["pids"] else pid
        consoles.append(info)
    return {"consoles": consoles}


def cmd_read(req):
    lines_wanted = int(req.get("lines", 400))
    with attached(req["pid"]) as a:
        h = a.handle("CONOUT$")
        try:
            csbi = CSBI()
            if not k32.GetConsoleScreenBufferInfo(h, ctypes.byref(csbi)):
                raise OSError(f"GetConsoleScreenBufferInfo failed: {ctypes.get_last_error()}")
            width = csbi.dwSize.X
            bottom = max(csbi.srWindow.Bottom, csbi.dwCursorPosition.Y)
            top = max(0, bottom - lines_wanted + 1)
            buf = ctypes.create_unicode_buffer(width + 1)
            read = wt.DWORD()
            lines = []
            for y in range(top, bottom + 1):
                k32.ReadConsoleOutputCharacterW(h, buf, width, COORD(0, y), ctypes.byref(read))
                lines.append(buf.value[:read.value].rstrip())
            info = console_info()
        finally:
            k32.CloseHandle(h)
    return {"lines": lines, "title": info["title"], "width": width,
            "cursor": [csbi.dwCursorPosition.X, csbi.dwCursorPosition.Y - top],
            "viewTop": csbi.srWindow.Top - top}


VK = {"enter": (0x0D, "\r"), "esc": (0x1B, "\x1b"), "tab": (0x09, "\t"),
      "backspace": (0x08, "\b"), "up": (0x26, "\0"), "down": (0x28, "\0"),
      "left": (0x25, "\0"), "right": (0x27, "\0"), "ctrl+c": (0x43, "\x03"),
      "alt+m": (0x4D, "m")}


def key_records(vk, ch, ctrl=0):
    recs = []
    for down in (True, False):
        r = INPUT_RECORD()
        r.EventType = KEY_EVENT
        ke = r.Event.KeyEvent
        ke.bKeyDown, ke.wRepeatCount, ke.wVirtualKeyCode = down, 1, vk
        ke.wVirtualScanCode = u32.MapVirtualKeyW(vk, 0)
        ke.UnicodeChar, ke.dwControlKeyState = ch, ctrl
        recs.append(r)
    return recs


def cmd_send(req):
    recs = []
    for ch in req.get("text", ""):
        if ch == "\n":
            recs += key_records(*VK["enter"])
        else:
            recs += key_records(0, ch)
    for key in req.get("keys", []):
        vk, ch = VK[key]
        mod = LEFT_CTRL_PRESSED if key.startswith("ctrl+") else LEFT_ALT_PRESSED if key.startswith("alt+") else 0
        recs += key_records(vk, ch, mod)
    with attached(req["pid"]) as a:
        h = a.handle("CONIN$")
        try:
            arr = (INPUT_RECORD * len(recs))(*recs)
            written = wt.DWORD()
            if recs and not k32.WriteConsoleInputW(h, arr, len(recs), ctypes.byref(written)):
                raise OSError(f"WriteConsoleInputW failed: {ctypes.get_last_error()}")
        finally:
            k32.CloseHandle(h)
    return {"written": written.value if recs else 0}


def cmd_focus(req):
    """Bring the real console window to the foreground (conhost only)."""
    with attached(req["pid"]):
        hwnd = k32.GetConsoleWindow()
    if hwnd:
        u32.ShowWindow(hwnd, 9)
        u32.SetForegroundWindow(hwnd)
    return {"ok": bool(hwnd)}


def cmd_procs(_req):
    """Whole process table (pid, exe name, parent pid) from one Toolhelp snapshot."""
    return {"procs": [[pid, name, ppid] for pid, (name, ppid) in processes().items()]}


BROWSER_EXES = {"chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "chromium.exe", "opera.exe"}
SKIP_WINDOW_CLASSES = {"ConsoleWindowClass", "Progman", "WorkerW", "Shell_TrayWnd", "Windows.UI.Core.CoreWindow"}
PW_RENDERFULLCONTENT = 2
SRCCOPY = 0x00CC0020
HALFTONE = 4
DIB_RGB_COLORS = 0


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
        ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wt.DWORD * 3)]


_WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
u32.EnumWindows.argtypes = [_WNDENUMPROC, wt.LPARAM]
u32.EnumWindows.restype = wt.BOOL
u32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
u32.GetWindowThreadProcessId.restype = wt.DWORD
u32.GetWindowTextLengthW.argtypes = [wt.HWND]
u32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
u32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
u32.IsWindowVisible.argtypes = [wt.HWND]
u32.IsWindowVisible.restype = wt.BOOL
u32.IsIconic.argtypes = [wt.HWND]
u32.IsIconic.restype = wt.BOOL
u32.IsWindow.argtypes = [wt.HWND]
u32.IsWindow.restype = wt.BOOL
u32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
u32.GetWindowRect.restype = wt.BOOL
u32.PrintWindow.argtypes = [wt.HWND, wt.HDC, wt.UINT]
u32.PrintWindow.restype = wt.BOOL
u32.GetDC.argtypes = [wt.HWND]
u32.GetDC.restype = wt.HDC
u32.ReleaseDC.argtypes = [wt.HWND, wt.HDC]
g32.CreateCompatibleDC.argtypes = [wt.HDC]
g32.CreateCompatibleDC.restype = wt.HDC
g32.CreateCompatibleBitmap.argtypes = [wt.HDC, ctypes.c_int, ctypes.c_int]
g32.CreateCompatibleBitmap.restype = wt.HBITMAP
g32.SelectObject.argtypes = [wt.HDC, wt.HGDIOBJ]
g32.SelectObject.restype = wt.HGDIOBJ
g32.DeleteObject.argtypes = [wt.HGDIOBJ]
g32.DeleteDC.argtypes = [wt.HDC]
g32.SetStretchBltMode.argtypes = [wt.HDC, ctypes.c_int]
g32.StretchBlt.argtypes = [wt.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                          wt.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wt.DWORD]
g32.StretchBlt.restype = wt.BOOL
g32.GetDIBits.argtypes = [wt.HDC, wt.HBITMAP, wt.UINT, wt.UINT, ctypes.c_void_p, ctypes.POINTER(BITMAPINFO), wt.UINT]
g32.GetDIBits.restype = ctypes.c_int


def _descendant_pids(procs, root_pids):
    children = {}
    for pid, (_name, ppid) in procs.items():
        children.setdefault(ppid, []).append(pid)
    seen = set()
    queue = [int(p) for p in root_pids if p]
    while queue:
        cur = queue.pop(0)
        if cur in seen:
            continue
        seen.add(cur)
        for ch in children.get(cur, ()):
            if ch not in seen:
                queue.append(ch)
    return seen


def _bgra_to_png(bgra_bytes, w, h):
    stride = w * 4
    rows = []
    for y in range(h):
        row = bgra_bytes[y * stride:(y + 1) * stride]
        rgb = bytearray(1 + w * 3)
        rgb[1::3] = row[2::4]
        rgb[2::3] = row[1::4]
        rgb[3::3] = row[0::4]
        rows.append(bytes(rgb))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 5)) + chunk(b"IEND", b"")


def cmd_list_windows(req):
    """List GUI windows owned by terminal descendants plus desktop browser windows."""
    procs = processes()
    roots = list(req.get("pids") or [])
    if req.get("pid"):
        roots.append(req["pid"])
    desc = _descendant_pids(procs, roots)
    include_all = bool(req.get("all"))
    found = []

    def enum_cb(hwnd, _lp):
        if not u32.IsWindowVisible(hwnd):
            return True
        cls_buf = ctypes.create_unicode_buffer(128)
        u32.GetClassNameW(hwnd, cls_buf, 128)
        if cls_buf.value in SKIP_WINDOW_CLASSES:
            return True
        tlen = u32.GetWindowTextLengthW(hwnd)
        if tlen <= 0:
            return True
        tbuf = ctypes.create_unicode_buffer(min(tlen + 1, 512))
        u32.GetWindowTextW(hwnd, tbuf, len(tbuf))
        title = tbuf.value.strip()
        if not title or title.startswith("Agent CLI Hub"):
            return True
        pid = wt.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        pid_val = int(pid.value)
        exe = procs.get(pid_val, ("", 0))[0]
        exe_low = exe.lower()
        linked = pid_val in desc
        is_browser = exe_low in BROWSER_EXES
        if not (include_all or linked or is_browser):
            return True
        rect = wt.RECT()
        u32.GetWindowRect(hwnd, ctypes.byref(rect))
        w = int(rect.right - rect.left)
        h = int(rect.bottom - rect.top)
        minimized = bool(u32.IsIconic(hwnd))
        if not minimized and (w < 120 or h < 80):
            return True
        found.append({
            "hwnd": int(hwnd),
            "pid": pid_val,
            "exe": exe or "app",
            "title": title[:160],
            "linked": linked,
            "browser": is_browser,
            "minimized": minimized,
            "rect": {"left": int(rect.left), "top": int(rect.top), "width": max(0, w), "height": max(0, h)},
        })
        return True

    cb = _WNDENUMPROC(enum_cb)
    u32.EnumWindows(cb, 0)
    found.sort(key=lambda x: (not x["linked"], x["minimized"], not x["browser"], x["title"].lower()))
    return {"windows": found[:24]}


def cmd_capture_window(req):
    """Capture a visible non-minimized window via PrintWindow and return base64 PNG."""
    hwnd = wt.HWND(int(req["hwnd"]))
    if not u32.IsWindow(hwnd):
        return {"ok": False, "error": "창을 찾을 수 없습니다 (닫혔을 수 있음)."}
    if u32.IsIconic(hwnd):
        return {"ok": False, "minimized": True, "error": "창이 최소화되어 있어 미리보기를 캡처할 수 없습니다."}
    rect = wt.RECT()
    if not u32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return {"ok": False, "error": "창 좌표를 읽을 수 없습니다."}
    src_w = int(rect.right - rect.left)
    src_h = int(rect.bottom - rect.top)
    if src_w <= 0 or src_h <= 0:
        return {"ok": False, "error": "창 크기가 올바르지 않습니다."}

    max_w = max(240, min(1440, int(req.get("max_width") or 900)))
    dst_w = min(src_w, max_w)
    dst_h = max(1, round(src_h * (dst_w / src_w)))

    scr_dc = u32.GetDC(None)
    src_dc = g32.CreateCompatibleDC(scr_dc)
    src_bmp = g32.CreateCompatibleBitmap(scr_dc, src_w, src_h)
    old_src = g32.SelectObject(src_dc, src_bmp)
    dst_dc = None
    dst_bmp = None
    old_dst = None
    try:
        ok = u32.PrintWindow(hwnd, src_dc, PW_RENDERFULLCONTENT)
        if not ok:
            ok = u32.PrintWindow(hwnd, src_dc, 0)
        if not ok:
            return {"ok": False, "error": "창 내용을 캡처하지 못했습니다."}
        if dst_w != src_w or dst_h != src_h:
            dst_dc = g32.CreateCompatibleDC(scr_dc)
            dst_bmp = g32.CreateCompatibleBitmap(scr_dc, dst_w, dst_h)
            old_dst = g32.SelectObject(dst_dc, dst_bmp)
            g32.SetStretchBltMode(dst_dc, HALFTONE)
            g32.StretchBlt(dst_dc, 0, 0, dst_w, dst_h, src_dc, 0, 0, src_w, src_h, SRCCOPY)
            read_dc, read_bmp = dst_dc, dst_bmp
        else:
            read_dc, read_bmp = src_dc, src_bmp

        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = dst_w
        bmi.bmiHeader.biHeight = -dst_h
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = 0
        buf = (ctypes.c_ubyte * (dst_w * dst_h * 4))()
        got = g32.GetDIBits(read_dc, read_bmp, 0, dst_h, buf, ctypes.byref(bmi), DIB_RGB_COLORS)
        if not got:
            return {"ok": False, "error": "창 비트맵을 읽지 못했습니다."}
        png = _bgra_to_png(bytes(buf), dst_w, dst_h)
        return {"ok": True, "width": dst_w, "height": dst_h, "png": base64.b64encode(png).decode("ascii")}
    finally:
        if old_dst:
            g32.SelectObject(dst_dc, old_dst)
        if dst_bmp:
            g32.DeleteObject(dst_bmp)
        if dst_dc:
            g32.DeleteDC(dst_dc)
        g32.SelectObject(src_dc, old_src)
        g32.DeleteObject(src_bmp)
        g32.DeleteDC(src_dc)
        u32.ReleaseDC(None, scr_dc)


def cmd_focus_window(req):
    """Restore (if minimized) and focus any desktop GUI window by HWND."""
    hwnd = wt.HWND(int(req["hwnd"]))
    if not u32.IsWindow(hwnd):
        return {"ok": False, "error": "창을 찾을 수 없습니다."}
    u32.ShowWindow(hwnd, 9 if u32.IsIconic(hwnd) else 5)
    u32.SetForegroundWindow(hwnd)
    return {"ok": True}


HANDLERS = {
    "list": cmd_list,
    "read": cmd_read,
    "send": cmd_send,
    "focus": cmd_focus,
    "procs": cmd_procs,
    "list_windows": cmd_list_windows,
    "capture_window": cmd_capture_window,
    "focus_window": cmd_focus_window,
}

for line in sys.stdin:
    try:
        req = json.loads(line)
        res = HANDLERS[req["op"]](req)
        res["ok"] = res.get("ok", True)
    except Exception as ex:  # report, keep serving
        req = req if isinstance(req, dict) else {}
        res = {"ok": False, "error": str(ex)}
    res["rid"] = req.get("rid")
    sys.stdout.write(json.dumps(res, ensure_ascii=False) + "\n")
    sys.stdout.flush()
