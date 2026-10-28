"""Console bridge: lists console windows, reads their screen, injects keystrokes.

Runs as a long-lived child of server.js. Requests/responses are JSON lines on
stdin/stdout (pipes, so they survive FreeConsole/AttachConsole).
"""
import ctypes
import ctypes.wintypes as wt
import json
import sys
import time

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
# the hub waits on this for every window list: keep it ahead of CPU-heavy batch jobs (ABOVE_NORMAL)
k32.SetPriorityClass(wt.HANDLE(-1), 0x8000)  # -1 = this process
u32 = ctypes.WinDLL("user32", use_last_error=True)

GENERIC_READ, GENERIC_WRITE = 0x80000000, 0x40000000
FILE_SHARE_RW = 0x3
OPEN_EXISTING = 3
INVALID_HANDLE = wt.HANDLE(-1).value
TH32CS_SNAPPROCESS = 0x2
KEY_EVENT = 0x1
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
      "left": (0x25, "\0"), "right": (0x27, "\0"), "ctrl+c": (0x43, "\x03")}


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
        recs += key_records(vk, ch, LEFT_CTRL_PRESSED if key.startswith("ctrl+") else 0)
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


HANDLERS = {"list": cmd_list, "read": cmd_read, "send": cmd_send, "focus": cmd_focus, "procs": cmd_procs}

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
