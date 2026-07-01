# Show Picker Club — Apple TV (tvOS) app

A native, **view-only** tvOS client for [showpicker.club](https://showpicker.club). Browse members, see their four lists, and deep-link straight into the streaming app to start watching. Editing stays on the phone/web — this app never writes.

Built with SwiftUI. Talks to the same public `/api/*` endpoints as the web app; no auth, no backend changes.

This tvOS app ships **bundled with the iOS app as a single universal App Store listing** — they share one bundle id (`net.patrickturner.showpickerios`, iPhone + Apple TV), not two separate apps. It depends on the shared **`ShowPickerCore`** Swift package (at the repo root; models + response wrappers, also used by iOS and watchOS) and is opened together with iOS via **`ShowPickerClub.xcworkspace`**.

## What's here

```
tvos/
├── ShowPickerTV.xcodeproj/       Xcode project (open this)
└── ShowPickerTV/                 App sources (synchronized folder)
    ├── ShowPickerTVApp.swift     App entry point
    ├── Models.swift              Codable models matching the API JSON
    ├── API.swift                 Async networking client (view-only endpoints)
    ├── Theme.swift               Colors + deterministic fallback tile colors
    ├── HomeView.swift            Popular shelf + members grid
    ├── MemberView.swift          A member's four lists as horizontal shelves
    ├── ShowDetailView.swift      Detail + "Watch on …" deep-link button
    ├── ShowCard.swift            Focusable show tile
    └── Assets.xcassets/          App icon, top shelf, accent color
```

## Build it (on your Mac)

The tvOS target is committed at `tvos/ShowPickerTV.xcodeproj` and is part of the repo-root `ShowPickerClub.xcworkspace` — open the workspace to build it alongside iOS.

1. **Open `ShowPickerClub.xcworkspace`** (at the repo root) in Xcode. (Opening `tvos/ShowPickerTV.xcodeproj` on its own still works, but the workspace is the intended entry point since it also wires in the shared `ShowPickerCore` package.)
2. **Signing & Capabilities** → select your Team. The project ships with `DEVELOPMENT_TEAM = NQ6AJVVBBJ` and shares the iOS app's bundle id `net.patrickturner.showpickerios` (one universal app); change the team to yours if it isn't `NQ6AJVVBBJ`.
3. Pick the **Apple TV** simulator and **Cmd+R**. You should see the home screen load from the live API.

No `Info.plist` edits needed — showpicker.club is HTTPS, so App Transport Security passes by default.

## Distribute

The tvOS build uploads to the **same App Store Connect app record as iOS** (shared
bundle id), so iPhone and Apple TV ship as one universal app. Archive and upload
the same way for both TestFlight and a public App Store release.

1. In Xcode (via `ShowPickerClub.xcworkspace`): set the run destination to **Any tvOS Device**, then **Product → Archive**.
2. In the Organizer, **Distribute App → TestFlight & App Store Connect → Upload**.
3. In [App Store Connect](https://appstoreconnect.apple.com): the **Show Picker Club** app.
   - **TestFlight tab** — add members as **External testers** (a group) or share the **Public Link**. The first build triggers a one-time **Beta App Review** (~a day). Testers install the **TestFlight** app on their Apple TV, accept the invite, and install from there.
   - **App Store tab** — when you're ready for a public listing, add the Apple TV screenshots/metadata to the same app and submit for review. Because it's one universal app, a single submission covers iPhone + Apple TV (and the paired Apple Watch app rides along with the iOS build).

**TestFlight builds expire after 90 days.** To refresh: Archive + Upload (the build number auto-bumps) — testers auto-update.

## Known limitations / next steps

- **No poster art yet.** The backend stores text + URLs, not images, so shows render as colored title tiles. To make it look like a "real" TV app, add a `poster_url` to the `shows` table and populate it from TMDB/Watchmode (both already in the pipeline). The `ShowCard` view is built to drop in a poster image without changing callers.
- **Deep links are best-effort.** "Watch on …" opens the streaming service's universal link; whether it lands inside that service's tvOS app vs. prompting depends on the app being installed and the service honoring universal links. The `play.hbomax.com` / `watch.amazon.com` URLs the web cleanup produced are what power this.
- **View-only by design.** No login, no editing. If editing on TV is ever wanted, the right pattern is phone-pairing, not a remote keyboard.
