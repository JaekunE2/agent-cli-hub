---
name: agent-cli-hub
description: Drive Agent CLI Hub (the local web hub at http://127.0.0.1:7777 that sees every Claude Code, Codex and Cursor agent session and console window on this PC) from the command line. Use it to check what other sessions are doing, read their screens, send a prompt or keys to another session and wait for it to finish, open new claude / codex / shell terminals, search every past Claude Code and Codex conversation, read transcripts, and run GPU jobs through the shared GPU queue. Triggers: "what are the other sessions doing", "send this to that window", "start a new session and have it do X", "find the conversation where we did X", "split this across several sessions", "is the GPU free", "run this training job".
---

# Agent CLI Hub (ccd)

This PC runs Agent CLI Hub, a local server ({{HUB}}, http://127.0.0.1:7777) that sees every Claude Code / Codex / Cursor agent session and console window. As an agent, **drive it with the `ccd` CLI, not the web page**:

```
"{{NODE}}" "{{HUB}}\ccd.js" <command> ...
```
Every command starts the server if it is down. Run it with no arguments for the full help.

## Commands

| Goal | Command |
|---|---|
| List sessions, windows, terminals (yours is marked `<- YOU`) | `ccd ls` (`--all` adds hidden consoles, `--json`) |
| Read a screen | `ccd read <target> [-n 60]` |
| Send a prompt (typed, then Enter separately) | `ccd send <target> "text"` (`--no-enter` types only) |
| Send keys | `ccd keys <target> esc` / `enter` `up` `down` `tab` `ctrl+c` `shift+tab` (t: only) |
| Wait until a Claude **or Codex** turn ends, then print the screen | `ccd wait <target> [--timeout 900] [-n 40]` |
| New terminal | `ccd new claude --cwd DIR [--resume ID] [--no-skip-permissions] [--title T]` · `ccd new codex --cwd DIR [--resume ID] [--model M]` · `ccd new powershell --cwd DIR` |
| Close a hub terminal | `ccd close t:<id>` |
| Search every Claude Code and Codex conversation + open screens | `ccd search "term1 term2" [--agent claude\|codex] [--role user\|assistant] [--cwd part] [--auto]` |
| Read a transcript (Claude or Codex; jump to a hit) | `ccd log <session-id-prefix> [--at N] [-n 30]` |
| AI account usage (Claude 5h/weekly %, Codex, Cursor …) | `ccd usage` |
| Your other accounts and their headroom | `ccd accounts [session]` · Codex logins: `ccd codex ls` |
| Continue a session on another of your accounts | `ccd switch <session\|target> [--account auto\|ID]` (works for codex terminals too) |
| Second opinion from GPT (Codex CLI, read-only) | `ccd gpt "prompt" [--file a,b] [--image x.png] [--cd DIR]` |
| Autonomous research projects | `ccd research ls \| show <slug> \| msg <slug> <text> \| pause <slug> \| resume <slug>` |
| GPU status and queue | `ccd gpu` · plan: `ccd gpu plan --mem 12G --est 90m` |
| **Run a GPU job through the queue** | `ccd gpu run --mem 12G [--ram 40G] --est 90m --label <name> -- <command>` → waits its turn, runs with CUDA_VISIBLE_DEVICES set, releases when it ends (`--exclusive` = whole GPU) |
| Register an output (video, PDF, figure) on your session's "Outputs" tab | `ccd artifact add <path> [--title T]` |
| Browser URL for the user | `ccd url` |

**`<target>`**: `t:<id>` a hub terminal (exact screen, real keys) · `c:<pid>` an existing console window · a session-id prefix, a session name, or part of a window title.

## Workflows

**Hand work to a new session**
```
ccd new claude --cwd C:\path\to\project --title worker-1   # prints t:<id>, then READY or READY-BLOCKED
ccd send t:<id> "task description..."
ccd wait t:<id> --timeout 1800 -n 60
ccd log <that session's id> -n 10
```
Codex works the same way: `ccd new codex --cwd …`, then `send` / `wait` / `log`.

**Continue an old conversation in place**: `ccd new claude --resume <id>` or `ccd new codex --resume <id>` (the hub opens it in the conversation's own folder). `ccd search <id prefix>` finds it.

**Search old work**: `ccd search "vcvars gsplat"` lists hits per session as `@N`; `ccd log <id> --at N` shows the messages around it.

## Rules

1. **Never type into your own session.** `send`/`keys` refuse the target marked `<- YOU`.
2. **Touching another session needs the user's OK.** Reading (`ls`, `read`, `search`, `log`, `wait`) is always fine. Sending input to a session the user was working in can interrupt them — ask first unless they asked for it. Terminals you opened yourself for the task are yours to drive.
3. **Don't answer prompts on the user's behalf** (folder trust, permission menus, logins): read them and ask the user.
4. **Account switching is user-triggered only.** Run `ccd switch` only when the user asks. Don't rotate accounts because a limit was hit — report it instead ("5h limit hit, resets at …").
5. **GPU jobs go through `ccd gpu run`.** Never kill or interrupt processes you didn't start.
6. `ccd close` only for terminals you created, once they're done. Don't share the URL or token (`.token`, `url.txt`).
