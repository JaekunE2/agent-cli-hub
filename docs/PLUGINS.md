# Hub plugins and App Store add-ons

The hub's core stays generic. Optional features — anything tied to one site, one organization or one
machine — live in plugin folders that the hub loads at start. The core carries a small plugin host and a few
named hook points; it never needs to be patched for a plugin.

> Not to be confused with the hub's **Apps** (`ccd app`, `/api/apps`): those are user apps (reports, commands,
> pipelines) that run inside the hub. **Plugins** extend the hub itself. An App Store app may carry a plugin.

## Layout

```
hub/plugins.js              plugin host (server + ccd side)
hub/public/plugin-host.js   browser side: registry, sidebar entries, views, fault isolation
hub/instance.js             which side effects this hub process may have (main hub = port 7777)
hub/plugins/<id>/           plugins shipped with the repo (none yet; generic, off until configured)
hub/local/plugins/<id>/     machine-local plugins (gitignored; App Store apps install theirs here);
                            a local plugin with the same id wins
```

A plugin folder has a `plugin.json` and any of:

| file | what it does |
|---|---|
| `server.js` | `module.exports = (api) => ({ enabled, handlePage, handleApi, overview, start, stop, hooks })` |
| `cli.js` | `module.exports = (ctx) => ({ commands: { name: async () => {} }, hooks })` — new `ccd` commands |
| `*.js` / `*.css` listed in `scripts` / `styles` | loaded into the hub page after `plugin-host.js`; they call `HubPlugins.register({ id, nav, views, open })` |
| files listed in `assets` | served at `/plugins/<id>/<file>` |

`plugin.json` keys: `id`, `name`, `description`, `apiVersion`, `requires`, `server`, `cli`, `commands`, `legacyApi`,
`scripts`, `styles`, `assets`, `valueFlags` (ccd flags that take a value), `help` (lines added to `ccd help`),
`provides`, `routes` (documentation shown on the store page).

`server.js` gets `api = { id, dir, hub, config, settings, instance, baseDir, dataDir, secretsDir, log, apiVersion, routeBase }`.
Plugins must respect `api.instance` (`instance.js`): a side instance (any port other than 7777, e.g. a test copy
next to the live hub) must not start background work, write shared files or launch anything.

## Apps from the App Store, and the plugins they carry

An app's `app.json` may name a `hubPlugin` folder inside its package. On install the store copies it to
`hub/local/plugins/<plugin id>/` (marked with `.store-app` = the owning app id; a folder it does not own is never
overwritten) and writes `settings.json` next to it from the app's install settings; uninstalling the app removes
it. Plugins load at hub start, so the store asks for a restart.

- `api.settings` (server) / `ctx.settings` (cli) = that `settings.json` (empty for plugins shipped in the repo).
- `plugin.json` `"provides": { "researchHarness": "${HARNESS_DIR}" }` declares a hub-wide value from the settings;
  `require('./plugins').provided(key)` reads it (`harness.js` uses it after env `CCD_HARNESS` and config `researchHarness`).

Store sources (`hub/app-store-local.js`): a GitHub owner or repo, a **registry** catalog URL
(`https://…/catalog.json`), or a local catalog file / folder (`D:\apps\catalog.json`, `file:///…`, a folder with
`app.json`) for testing unpublished apps. Registry entries point at each author's repository; GitHub ones install
from the latest release ZIP (checked against GitHub's SHA-256 and the registry's `sha256`), local ones are copied and
hashed. App settings (`app.json` `settings`) are filled in at install time, stored in the hub's app registry only,
and passed to the app's commands as environment variables together with `HUB_DIR`, `HUB_NODE`, `HUB_APP_ID`,
`HUB_APP_DIR`; `entryUrl` may use `{{SETTING}}`. Lifecycle scripts: `setup.ps1` (install / update), `stop.ps1`
(before an update), `uninstall.ps1` (before removal). The store view (`public/app-store-ui.js`) has Browse / app
page / My apps / Register.

Every store app is an add-on for this hub (CCD): `app.json` `"requires": { "ccd": ">=1.0.0", "plugins": ["some-plugin"] }`
is checked against `hub/package.json` and the installed plugins; apps that do not fit are hidden in the store and
refused by the install API. `ccd apps ls|search|info|install|update|remove|open|sources|source` drives the store from
a terminal (`--set KEY=VALUE` for settings, `remove --purge-data` also deletes the plugin's data folder).

## Plugin API v1 (App Store plugins)

A plugin that comes with an App Store app must declare `"apiVersion": 1` (and `"requires": { "ccd": ">=1.0.0" }`) in
`plugin.json`; the store refuses to install one that does not, and the loader (`plugins.js`) refuses one whose API
version or CCD range this hub does not support, with the reason in `/api/plugins` and the server log. A v1 plugin
may use exactly these hook points — nothing else of the core, and it never edits or patches core files or modules:

| hook point | v1 rule |
|---|---|
| server routes | `handleApi` sees only `/api/plugins/<id>/…` (`api.routeBase`); `handlePage` only `/plugins/<id>/…`. It cannot shadow a core or other plugin route. |
| legacy routes | `"legacyApi": ["/api/old"]` keeps an old prefix working for one minor version: rewritten into the namespace, logged as deprecated; refused when the core reserves it (`/api/apps`, `/api/drive`, `/api/sessions`, …) or another plugin already claimed it |
| nav / views | browser `scripts` call `HubPlugins.register({ id: '<id>', … })` (fault-isolated in `plugin-host.js`) |
| CSS | every selector starts with `.<id>`, `#<id>` or `[data-plugin="<id>"]` (contract test) |
| ccd | `ccd <id> …`, plus aliases listed in `"commands"`; a core command or another plugin's name is refused |
| hooks | only `remoteUrls`, `calendarSources`, `gpuRunCheck`, `gpuRunRemote`, `gptFallback`; others are dropped with a warning |
| overview | keys another plugin already uses are dropped with a warning |
| settings | `api.settings` / `ctx.settings` from its app's install settings; keys belong to the app (`app.json settings`) |
| data | `api.dataDir` = `hub/data/plugins/<id>`; uninstall keeps it unless `?purgeData=1` |
| i18n | its own `i18n/en.json` (Korean → English) applies to its browser files only |
| lifecycle | app `setup.ps1` (install / upgrade), `start` / `stop` actions, `stop.ps1` before an upgrade, `uninstall.ps1`; server `start()` / `stop()`; `app.json renamedSettings` migrates settings on upgrade |

Faults are contained: a plugin that throws while loading is not loaded and is reported; one whose routes throw 3 times
is switched off until the next start; the hub keeps running. Plugins without `apiVersion` (shipped in the repo or
machine-local) keep the earlier, unrestricted behaviour. When a hook point changes, the old form keeps working for one
minor version with a deprecation warning before it is removed.

Contract test (every App Store plugin must pass): `CCD_APP_DIRS="D:\src\app-a;D:\src\app-b" node --test tests/plugin-api.test.js`
— loads each plugin in a side-instance hub with settings from its `app.json`, checks it answers its own routes and
none of the core's (Apps / App Store included), keeps its commands in its namespace, registers its browser files under
its id with scoped CSS and English text, and leaves no timers after `stop()`; then loads all of them together.

## Hooks the core calls

| hook | where | contract |
|---|---|---|
| `handlePage(p, url, req, res, send)` | server, before the token check | non-`/api` paths (pages, proxies) — check the token yourself |
| `handleApi(p, url, req, res, body, send)` | server, after the token check | `/api/*` routes; return `true` when handled |
| `overview()` | `/api/overview` → `state` in the page | small object of fields for the UI (keep keys unique) |
| `start()` / `stop()` | server start | background work (main hub only, check `api.instance`) |
| `hooks.remoteUrls()` | remote-access panel / QR | extra URLs that reach this hub (e.g. an HTTPS relay) |
| `hooks.calendarSources()` | calendar | `{ id, label, cls, events(), status(), refresh(), maybeRefresh() }` read-only event source (shown only, never pushed to Google) |
| cli `hooks.gpuRunCheck()` | `ccd gpu run`, before queuing | adjust placement (`ctx.flags`) or refuse with `ctx.die()` |
| cli `hooks.gpuRunRemote(grant, host)` | `ccd gpu run`, grant not on this PC | run the job on that server |
| cli `hooks.gptFallback(...)` | between plugins (`ctx.hook('gptFallback')`) | lets one plugin offer an answer path another plugin's command falls back to |

Site- or organization-specific features (single-sign-on portals, chat bots, internal drives, relays, …) are not part
of this repository: they ship as App Store apps with a v1 plugin, or as machine-local plugins in `hub/local/plugins/`.
