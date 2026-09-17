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
- **Search** — cross-library search over `/api/shows/all` (title, network, genre, cast).
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

## Platform parity notes (Roku limits, not omissions)

- **Watch / deep links** — Roku does not let a channel launch other streaming apps to a specific
  title, so the "Where to Watch" button shows the network + link rather than launching it.
- **Trailers** — YouTube keys aren't directly playable on Roku, so trailers are omitted for now.
- **Sign in with Apple / Google** — not available on Roku; email/phone OTP only.
- **Ratings** — display-only, same as tvOS.

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
