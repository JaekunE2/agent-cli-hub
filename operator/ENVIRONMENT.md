# ENVIRONMENT — this PC (Agent CLI Hub)

Maintained by the operator session. Facts only; dated per section. Last full check: **2026-11-22 20:40 KST** · last periodic check: **2026-11-23 19:04 KST**.

## Machine — 2026-11-22
- CPU: Intel Core i5-12400F · RAM: 15.9 GB (13–14.9 GB in use across checks; 2026-11-23 19:04 only ~1.0 GB free; ~20 duplicate sequential-thinking MCP node processes from Claude sessions add to it — use `--ram` for data-heavy jobs)
- OS: Windows 11 Pro 10.0.26200
- WSL2: `Ubuntu-22.04` (default), `docker-desktop` — both stopped at check time

## GPUs — 2026-11-22
- `local:0` NVIDIA GeForce RTX 3060, **12 GB**, driver 610.88, CUDA (driver) 13.3
- At check: 1.4–1.6 GB used, 41 °C, queue empty (0 active / 0 waiting)
- Only one GPU → every GPU job goes through `ccd gpu run --mem … --est … --label … -- <cmd>`

## Network — 2026-11-22
- LAN (이더넷): `10.10.10.106/16`
- Tailscale: `100.95.43.91` (host `km-office`), connected. Peers: `km-home` (offline since ~2026-11-23 01:30), `km-notebook` (online, idle), `lumisys` (offline 27 d)
- Proxy: none (WinHTTP direct; HTTP(S)_PROXY not set)
- Hyper-V vSwitches: WSL `192.168.128.1/20`, Default Switch `172.25.176.1/20`

## Disks — 2026-11-22
| Drive | Used | Free | Free % |
|---|---|---|---|
| C: | 255.3 GB | 29.1 GB | **10.2 %** (2026-11-23 19:04; low point 9.8 % 17:02–18:45) |
| D: | 479.3 GB | 188.5 GB | 28.2 % |
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

## Accounts — 2026-11-23 17:45 (usage at check time)
- Claude Code (Max 20x): weekly **53 % (Fable 57 %)**, resets in ~3 d 6 h (was 30 % at 04:25; usage query was HTTP 429 15:09–17:36)
- Codex — ChatGPT Pro (primary login on this PC): weekly 3 %
- Codex — second Pro login: weekly 55 %, resets in ~2 d 21 h
- Codex — Plus login: 5 h 0 % (hit 100 % ~17:20, reset 17:42), weekly 33 %
- Antigravity (agy): Gemini 5 h 16 %, weekly 27 %; Claude/GPT 0 %
- Google API key: valid (quota not queryable)

## Conventions — 2026-11-22
- Hub: http://127.0.0.1:7777 (server was briefly down ~18:45 2026-11-23 during hub dev/tests; `ptyhost.js` kept terminals alive) · CLI `node D:\Gitsource\개인\agent-cli-hub\hub\ccd.js`
- GPU work only through the queue (`ccd gpu run`); never kill another job
- Notices board: `ccd notices`
- Hub terminals (2026-11-23 17:02): t:1/t:4/t:15 M2N, t:2 viplatform_2026, t:3 26_dfm (t:14 26_dfm codex exited 1), t:5/t:9 surro-ai-suite (t:10 exited 1), t:6/t:12/t:16 agent-cli-hub, t:17 cmd (agent-cli-hub\projects\포켓몬-도감-테스트), t:8 + t:11 operator (t:8 = older idle copy of this operator session)
