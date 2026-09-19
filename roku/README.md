# Show Picker Club — Roku channel

A native Roku (SceneGraph / BrightScript) client for [showpicker.club](https://showpicker.club).
It behaves like the Apple TV app but is built entirely from **standard Roku controls**
(`RowList`, `MarkupGrid`, `Keyboard`, `ButtonGroup`, `Dialog`, `BusySpinner`) and follows Roku's
own navigation conventions rather than mimicking Apple's tab bar.

## What it does

- **Home** — Trending shelf (`/api/popular`, public) plus a Members shelf (logged-in only), with
  a nav bar for My Shows / Search / Add Show / Account.
- **Member** — the four lists as horizontal rows: **Watching, Awaiting, Loved, Next Up**, each
  with a per-network tally in the row header, sorted the same way as the iOS/tvOS apps.
- **Detail** — hero art, overview, cast, rating, club-rating summary, and action buttons to move
  a show between lists / archive / restore (your own copy) or add another member's / trending
  show to one of your lists.
- **Search** — cross-library search over `/api/shows/all?q=` (title, network, genre, cast),
  filtered **server-side**. The channel used to download the whole club library and filter it on
  the device; that was the heaviest thing it did and the first thing that would fall over on an
  older box, so the filtering moved to the server and the device now holds nothing between
  searches.
- **Add** — TMDB title search (`/api/title-search`) → pick a list → `POST /api/shows`.
- **Account** — email/phone one-time-code sign-in, self-enroll name step, sign out, and the
  two-step delete-account flow.

## How it talks to the backend

Base origin `https://showpicker.club`. Auth is **cookie-based** — there is no bearer token and no
device-pairing flow. On `POST /auth/login` the channel captures `Set-Cookie: session=<uuid>`,
stores it in the registry (`roRegistrySection "showpicker"`), and replays it as a manual
`Cookie: session=<uuid>` header on every request (see `components/tasks/ApiTask.brs`). Every
request also sends `X-Client-Platform: roku`. The client sends **no `Origin` header**, so the
backend treats it as a native client and never issues a Turnstile challenge.

## Device tiers — the channel adapts to the hardware it lands on

The channel has to stay usable on Rokus going back about eight years, and a 2017 box is a
genuinely different machine from a current one: the older models draw through **DirectFB** with a
small texture budget, anything current uses **OpenGL**. `roDeviceInfo.GetGraphicsPlatform()` is
Roku's own signal for that split, so `DeviceProfile()` in `source/Globals.brs` reads it once at
launch, caches the result on the global node, and every cost-sensitive decision reads from that
one profile.

| | legacy (DirectFB) | modern (OpenGL) |
|---|---|---|
| Card poster | TMDB `w185` | TMDB `w342` |
| Network logo | `w92` | `w154` |
| Detail hero | poster, `w342` | backdrop, `w780` |
| Focus zoom | off | 1.06× scale |
| Search results rendered | 40 | 100 |

Nothing in that table removes a screen, a list or an action — the tiers differ in **cost per pixel
drawn**, not in what the channel can do. The tier a device landed in is printed to the debug
console at launch (`[showpicker] device tier=…`), which is the quickest way to confirm it on a
sideload.

Two rules that hold everywhere, regardless of tier:

- **Images are sized by the client, not the server.** The stored `poster_url` is `w500` because it
  is shared with the Apple apps, where a poster can fill an iPad. `TmdbWidth()` rewrites the width
  in the URL and **only ever downsizes** — `/api/title-search` already returns `w92` thumbnails,
  and rewriting those upward would make the Add screen slower for worse art.
- **Text is drawn before images.** `PosterCard.onContentSet()` sets the title, background, fallback
  and badge first and assigns the image `uri`s last, so a card is readable before its artwork
  arrives. `DetailScreen` goes further: it paints the title and poster from the card you selected
  (`seed`) while the detail request is still in flight, reusing the exact URL the card already
  loaded so it comes from the image cache rather than costing a second download.

## Platform parity notes (Roku limits, not omissions)

- **Watch / deep links** — Roku does not let a channel launch other streaming apps to a specific
  title, so the "Where to Watch" button shows the network + link rather than launching it.
- **Trailers** — YouTube keys aren't directly playable on Roku, so trailers are omitted for now.
- **Sign in with Apple / Google** — not available on Roku; email/phone OTP only.
- **Ratings** — display-only, same as tvOS.

## Tooling

Roku ships no simulator, so this directory carries the only build tooling in the repo (scoped here
on purpose — the web side has no build step and that stays true). `npm install` once, then:

| Command | What it does |
|---|---|
| `npx bsc --project bsconfig.json` | Validate the whole channel — every call resolved against its real component scope, every `onChange` handler checked against the script that must define it, plus bslint for unused variables and name shadowing. Runs in CI. |
| `node sideload.mjs info` | Device model, OS and graphics platform. The quickest way to see which tier `DeviceProfile()` will pick. |
| `node sideload.mjs` | Validate, package and install to the device in one command. |
| `node sideload.mjs logs` | Stream the debug console. `--relaunch` restarts the channel *after* attaching, so the launch line is captured rather than missed; `--seconds N` stops on its own. |
| `node sideload.mjs --legacy` | The same, built with `FORCE_LEGACY=true` so a modern device takes the legacy path. Patches the **staged** manifest only — the committed one always says false. |

The `--legacy` build matters because the Roku you have to hand is probably a current one, and the
legacy tier is the half that most needs checking. A tier nobody can run is a tier nobody has
verified. Note that it forces the *decisions* (smaller art, no focus zoom, lower search cap), not
the hardware — it shows you what a 2017 box would be asked to draw, not how fast it would draw it.

A `bsc` failure is a compile error — before this existed, the only way to find a typo or a call to
a function that isn't there was to sideload and read the crash over telnet, so a sideload validates
first and refuses to install a channel that fails.

Credentials stay out of the repo, matching `scripts/asc.mjs`: `~/.roku/host` and
`~/.roku/password`, or `ROKU_HOST` / `ROKU_PASSWORD` for a single run.

The console is read over plain TCP with `node:net` rather than shelling out to `telnet … | timeout`,
because macOS ships neither of those.

**Driving the UI remotely does not work out of the box.** Roku OS 14+ refuses ECP `/keypress`
requests with a 403 unless *Settings → System → Advanced system settings → Control by mobile apps →
Network access* is set to **Permissive**. Launching the channel (`/launch/dev`) and reading device
info are unaffected, so `logs --relaunch` works regardless — only scripted button presses need that
setting changed.

## Building / sideloading

Roku SceneGraph has no simulator — you need a real device in **Developer Mode**
(https://developer.roku.com/docs/developer-program/getting-started/developer-setup.md).

1. Enable Developer Mode on the Roku (Home ×3, Up ×2, Right, Left, Right, Left, Right).
2. Zip the **contents** of this `roku/` directory (so `manifest` is at the zip root — do not zip
   the `roku/` folder itself).
3. Upload the zip at `http://<roku-ip>/` (Development Application Installer), or use
   [`roku-deploy`](https://www.npmjs.com/package/roku-deploy) / the BrightScript VS Code
   extension.

```
cd roku && zip -r ../showpicker-roku.zip . -x '*.DS_Store'
```

## Channel artwork

`images/` holds placeholder icons, splash screens, and a spinner glyph, all derived from the same
mark as the App Store icon (`ios/ShowPickerIOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png`)
so the Home-screen tile matches the Apple apps rather than inventing new branding. Good enough to
sideload and publish with; swap in dedicated artwork later if desired.

## Known on-device tuning

Focus transitions between the on-screen `Keyboard`, the action `ButtonGroup`, and result grids
are handled manually in `onKeyEvent` (Search/Add/Account screens). Roku's keyboard may consume
edge key presses differently across firmware; verify these transitions on a real device and
adjust the zone logic if a hop feels sticky.
