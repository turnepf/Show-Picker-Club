# Roku channel — status & pick-up notes

A place to resume from. The Roku channel is **on `main` and running on a device**; what's left is
focus tuning, HD-scaling polish, and the decision about publishing.

## Where things stand

- **Built:** a native Roku channel at `roku/` (SceneGraph/BrightScript) that behaves like the
  Apple TV app but uses standard Roku controls (`RowList`, `MarkupGrid`, `Keyboard`,
  `ButtonGroup`, `Dialog`, `BusySpinner`) with Roku-idiomatic navigation.
- **Feature scope:** full parity with the current tvOS app — sign in, browse Trending + members +
  the four lists + detail + search, plus add / move / archive / restore and delete account.
- **Backend:** `roku` is in `KNOWN_PLATFORMS` (`functions/_shared/platform.js`), so Roku sessions
  get recorded like any other platform.
- **Run on a real device.** Roku SceneGraph has no simulator, so every change is verified by
  sideloading (below). Artwork is in place, generated from the App Store icon mark.
- **NOT done:** not published — no Roku developer account, no signed package, no Channel Store
  submission. Sideload-only.

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
  There are now three ways out of the keyboard, because the parent only sees a key the `Keyboard`
  itself declines: **Down** (the intended one), **Right** on Search/Add when there are results,
  and **✱** (`options`), which no firmware claims and which the on-screen hint names. Confirm Down
  works on device; if it does, the ✱ hint could come back out.
- **Sign-in end to end:** email OTP → confirm the `session` cookie is captured, persisted, and
  replayed so `/api/shows?member=<me>` returns 200 (not 401). Kill & relaunch → session persists.
  (If `DEMO_LOGIN_EMAIL`/`DEMO_LOGIN_CODE` secrets are set, that account avoids needing a real
  inbox.)
- **Writes:** move between lists, archive/restore, add from TMDB search — each should succeed and
  update the UI.
- **Row labels / colors / sort** match tvOS on the member screen.

## Known, deliberately deferred

- **FHD geometry not divisible by three.** Roku scales the `fhd` graphics plane by 2/3 on HD
  devices, so FHD dimensions that aren't multiples of three land on fractional HD pixels and soften
  edges — the 280px poster card and the 440px row height are the main offenders (also 34px row
  spacing, several translations). This matters *more* now that legacy devices are an explicit
  target, since those are exactly the 720p boxes doing the 2/3 scale. Still not fixed here: it
  ripples through `PosterCard.xml`'s internal geometry and every grid/RowList that sizes against
  it, and those layouts were hand-tuned on device across #451–#455. Do it in a session with a Roku
  attached, where the result is visible.
- **Search fetches the whole library — the biggest remaining risk on old hardware.**
  `/api/shows/all` comes down in full, is parsed into memory, and is filtered on the device.
  Rendering is capped (`MaxResults()`, 40 on legacy / 100 on modern, with the true total named in
  the heading), which bounds the *grid* — but the download, the `ParseJson` and the retained array
  still scale with the club, and none of that is capped. On a 512MB 2017 box that is the thing most
  likely to fall over as the library grows. The real fix is a server-side search: a `q=` parameter
  on `/api/shows/all` (or a new endpoint) so the device receives matches instead of everything.
  That is a backend change, not a Roku one, and it is the next thing worth doing here.
- **Deep linking is unimplemented**, and `supports_input_launch` was removed from the manifest to
  stop claiming otherwise. `main.brs` still parks the launch args on `MainScene.launchArgs` as the
  seam to build against. A public Channel Store submission needs this: Roku certification requires
  a channel that declares deep-link support to honour `contentId`/`mediaType`.

## Device tiers

The channel adapts to the hardware — see the table in `roku/README.md`. `DeviceProfile()` in
`source/Globals.brs` reads `roDeviceInfo.GetGraphicsPlatform()` once at launch and everything
cost-sensitive (image widths, detail hero art, focus animation, search result cap) reads from that
one profile. The tier is printed to the debug console at launch, so `telnet <roku-ip> 8085` tells
you immediately which one a device landed in.

Worth confirming on a real legacy box: that the tier is detected as `legacy` at all (the print
line), that `w185` posters still look acceptable at the card's draw size, and that dropping the
focus zoom doesn't make the rows feel dead.

## Platform parity gaps (Roku limits, intentional)

- **Watch / deep links:** Roku can't launch other streaming apps to a specific title — the
  "Where to Watch" button shows the network + link instead of launching.
- **Trailers:** YouTube keys aren't directly playable on Roku; trailers omitted for now.
- **Sign in with Apple / Google:** not available on Roku; email/phone OTP only.
- **Ratings:** display-only, same as tvOS.

## Remaining work to ship

- [x] Sideload and get it running — fixed the missing `<script>` includes that crashed every
      screen, RowList field bugs, and an AccountScreen keyboard/button overlap. Merged.
- [ ] Tune keyboard↔buttons↔grid focus transitions on-device (in progress — ✱ fallback added).
- [ ] FHD geometry divisible by three (see *Known, deliberately deferred*).
- [ ] Server-side search, so Search stops downloading the whole library (see above).
- [x] Add real artwork in `roku/images/` — generated from the App Store icon mark.
- [ ] Decide on merge (the `roku` platform backend change ships with it) and, later, Roku channel
      publishing (Roku developer account → package with a signing key on-device → submit).
