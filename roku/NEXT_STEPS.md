# Roku channel — status & pick-up notes

A place to resume from. The Roku app is **written and committed** on branch
`claude/roku-app-plan-7tu9w3`; what's left is on-device testing, artwork, and tuning.

## Where things stand

- **Built:** a native Roku channel at `roku/` (SceneGraph/BrightScript) that behaves like the
  Apple TV app but uses standard Roku controls (`RowList`, `MarkupGrid`, `Keyboard`,
  `ButtonGroup`, `Dialog`, `BusySpinner`) with Roku-idiomatic navigation.
- **Feature scope:** full parity with the current tvOS app — sign in, browse Trending + members +
  the four lists + detail + search, plus add / move / archive / restore and delete account.
- **Backend change (in this branch):** added `roku` to `KNOWN_PLATFORMS` in
  `functions/_shared/platform.js` so Roku sessions get recorded. Deploys automatically on the next
  merge to `main`; no migration.
- **Docs updated:** `README.md`, `docs/ARCHITECTURE.md` (Native clients + platform value),
  `public/whats-new.json` (coming-soon entry), and `roku/README.md`.
- **NOT done:** never compiled or run — Roku SceneGraph has no simulator, so it needs a real
  device. Not merged. No PR opened. No placeholder artwork yet.

## Screens (mirrors `tvos/ShowPickerTV`)

| Screen | File | Notes |
|---|---|---|
| Home | `components/screens/HomeScreen.*` | Trending shelf (public) + Members shelf (logged-in); nav bar for My Shows / Search / Add / Account |
| Member | `components/screens/MemberScreen.*` | Four rows — Watching, Awaiting, Loved, Next Up — per-network tally in the header, tvOS sort parity |
| Detail | `components/screens/DetailScreen.*` | Art, overview, cast, rating + club rating; move/archive/restore own copy, or add others' shows |
| Search | `components/screens/SearchScreen.*` | Client-side filter over `/api/shows/all` (title/network/genre/cast) |
| Add | `components/screens/AddShowScreen.*` | TMDB title search → list picker → `POST /api/shows` |
| Account | `components/screens/AccountScreen.*` | Email/phone OTP sign-in, self-enroll name step, sign out, 2-step delete account |

Supporting: `MainScene.*` (view stack + auth + routing), `tasks/ApiTask.*` (all networking),
`widgets/PosterCard.*` (poster tile), `source/Globals.brs` + `source/ContentBuilders.brs`
(theme, list defs, cookie helpers, content builders).

## How auth works

Cookie-based; no bearer token, no device-pairing flow. On `/auth/login` the channel captures
`Set-Cookie: session=<uuid>`, stores it in the Roku registry (`roRegistrySection "showpicker"`),
and replays it as a manual `Cookie: session=<uuid>` header on every request. Every request sends
`X-Client-Platform: roku` and **no** `Origin` header, so the backend treats it as native and
never issues a Turnstile challenge. Base origin: `https://showpicker.club`.

## Testing on a device (standalone Roku OR built-in Roku TV — identical)

Developer Mode is part of Roku OS, so any Roku works: standalone players (Express, Streaming
Stick, Ultra) and built-in Roku TVs (TCL, Hisense, onn., Roku-branded). Two requirements:
the Roku and your computer must be on the **same network**, and you upload a **zip** of the
`roku/` contents in a browser (no Mac/Xcode needed).

1. **Enable Developer Mode.** On the Roku Home screen, press with the remote:
   **Home ×3, Up ×2, Right, Left, Right, Left, Right.** On the Developer Settings screen, enable
   it, note the **IP address** shown, set a dev **web-server password** (remember it), and let it
   reboot.
2. **Zip the channel.** Zip the *contents* of `roku/` so `manifest` sits at the zip root (do not
   zip the `roku/` folder itself):
   ```
   cd roku && zip -r ../showpicker-roku.zip . -x '*.DS_Store'
   ```
3. **Upload it.** In a browser go to `http://<roku-ip>/` (the IP from step 1). Log in with
   username `rokudev` and the password you set. Under "Development Application Installer," choose
   the zip and click **Install**. The channel launches on the TV.
4. **Re-uploading after edits.** Same page → **Replace** (then Install). Or use
   [`roku-deploy`](https://www.npmjs.com/package/roku-deploy) / the BrightScript VS Code extension
   for one-command redeploys and live BrightScript console logs.
5. **Watch the logs.** `telnet <roku-ip> 8085` streams the debug console (`print`/runtime errors)
   — the fastest way to spot a compile or field error.

## What to verify first (most likely to need tuning)

- **Focus hops** between the on-screen `Keyboard`, action `ButtonGroup`, and result grids on
  Search / Add / Account. Handled manually in each screen's `onKeyEvent`; Roku firmware varies in
  whether the keyboard bubbles edge key presses, so a hop may feel sticky and need adjusting.
- **Sign-in end to end:** email OTP → confirm the `session` cookie is captured, persisted, and
  replayed so `/api/shows?member=<me>` returns 200 (not 401). Kill & relaunch → session persists.
  (If `DEMO_LOGIN_EMAIL`/`DEMO_LOGIN_CODE` secrets are set, that account avoids needing a real
  inbox.)
- **Writes:** move between lists, archive/restore, add from TMDB search — each should succeed and
  update the UI.
- **Row labels / colors / sort** match tvOS on the member screen.

## Platform parity gaps (Roku limits, intentional)

- **Watch / deep links:** Roku can't launch other streaming apps to a specific title — the
  "Where to Watch" button shows the network + link instead of launching.
- **Trailers:** YouTube keys aren't directly playable on Roku; trailers omitted for now.
- **Sign in with Apple / Google:** not available on Roku; email/phone OTP only.
- **Ratings:** display-only, same as tvOS.

## Remaining work to ship

- [x] Sideload and get it running — fixed the missing `<script>` includes that crashed every
      screen, RowList field bugs, and an AccountScreen keyboard/button overlap. Merged.
- [ ] Tune keyboard↔buttons↔grid focus transitions on-device (in progress).
- [x] Add real artwork in `roku/images/` — generated from the App Store icon mark.
- [ ] Decide on merge (the `roku` platform backend change ships with it) and, later, Roku channel
      publishing (Roku developer account → package with a signing key on-device → submit).
