# Show Picker Club — Apple TV (tvOS) app

A native, **view-only** tvOS client for [showpicker.club](https://showpicker.club). Browse members, see their four lists, and deep-link straight into the streaming app to start watching. Editing stays on the phone/web — this app never writes.

Built with SwiftUI. Talks to the same public `/api/*` endpoints as the web app; no auth, no backend changes.

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

The Xcode project is committed at `tvos/ShowPickerTV.xcodeproj` — just open and run.

1. **Open `tvos/ShowPickerTV.xcodeproj`** in Xcode (double-click it, or `open tvos/ShowPickerTV.xcodeproj` from the repo root).
2. **Signing & Capabilities** → select your Team. The project ships with `DEVELOPMENT_TEAM = NQ6AJVVBBJ` and bundle id `net.patrickturner.ShowPickerTV`; change the team to yours (and the bundle id if it collides with an existing app).
3. Pick the **Apple TV** simulator and **Cmd+R**. You should see the home screen load from the live API.

No `Info.plist` edits needed — showpicker.club is HTTPS, so App Transport Security passes by default.

## Distribute via TestFlight (no public App Store listing)

1. In Xcode: set the run destination to **Any tvOS Device**, then **Product → Archive**.
2. In the Organizer, **Distribute App → TestFlight & App Store Connect → Upload**.
3. In [App Store Connect](https://appstoreconnect.apple.com): your app → **TestFlight** tab.
4. Add members as **External testers** (a group), or use the **Public Link** and share that one URL.
5. First build triggers a one-time **Beta App Review** (usually ~a day). After that, members:
   - Install **TestFlight** from the App Store on their Apple TV,
   - Sign in with their Apple ID and accept the invite / open the public link,
   - Install Show Picker Club from inside TestFlight.

**Builds expire after 90 days.** To refresh: bump the build number, Archive, Upload — testers auto-update. ~10-minute chore quarterly.

## Known limitations / next steps

- **No poster art yet.** The backend stores text + URLs, not images, so shows render as colored title tiles. To make it look like a "real" TV app, add a `poster_url` to the `shows` table and populate it from TMDB/Watchmode (both already in the pipeline). The `ShowCard` view is built to drop in a poster image without changing callers.
- **Deep links are best-effort.** "Watch on …" opens the streaming service's universal link; whether it lands inside that service's tvOS app vs. prompting depends on the app being installed and the service honoring universal links. The `play.hbomax.com` / `watch.amazon.com` URLs the web cleanup produced are what power this.
- **View-only by design.** No login, no editing. If editing on TV is ever wanted, the right pattern is phone-pairing, not a remote keyboard.
