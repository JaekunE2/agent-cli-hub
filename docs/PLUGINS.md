# Plugins ("apps") on top of Agent CLI Hub

This branch keeps site-specific features out of the hub's core files. Each feature is a plugin folder;
the core only carries a small plugin host plus a few generic hooks. Updating to a new upstream version
then touches as few upstream files as possible.

> Not to be confused with the hub's **Apps** feature (`ccd app`, `/api/apps`): those are user apps
> (reports, commands, pipelines) that run inside the hub. Plugins described here extend the hub itself.

## Layout

```
hub/plugins.js              plugin host (server + ccd side)
hub/public/plugin-host.js   browser side: registry, sidebar entries, views, fault isolation
hub/instance.js             which side effects this hub process may have (main hub = port 7777)
hub/plugins/<id>/           plugins shipped with the repo — generic, off until configured
hub/local/plugins/<id>/     machine-local plugins (gitignored); a local plugin with the same id wins
hub/config.json             all hosts, accounts, folders and switches (gitignored; see config.example.json)
```

A plugin folder has a `plugin.json` and any of:

| file | what it does |
|---|---|
| `server.js` | `module.exports = (api) => ({ enabled, handlePage, handleApi, overview, start, stop, hooks })` |
| `cli.js` | `module.exports = (ctx) => ({ commands: { name: async () => {} }, hooks })` — new `ccd` commands; a command with a core name replaces the core one |
| `*.js` / `*.css` listed in `scripts` / `styles` | loaded into the hub page after `plugin-host.js`; they call `HubPlugins.register({ id, nav, views, open })` |
| files listed in `assets` | served at `/plugins/<id>/<file>` |

`plugin.json` keys: `id`, `name`, `description`, `server`, `cli`, `scripts`, `styles`, `assets`,
`valueFlags` (ccd flags that take a value), `help` (lines added to `ccd help`).

`server.js` gets `api = { id, dir, hub, config, instance, baseDir, dataDir, secretsDir, log }`.
Plugins must respect `api.instance` (see `instance.js`): a side instance (any port other than 7777, e.g. a
test copy next to the live hub) must not start background work, write shared files or launch anything.

## Apps from the App Store, and plugins they carry

**Apps** (Apps view, `/api/apps`, upstream's App Store) are things the user installs and runs: a folder with `app.json`,
actions, settings. **Plugins** extend the hub itself. The two meet in one generic way: an app's `app.json` may name a
`hubPlugin` folder inside its package. On install the store copies it to `hub/local/plugins/<plugin id>/` (marked
with `.store-app` = the owning app id, never overwriting a folder it does not own) and writes `settings.json` next to
it from the app's install settings; uninstalling the app removes it. Plugins load at hub start, so the store asks
for a restart.

- `api.settings` (server) / `ctx.settings` (cli) = that `settings.json` (empty for plugins shipped in the repo).
- `plugin.json` `"provides": { "researchHarness": "${HARNESS_DIR}" }` declares a hub-wide value from the settings;
  `require('./plugins').provided(key)` reads it (`harness.js` uses it after env `CCD_HARNESS` and config `researchHarness`).
- `plugin.json` `"routes": [...]` is documentation shown on the store page ("what this app adds").

Store sources (`hub/app-store-local.js`): a GitHub owner or repo (upstream), a **registry** catalog URL
(`https://…/catalog.json`), or a local catalog file / folder (`D:\apps\catalog.json`, `file:///…`, a folder with
`app.json`) for testing unpublished apps. Registry entries point at each author's repository; GitHub ones install
from the latest release ZIP (checked against GitHub's SHA-256 and the registry's `sha256`), local ones are copied and
hashed. App settings (`app.json` `settings`) are filled in at install time, stored in the hub's app registry only,
and passed to the app's commands as environment variables together with `HUB_DIR`, `HUB_APP_ID`, `HUB_APP_DIR`;
`entryUrl` may use `{{SETTING}}`. Lifecycle scripts: `setup.ps1` (install / update), `stop.ps1` (before an update),
`uninstall.ps1` (before removal). The store view (`public/app-store-ui.js`) has Browse / app page / My apps / Register.

Every store app is an add-on for this hub (CCD): `app.json` `"requires": { "ccd": ">=1.0.0", "plugins": ["web-apps"] }`
is checked against `hub/package.json` and the installed plugins; apps that do not fit are hidden in the store and
refused by the install API. Store web apps (`type: "url"`, loopback `entryUrl`) are served by the `web-apps` plugin
under the hub's URL and token (`/app-<id>/<token>/`, also a sidebar entry); opening one that is stopped makes the
main hub run its `start` action. Apps reach the hub's services through the environment (`HUB_DIR`, `HUB_NODE`:
`ccd gpu run`, `ccd llm`, `ccd gpt`), and `ccd apps ls|search|info|install|update|remove|open|sources|source` drives
the store from a terminal (`--set KEY=VALUE` for settings).

## Hooks the core calls

| hook | where | contract |
|---|---|---|
| `handlePage(p, url, req, res, send)` | server, before the token check | non-`/api` paths (pages, proxies) — check the token yourself |
| `handleApi(p, url, req, res, body, send)` | server, after the token check | `/api/*` routes; return `true` when handled |
| `overview()` | `/api/overview` → `state` in the page | small object of fields for the UI (keep keys unique) |
| `start()` / `stop()` | server start | background work (main hub only, check `api.instance`) |
| `hooks.remoteUrls()` | remote-access panel / QR | extra URLs that reach this hub (e.g. an HTTPS relay) |
| `hooks.calendarSources()` | calendar | `{ id, label, cls, events(), status(), refresh(), maybeRefresh() }` read-only event source |
| cli `hooks.gpuRunCheck()` | `ccd gpu run`, before queuing | adjust placement (`ctx.flags`) or refuse with `ctx.die()` |
| cli `hooks.gpuRunRemote(grant, host)` | `ccd gpu run`, grant not on this PC | run the job on that server |
| cli `hooks.gptFallback(why, { prompt, cfg })` | `ccd gpt` (gpt-rotation plugin) | answer when every local login is at its limit |

## Shipped plugins

| plugin | turned on by (config.json) | provides |
|---|---|---|
| `drives` | `driveUrl`, `drives` | drive file servers in the hub, `/api/netdrive/*`, `ccd drive` |
| `web-apps` | `webApps` (legacy `apps` list), `homelink.url` | local web apps at `/app-<id>/<token>/`, relay URL in the remote panel |
| `delta-hub` | `delta: { portal, hub }` | Delta Hub login / view / relay, `ccd delta`, gpt fallback |
| `remote-gpu` | `gpu.servers`, `nasMirror`, `gpu.blockLocalLlm` | `gpu run --gpu <server>` (ssh / Slurm, `--sync --fetch --stage --env`), `ccd nas` |
| `llm` | `llm.url` | `ccd llm`, `ccd llm agent` |
| `gpt-rotation` | (always; uses `ccd codex` logins) | `ccd gpt` across logins, then a fallback plugin |
| `dooray` | `dooray: { base }` | read-only Dooray calendars in the calendar |
| `telegram` | `<secretsDir>/ccd-telegram.json` | `bridge.js` (its own process, main hub only) |
| `call-digest` | `callDigest` | phone call recordings → transcripts → daily summaries |
| `mobile-web` | (on unless `mobileWeb: false`), `remoteUrls` | installable hub over HTTPS: service worker, share target, phone uploads |
| `hub-cleanup` | `hubCleanup` | duplicates / old versions / caches → per-drive 2-stage trash, approvals before deleting |

Machine-local plugins (e.g. workflow jobs tied to one site) go to `hub/local/plugins/` and never reach git.

Plugins with periodic work (call-digest, hub-cleanup, dooray) keep their own timer on the main hub. The hub's
schedules feature (`ccd schedule`) starts agent CLIs with a prompt; it is not used for plain background jobs.

## Core patches that are not plugins

Small, generic changes to upstream files, each a candidate for an upstream pull request:

- `instance.js` + switches in `server.js`, `term-manager.js`, `gpu.js`, `calendar.js` — side instances stay passive
- `plugins.js` wiring in `server.js`, `ccd.js` (≈15 lines), `routes-sessions.js` (overview), `public/index.html`, `app-core.js`
- `calendar.js` `sources` option (calendar plugins)
- `harness.js` — research harness location from config (`researchHarness`)
- stability / speed: pty host wait, bulk transcript folders skipped, stale session records, folder-inspection memo,
  review-gate cache, session list reuse
- account switching: PC login changed after a process started, weekly-only meters, codex auto-switch at the limit
- `gpu.js`: unified-memory and display reserves, probe errors, NVML row filter, read-only mode
- Antigravity support off unless `"antigravity": true`

## Updating to a new upstream version

```
git fetch origin
git branch my-branch-backup-$(date +%Y%m%d) my-branch           # keep the old state (my-branch = your branch on top of upstream)
git rebase origin/dev_side my-branch                           # or: git merge origin/dev_side
#   conflicts are expected only in the core patch files listed above
cd hub && npm ci                                               # only if package.json / package-lock.json changed
npm test                                                       # compare failures with the upstream tip
for f in *.js public/*.js plugins/*/*.js; do node --check "$f"; done
CCD_PORT=7787 CCD_PTY_PORT=7789 node ccd.js up                 # try it as a side instance first
#   open http://127.0.0.1:7787, check the plugin views, then restart the main hub (7777) when it is idle
```

Before restarting the main hub: `ccd restart` refuses while GPU jobs run inside hub terminals
(`--kill-gpu-jobs` only with explicit approval). Check `ccd ls` and pause research projects first.
