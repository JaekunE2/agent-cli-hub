<!-- agent-cli-hub:begin (managed by {{REPO}}\setup.ps1 — re-run it after moving the folder; uninstall.ps1 removes this block) -->
## Agent CLI Hub (sessions, search, GPU queue)
This PC runs Agent CLI Hub (http://127.0.0.1:7777): it sees every Claude Code / Codex / Cursor session and console window. Drive it with its CLI (the `agent-cli-hub` skill has the details):
```
"{{NODE}}" "{{HUB}}\ccd.js" ls | read <target> | send <target> "text" | wait <target> | new claude|codex --cwd DIR | search "terms" | log <id>
```
- Reading other sessions is fine; sending input to a session the user is working in needs their OK. Never type into your own session.
- Account switching (`ccd switch`) only when the user asks for it.
- Facts about this PC (GPUs, network, disks, tools, where things live) are in `{{REPO}}\operator\ENVIRONMENT.md`, kept up to date by the hub's operator session. Hub notices (maintenance, full disks, network changes): `"{{NODE}}" "{{HUB}}\ccd.js" notices`.

## GPU jobs go through the queue
GPUs on this PC are shared by several sessions and jobs. Run anything that uses the GPU through the queue:
```
"{{NODE}}" "{{HUB}}\ccd.js" gpu run --mem <peak, e.g. 12G> --est <expected time, e.g. 90m> --label <short name> -- <command>
```
- It waits its turn → runs with `CUDA_VISIBLE_DEVICES` set → releases when it ends. `--exclusive` for the whole GPU; `--ram <peak>` for jobs that load lots of data into RAM.
- Status: `"{{NODE}}" "{{HUB}}\ccd.js" gpu`. Short checks (nvidia-smi, import tests) don't need the queue.
- Never kill or interrupt anything already running on the GPU. If it's busy, wait in the queue.
<!-- agent-cli-hub:end -->
