# ENVIRONMENT — this PC (Agent CLI Hub)

Maintained by the operator session. Facts only; dated per section. Last full check: **2026-11-22 20:40 KST** · last periodic check: **2026-11-25 08:10 KST**.

## Machine — 2026-11-22
- CPU: Intel Core i5-12400F · RAM: 15.9 GB + pagefile `C:\pagefile.sys` (system-managed, 33.7 GB allocated). **2026-11-24 17:28: only 333 MB RAM free, commit 47.1 / 49.6 GB (near the commit limit); 17:30 commit 47.7 / 49.6 GB, codex ×31, node ×69; 17:49 eased slightly: 1.2 GB free, commit 47.1 / 49.6 GB, codex ×28, node ×63; 17:52 0.77 GB free, commit 47.4 / 49.6 GB; 18:47 1.3 GB free, commit 46.5 / 49.6 GB; 18:56 commit 47.7 / 49.6 GB, codex ×31, node ×71; 18:58 commit **48.0 / 49.6 GB (highest so far)**; 19:24 same commit, 0.47 GB RAM free, codex ×33, node ×73; **19:48 pagefile grew 33.7 → 34.7 GB on C: (commit limit 49.6 → 50.6 GB), commit 49.1 / 50.6 GB, codex ×34, node ×78** — memory pressure is now eating C: — critical; **11-25 07:59 pagefile 36.4 GB (+1.7 GB), commit 49.2 / 51.4 GB, 1.4 GB RAM free, codex ×35, node ×105; 08:10 commit 49.8 / 51.4 GB (1.6 GB headroom), 0.8 GB RAM free** — codex ×30 ~1.8 GB, node ×63 ~1.3 GB, Edge/WebView2 ~2.3 GB, many hub task terminals. Pagefile can't grow much because C: is <10 % free. Use `--ram` for data-heavy jobs.
- OS: Windows 11 Pro 10.0.26200
- WSL2: `Ubuntu-22.04` (default), `docker-desktop` — both stopped at check time

## GPUs — 2026-11-22
- `local:0` NVIDIA GeForce RTX 3060, **12 GB**, driver 610.88, CUDA (driver) 13.3
- At check: 1.4–1.6 GB used, 41 °C, queue empty (0 active / 0 waiting)
- Only one GPU → every GPU job goes through `ccd gpu run --mem … --est … --label … -- <cmd>`

## Network — 2026-11-22
- LAN (이더넷): `10.10.10.106/16`
- Tailscale: `100.95.43.91` (host `km-office`), connected (brief Online=False blip ~08:28 on 2026-11-24 after a gateway change; back online by 08:39). Peers: `km-home` (online again 11-24 19:48, direct; earlier intermittent: offline 11-23 01:30–~11-24 01:19, online at 01:19, offline again since ~01:50), `km-notebook` (online 11:39–16:40 via DERP relay Tokyo; offline since ~16:40), `lumisys` (offline 28 d), `s26-ultra` (android, new on tailnet 2026-11-24, offline at 14:00)
- Proxy: none (WinHTTP direct; HTTP(S)_PROXY not set)
- Hyper-V vSwitches: WSL `192.168.128.1/20`, Default Switch `172.25.176.1/20`

## Disks — 2026-11-22
| Drive | Used | Free | Free % |
|---|---|---|---|
| C: | 260.8 GB | 23.7 GB | **8.3 %** (2026-11-25 07:59, falling — pagefile growth; 9.7 % at 03:12; 10.1 % at 00:12; low point 9.3 % / 26.4 GB at 11-24 19:48 from pagefile growth) |
| D: | 495.8 GB | 172.0 GB | 25.8 % (2026-11-25 07:59) |
- Prefer D: for outputs, datasets, checkpoints and caches.

## Tools — 2026-11-22
| Tool | Version | Path |
|---|---|---|
| node | v24.15.0 | `C:\Program Files\nodejs\node.exe` |
| python (on PATH) | 3.12.10 | `C:\Users\surromind\AppData\Local\Programs\Python\Python312\python.exe` |
| py launcher | default 3.13; also 3.12 (`D:\0.Surromind\Python312`), 3.9 | `py -0p` |
| uv | 0.12.5 | in Python312\Scripts |
| conda | not on PATH (only `CONDA_PKGS_DIRS` set) | — |
| git | 2.54.0 | `C:\Program Files\Git\cmd\git.exe` |
| claude | 2.1.318 | WinGet package |
| codex | codex-cli 0.164.0 | `%APPDATA%\npm\codex.ps1` |
| CUDA toolkit | v12.8, v13.2 (`CUDA_PATH`, nvcc), v13.3 | `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\` |
| docker | 29.9.2 (Docker Desktop, WSL backend) | `C:\Program Files\Docker\Docker\resources\bin` |
| tailscale | 1.104.6 | `C:\Program Files\Tailscale` |

## Where things live — 2026-11-22
- Projects: `D:\Gitsource\` — e.g. `26_dfm`, `M2N\wgkim_m2n_project_v2`, `viplatform_2026`, `surro-ai-suite` (+ several `surro-ai-suite-*` worktrees), `개인\agent-cli-hub` (this hub)
- Data-ish folders on D: `D:\DFMData`, `D:\WAFER_BACKUP`, `D:\VisionTest`, `D:\workspaces`, `D:\MulticaWorkspaces`
- Caches redirected to D: (`D:\AppCache\surromind\…`): pip, npm, Conda pkgs, NuGet, Poetry, **TEMP/TMP**
- Caches still on C: `C:\Users\surromind\.cache\` → `huggingface`, `torch`, `paddle`, … (C: is low — set `HF_HOME` / `TORCH_HOME` to D: for big downloads)
- pnpm store: `D:\.pnpm-store`
- Hub task worktrees: `D:\Gitsource\개인\agent-cli-hub\.hub-worktrees\task-<id>` (seen 2026-11-24)

## Accounts — 2026-11-25 07:59 (usage at check time)
- Claude Code (Max 20x): **Fable weekly limit reached (100 %)**, **all-models also 100 % at 11-25 03:12** (99 % at 00:12, 98 % at 11-24 19:24) — no Claude model usable on this account until reset; resets ~11-26 23:59 (1 d 16 h at 11-25 07:59). Trend: 73 % 11:50 → 85 % 15:31 → 93 % 17:28 → 97 % 18:58 → 98 % 19:24
- Codex — ChatGPT Pro (primary login on this PC): weekly 14 % (11-25 07:59)
- Codex — second Pro login: weekly 73 %, resets in ~1 d 6 h (11-26 ~14:00)
- Codex — Plus login: 5 h 67 % (resets ~08:12), **weekly 82 %**
- Antigravity (agy): Gemini 5 h 37 %, weekly 42 %; Claude/GPT 0 %
- Google API key: valid (quota not queryable)

## Conventions — 2026-11-22
- Hub: http://127.0.0.1:7777 (server was briefly down ~18:45 2026-11-23 during hub dev/tests; `ptyhost.js` kept terminals alive) · CLI `node D:\Gitsource\개인\agent-cli-hub\hub\ccd.js`
- GPU work only through the queue (`ccd gpu run`); never kill another job
- Notices board: `ccd notices`
- Hub terminals (2026-11-25 07:59; ~45 open, 9 exited with -1073740791 = 0xC0000409 crash: t:5, t:13, t:15, t:18, t:21, t:23, t:24, t:26, t:27; t:19 also by 08:10): t:1/t:3/t:6 M2N, t:2 viplatform_2026, t:14 26_dfm, t:4/t:5 surro-ai-suite, t:9/t:10/t:19/t:28–t:31/t:37–t:39/t:45–t:47 agent-cli-hub, t:11/t:12/t:17/t:20/t:22/t:25/t:43/t:44 `.hub-worktrees\task-*`, t:7/t:8/t:16 cmd.exe, t:32 operator folder (UI work), t:33 + t:35 operator (t:33 = older idle copy). Console windows: 2 PowerShell
