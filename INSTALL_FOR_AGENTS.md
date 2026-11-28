# Installing Agent CLI Hub — instructions for an AI agent

You are an AI coding agent (Claude Code, Codex, …) asked by the user to install Agent CLI Hub on this Windows PC. Follow these steps in order and report back briefly. Ask the user before anything marked **(ask)**.

## 1. Check the machine
- Windows 10/11 (`[Environment]::OSVersion`). Other OSes are not supported — stop and tell the user.
- Node.js 20+: `node -v`. If missing or older, **(ask)** and then `winget install OpenJS.NodeJS.LTS` (open a new shell afterwards so `node` is on PATH).
- Which agent CLIs exist: `where claude`, `where codex`, `where cursor-agent`. At least one is needed; if none, tell the user how to get one (Claude Code: https://docs.claude.com/claude-code · Codex: `npm i -g @openai/codex`) — **(ask)** before installing.
- Optional: `where python` (lets the hub show console windows it didn't open), `nvidia-smi` (GPU queue), `tailscale status` (phone access).

## 2. Get the code
**(ask)** where to put it if the user has a preferred tools folder; otherwise use `%USERPROFILE%\agent-cli-hub`.
```powershell
git clone https://github.com/JaekunE2/agent-cli-hub "$env:USERPROFILE\agent-cli-hub"
```
Without git: download https://github.com/JaekunE2/agent-cli-hub/archive/refs/heads/main.zip, `Expand-Archive` it, and use the `agent-cli-hub-main` folder inside.

## 3. Language and options
Create `<dir>\hub\config.json` only for what differs from the defaults (see `hub\config.example.json`):
- `"lang": "en"` or `"ko"` — default follows the Windows display language; set it to the language the user writes to you in.
- The operator session starts with the hub (Claude Code). If only Codex is installed, set `"operator": { "agent": "codex" }`.

## 4. Start and verify
```powershell
& "<dir>\start.bat"            # npm install on first run, installs the agent skill + guidance, starts the hub, opens the browser
node "<dir>\hub\ccd.js" ls     # lists sessions; the operator appears as a hub terminal
node "<dir>\hub\ccd.js" url    # the address to give the user
```
`start.bat` also adds a short guidance block to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` (between `agent-cli-hub` markers) and installs the `agent-cli-hub` skill — tell the user this happened.

### Optional Windows desktop launcher (v1.3.0)

1. Prepare the existing `hub` checkout and its dependencies as above. The launcher starts the hub using system Node.js with `--use-system-ca`. Use Node.js 24 on `PATH` and the Microsoft Edge WebView2 Runtime. The installers can download the WebView2 bootstrapper when the runtime is missing.
2. Set `CCD_HUB_DIR` in the Windows user environment so Start menu launches can locate the existing `hub` directory. Replace the example path below with the absolute path to your `hub` directory.

   ```powershell
   [Environment]::SetEnvironmentVariable('CCD_HUB_DIR', 'D:\개발 도구\agent-cli-hub\hub', 'User')
   ```

3. Install one of the MSI or NSIS packages and launch **Agent CLI Hub** from the Start menu. The launcher uses the existing Hub and PTY host. Closing the window hides it in the tray. The existing `start.bat` and `install-autostart.ps1` still control the command-line setup and logon startup.

To build both installers, run `cargo tauri build` from `desktop` on Windows. The x64 release executable is under `desktop/target/release`, with installers under `bundle/msi` and `bundle/nsis`. The packages contain the launcher and installer components. The existing checkout holds the Hub files and user data. [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/)

## 5. Optional, **(ask)** first
- Start at logon: `powershell -ExecutionPolicy Bypass -File "<dir>\install-autostart.ps1"`
- Phone access: install Tailscale on the PC and the phone with the same account, then the 📱 button in the hub shows a QR code.
- Telegram relay (talk to Claude Code sessions from Telegram) is a separate project: https://github.com/JaekunE2/claude-telegram-relay — follow its README. The user pastes the BotFather token into its setup window, never into this chat.

## 6. Report to the user
The hub address, where it is installed, which agent CLIs it found, that the operator session is running (it will write `operator\ENVIRONMENT.md`), and how to stop (`stop.bat`) or remove it (`uninstall.ps1`, then delete the folder).
