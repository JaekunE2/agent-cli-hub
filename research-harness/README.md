# Research Harness — autonomous research director

The user gives an initial research direction, and a **director Claude session** runs the loop
**idea → target venue research → literature/SOTA → plan → experiments → analysis → re-run/re-plan → paper writing → self-review** on its own until the paper is finished.
It manages worker sessions itself, and the user can talk to it at any time.

## How to use (user)
1. Dashboard (`http://127.0.0.1:7777`, or via Tailscale on the phone) → **＋ 새로 열기 → 🔬 연구 디렉터 (자율)**
2. Enter the project name, the initial research direction, and optionally the target venue and approval gates → Open
   → `<repo>\research\<name>\` is created and the director claude (skip-permissions) starts right away.
3. Check progress in the sidebar's **자율 연구** section:
   - phase pipeline, next action, questions / progress reports / journal / plan;
   - talk to it through the message box (delivered immediately if it's idle, otherwise stored in INBOX and handled next turn);
   - **디렉터 화면** = its terminal (you can type into it directly), **일시정지/재개**.
4. From the CLI: `node <repo>\hub\ccd.js research ls|show|msg|pause|resume`

## Structure
```
research-harness/
  config.json            autopilot limits (outside the project → the agent can't relax them)
  template/CLAUDE.md     director/worker operating manual (phases, gates, integrity, environment rules)
  template/.claude/settings.json   project hooks: SessionStart / Stop / StopFailure
  hooks/stop.js          director only: {"decision":"block","reason":…} → "don't stop, do the next step"
  hooks/session-start.js re-injects the state summary on start, resume and compaction
  hooks/stop-failure.js  on a usage limit or API error → status=waiting (the watchdog wakes it)
  lib/project.js         project scaffold, list, and state/INBOX updates
  tools/verify-bib.js    mechanical citation check via Crossref/arXiv/Semantic Scholar (node --use-system-ca)
hub/research.js   API + watchdog (every 60 s)
```
Project: `<repo>\research\<slug>\` = CLAUDE.md + `.claude/settings.json` + `research/`:
- files: state.json, BRIEF, PLAN, JOURNAL, REPORT, QUESTIONS, INBOX, DECISIONS, FAILED;
- folders: ideas, venue, lit, experiments, analysis, paper, reviews, workers.
It's also a git repo (commit per step).

## How it keeps going without the user
| Situation | Handled by |
|---|---|
| Turn ends | Stop hook → block + next instruction (director only; workers and other sessions are left alone) |
| Stop-hook block cap (8 by default) hit / idle | Watchdog: idle for 4 minutes or more → "계속 진행하세요" nudge |
| Experiments/workers to wait for | Director sets `status=waiting, wake_at` → watchdog wakes it at that time |
| Usage limit | StopFailure hook + watchdog → wait until the actual 5-hour/weekly reset time (**no automatic account switching**) |
| Director process dies | Watchdog resumes it with the **same session ID** (max 3 per hour, then blocked) |
| Circling in place | 3 autonomous turns in a row with no state/JOURNAL change → blocked → dashboard shows "확인 필요" |
| Too many turns | Over 40 turns per hour → 20-minute throttle wait |
| New project folder's workspace trust prompt | Answered automatically only for harness-created project folders |

## Design choices (from studying existing systems)
- File + git memory, JSON state, a `FAILED.md` record of failed attempts (Anthropic's long-running harness).
- Phase gates with checkable exit criteria. A separate critic subagent. Pairwise idea ranking (AI co-scientist).
- Citations checked by code; numbers come from results.json via generated tables pulled in with `\input` (fabricated results and citations in AI Scientist).
- Limits live outside the agent's reach (AI Scientist editing its own timeout).
- Reviewer loop using the paper-review / paper-claims / paper-numbers / paper-code skills.

## Verified (2026-09-24, test root `<repo>\research`, removed afterwards)
- Workspace trust answered automatically → kickoff → **the Stop hook ran turns 2 and 3 without user input** → reached `done`, then stopped by itself.
- `waiting`+`wake_at` → the watchdog woke it at the right time → it handled the INBOX message itself.
- Killed the director → the watchdog **resumed the same session ID** → it carried on and finished.

## Limitations / cautions
- A full research run takes a lot of tokens: many turns, subagents, and workers. Keep an eye on "AI 사용량" in the dashboard.
- Experiment and paper quality still need **human review** before submission. By default the harness doesn't do submission, external posting, or Overleaf pushes.
- The watchdog runs only in the main dashboard instance (7777). It starts when the dashboard starts at logon.
