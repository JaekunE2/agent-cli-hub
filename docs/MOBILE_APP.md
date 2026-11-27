# The hub on a phone

**Web first.** Everything a phone needs from the hub works in the phone's browser and can be installed to the
home screen as a web app (PWA). A native Android app is optional and only adds what a browser cannot do.

## 1. Reaching the hub: Tailscale (core) or a custom relay (add-on)

The hub listens on `127.0.0.1` and, with `"remote": "tailscale"` (default), also on this PC's Tailscale
addresses (100.64.0.0/10). Every request still needs the hub token (`?t=<token>` once; the page keeps it).

| way | URL on the phone | HTTPS | notes |
|---|---|---|---|
| Tailscale address | `http://100.x.y.z:7777/?t=…` | no | works at once; no install, no share target, no notifications |
| **Tailscale Serve** (recommended) | `https://<machine>.<tailnet>.ts.net/?t=…` | yes (Let's Encrypt via Tailscale) | `tailscale serve --bg 7777` on the hub PC; enables the installable app, share target and notifications |
| custom relay (add-on) | the relay's HTTPS URL | yes | any reverse proxy / tunnel you run; put its URL in config `remoteUrls` (or `homelink.url`) so it appears first in the QR panel |

The remote panel (QR) lists `remoteUrls`, then the Tailscale names and addresses. Behind Serve or a relay the
requests arrive from loopback with the public host name; the token check and the Origin check still apply.

## 2. The mobile web app (core)

Provided by the hub core plus the `mobile-web` plugin (`hub/plugins/mobile-web`):

| feature | how | needs HTTPS |
|---|---|---|
| sessions, terminals, chat, search, GPU, calendar, drives, call digest | the normal hub page (responsive layout) | no |
| install to home screen | `manifest.json` (standalone, id/scope `/`) | yes |
| share to the hub (Android share menu: files, text, links) | `share_target` → service worker keeps the items → `/?open=share` → upload to the hub PC or as a call recording | yes |
| upload files from the phone | file pickers (`/api/upload`, call digest `/api/calls/upload`) | no |
| notifications (turn finished, limits) | page notifications; on Android routed through the service worker | yes, page open or recently open |
| background push (page closed) | **not yet**: needs Web Push (VAPID keys + a subscription store in the hub); see §5 | yes |

Endpoints the phone uses are the normal hub API under the token: `/api/overview`, `/api/term/*` + `/ws/term`
(WebSocket; an HTTP polling fallback exists for proxies that drop WebSockets), `/api/upload`, `/api/calls/*`,
`/api/netdrive/*` (drives plugin), `/app-<id>/<token>/` (web-apps plugin). Loopback-only extras (for example the
Delta Hub relay port) are not meant for phones.

## 3. Native Android app (optional add-ons)

Only for what the web cannot do:

| add-on | why native |
|---|---|
| background sync of the phone's call-recorder folder | needs persistent folder access (Storage Access Framework) and a scheduled job while no page is open |
| persistent notifications / always-on connection | foreground service; Web Push covers most of it once implemented |
| custom tunnel / relay client (e.g. end-to-end encrypted links to other machines) | sockets, keys in the Android Keystore |
| page bridges (`window.HL…` objects for pages that need native calls) | JavaScript interfaces of a WebView |

### Current app (reviewed, not changed)

A personal Android app already exists (Java, minSdk 28, WebView + foreground service, own relay protocol, call
recording sync with SAF + JobScheduler, self-update through its relay). Findings:

- **Mixes core and site-specific parts in one build**: relay host baked into `build.gradle` (`hlRelayHost` default),
  a provisioning file (device key + hub token) baked into a personal APK, drive and LLM bridges for one setup.
- **Call recording sync** is self-contained (`CallRecordings` file-name parser with tests, `CallSync`,
  `CallSyncJob`) and uploads to a drive folder `<root>/<date>/<file>` + `<file>.json` — the same layout the
  call-digest plugin reads.
- Release builds trust only system CAs (good); debug builds trust user CAs.

### Proposed split (changes listed, not applied)

1. **Core companion app** (generic, publishable): a WebView shell that opens a hub URL entered by the user or read
   from the hub's QR code (`https://<machine>.<tailnet>.ts.net/?t=…` or any relay URL) — no baked host. Stores the
   URL + token in the Android Keystore. Adds: share target → `/api/upload`, notification channel.
2. **Add-on modules** (Gradle product flavors or optional modules, enabled per build):
   - `callsync`: recorder-folder sync. Make the target configurable: hub endpoint `POST /api/calls/upload?date=&name=`
     (works for every hub user) or a drive folder (current behaviour).
   - `relay`: the existing custom tunnel/relay client (keeps its own keys and provisioning, private builds only).
   - `bridges`: page bridges for specific web apps.
3. Concrete edits for the existing project:
   - `build.gradle`: no default relay host; require `-PhlRelayHost` for relay builds, none for the core flavor.
   - `CallSync`: add the hub upload target (`POST` of the file body, token header).
   - provisioning: keep personal APKs out of any repository and release channel (already the case); document it.
   - CI: GitHub Actions `assembleDebug` + unit tests for the core flavor only (no keystore, no provisioning);
     signed releases built locally.

### Where should the Android code live?

Recommendation: **keep the existing app in its own repository for now**, and later add a small generic
companion app to this repository as `mobile/android` (core flavor only) once §3.1 exists. Reasons: the current
app embeds a private relay protocol and personal provisioning; the hub repository should only contain parts that
any user can build and point at their own hub. Add-ons stay in the private app (or become flavors there).

## 4. Call recordings from a phone without the native app

- Hub page → 📞 Call digest → **upload** (file picker, works in any phone browser).
- Installed web app over HTTPS → share recordings from the recorder app → **upload as call recording**.
- Both store the file under the call digest's source folder `<date>/<file>`; the next run transcribes it.

## 5. Next steps

1. Web Push: VAPID key pair in the secrets folder, `/api/push/subscribe` (store subscriptions per device),
   send on turn completion / limits / approvals; the service worker shows them. Works over Tailscale Serve.
2. Small offline page in the service worker ("hub unreachable") — no caching of live data.
3. Companion app core flavor (§3.1) with the QR-code pairing above.
