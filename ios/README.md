# Show Picker Club — iPhone (iOS) app

Native SwiftUI iOS client for [showpicker.club](https://showpicker.club). Full feature parity with the web app — browse, log in, add / edit / archive shows, suggest to others, deep-link into streaming apps. All standard UIKit / SwiftUI controls (Form, List, Picker, sheet, etc.), no custom widgetry.

Talks to the same `/api/*` endpoints as the web. Session cookie is managed automatically by `URLSession.shared` via `HTTPCookieStorage`, so login persists across launches.

## What's here

```
ios/ShowPickerIOS/
├── ShowPickerIOSApp.swift      App entry
├── Models.swift                Codable models (member, show, popular, …)
├── API.swift                   Async client (reads + writes + auth)
├── AuthStore.swift             @Observable session state
└── Views/
    ├── HomeView.swift          Popular shelf + member list
    ├── MemberView.swift        Member's four lists with swipe-to-archive / edit
    ├── ShowDetailView.swift    Read-only detail + Edit + Watch
    ├── AddEditShowView.swift   Sheet for add / edit
    ├── SuggestShowView.swift   Sheet for suggesting to another member
    └── LoginView.swift         Sign in with Apple + one-time code entry
```

## Build it on your Mac

The Xcode project is committed at `ios/ShowPickerIOS.xcodeproj` with **two targets already wired up** — the `ShowPickerIOS` app and the `ShowPickerShareExtension` (the share-sheet integration). You don't create anything by hand; just open and run.

1. **Open `ios/ShowPickerIOS.xcodeproj`** in Xcode (double-click it, or `open ios/ShowPickerIOS.xcodeproj` from the repo root).
2. **Signing & Capabilities** → for *both* the `ShowPickerIOS` and `ShowPickerShareExtension` targets, select your Team. The project ships with `DEVELOPMENT_TEAM = NQ6AJVVBBJ` (the same team as the tvOS app); if that's not your team, change it on both targets.
   - The bundle IDs are `net.patrickturner.showpickerios` (app) and `net.patrickturner.showpickerios.ShareExtension` (extension). Change the prefix on both if you need a different one — keep the extension ID as a child of the app ID.
   - The **App Group** `group.net.patrickturner.showpickerios` is already declared in both targets' entitlements. Xcode's automatic signing will register it for you; if you change the group ID, update both `.entitlements` files **and** `ios/Shared/SharedSession.swift` (the `appGroupID` constant).
3. Pick the iPhone simulator and **Cmd+R** (scheme: `ShowPickerIOS`). You should see the home screen load against the live API.
4. To run on your actual iPhone, plug it in (or pair via Wi-Fi: Window → Devices and Simulators), pick it from the device dropdown, then Cmd+R.

### Releasing a new build to TestFlight

The app is **already in TestFlight**, so shipping a new build is just *archive + upload* — no app-record or first-time setup.

**Always bump the build number before you archive.** App Store Connect rejects any build whose number isn't strictly higher than the last one uploaded for the same marketing version (this bit us once — the repo lagged what was already in TestFlight). The build number is `CURRENT_PROJECT_VERSION`, set **once at the project level** so the app and the share extension always match (Xcode → project → Build Settings → *Current Project Version*).

> **Build log — keep this current.** Marketing version `1.0`. Highest build uploaded to TestFlight: **3**. Committed and ready to upload next: **4**. Before each upload, set this to the next unused integer (here *and* in the project), then update this line after uploading.

Steps:
1. `git pull origin main` (so you archive the bumped number).
2. Xcode → run destination **Any iOS Device (arm64)**.
3. **Product → Archive**.
4. Organizer → **Distribute App → App Store Connect → Upload** → accept the defaults.
5. ~5–15 min later it appears under the app's **TestFlight** tab; internal testers auto-update, external groups need the new build assigned.

### Project layout

The project uses Xcode's file-system-synchronized groups (same as the tvOS project), so every `.swift` file in a target's folder is compiled automatically — no manual "add file to target" step when you create new files.

```
ios/
├── ShowPickerIOS.xcodeproj         ← open this
├── Shared/
│   └── SharedSession.swift         ← compiled into BOTH targets (App Group cookie bridge)
├── ShowPickerIOS/                  ← app target folder (auto-synced)
│   ├── ShowPickerIOS.entitlements
│   └── … app sources
└── ShowPickerShareExtension/       ← extension target folder (auto-synced)
    ├── Info.plist                  ← NSExtension config
    ├── ShareExtension.entitlements
    └── … extension sources
```

## Share Extension (iOS share sheet → Up Next)

The Share Extension lets you hit the share button in Netflix, the Apple TV app, or any other streaming app and send that show straight to your Up Next list — without opening Show Picker Club first.

### How it works

- The extension runs as a separate process bundled inside the main app.
- Session credentials (the cookie + your member slug) are stored in a shared App Group container by the main app after you log in. The extension reads them from there to make authenticated API calls.
- When you share from the source app, the extension gets the URL and, when the source app provides it, the show title as well. For Apple TV URLs (`tv.apple.com/*/show/show-name/id`) it can extract the title directly from the URL path. For Netflix and others it prefills whatever the app shares; you can edit the title before saving.
- A small compose form appears: title (editable), network (auto-detected from the URL), list (defaults to **Up Next**), movie toggle, optional notes. Tap **Add** and it calls `POST /api/shows` and dismisses.

### It's already wired up

The extension target, the App Group, the entitlements, the `Info.plist` activation rule, and the "embed extension into the app" build phase are all part of the committed `ShowPickerIOS.xcodeproj`. There's nothing to add by hand — the only Xcode step is selecting your signing **Team** on both targets (see "Build it on your Mac" above).

The moving parts, for reference:

```
ios/
├── Shared/
│   └── SharedSession.swift         ← in BOTH targets; manages the App Group cookie
├── ShowPickerIOS/
│   ├── ShowPickerIOS.entitlements  ← App Group for main app
│   ├── AuthStore.swift             ← syncs cookie to App Group on login/logout
│   └── … (existing files)
└── ShowPickerShareExtension/
    ├── ShareViewController.swift   ← entry point; extracts title + network from share payload
    ├── ShareComposeView.swift      ← SwiftUI form (title, network, list, movie, notes)
    ├── ShareAPI.swift              ← POST /api/shows using the shared session cookie
    ├── ShareExtension.entitlements ← App Group for extension
    └── Info.plist                  ← NSExtension config; activates on URLs
```

### Test it

1. Cmd+R the `ShowPickerIOS` scheme to your device or simulator, then **log in once** in the app.
2. Open Safari (or the Apple TV app) → navigate to any show → tap the share button → scroll the share sheet to find **Show Picker Club**. The compose form appears, pre-filled where possible; tap **Add**.

> **First launch note:** the extension reads your session from the App Group. If you've never opened the main Show Picker Club app and logged in on that device, the extension shows "Not logged in — open Show Picker Club first." Open the app, log in once, and the extension works from then on.
>
> **Simulator note:** Netflix/Apple TV aren't on the simulator, but Safari is — sharing any web page exercises the same URL path, so it's the easiest way to smoke-test.

## Feature status

| Feature | Status |
|---|---|
| Browse popular + members | ✅ |
| Member's four lists with sort (Next up / Rating / A–Z / Date added) | ✅ |
| Show detail (title, network, rating, genres, recommender, notes, cast, dates) | ✅ |
| Log in with one-time code (text or email) | ✅ (auto-submits on the 6th digit) |
| Sign in with Apple | ✅ (maps the Apple ID email → existing member; see note) |
| Add show | ✅ |
| Edit show | ✅ |
| Archive show (swipe action) | ✅ |
| Quick-list promotions (leading swipe + detail "Move" section) | ✅ (Watched it / Season done / Watching / Start) |
| Suggest a show to another member | ✅ |
| Send an existing show to another member's Up Next | ✅ (carries over rating, network link, cast) |
| Cross-library search (title + actor, across all members) | ✅ (home-screen 🔍, add results to your lists) |
| Watch on streaming service (deep link) | ✅ for services that support it |
| Share from Netflix / Apple TV / etc. → Up Next | ✅ (Share Extension) |
| Vibe profile | not in v1 |
| Recommendations / "Picks for you" | not in v1 |
| Calendar feed | not in v1 (could add a "Subscribe in Calendar" button that opens the webcal:// URL) |

Anything in "not in v1" is straightforward to add later; it's the same backend endpoints, just more views.

## Sign in with Apple

The login sheet offers **Sign in with Apple** alongside phone/email codes. How it works:

- The app gets Apple's signed identity token and POSTs it to `POST /auth/apple`.
- The server (`functions/auth/apple.js`) verifies the token against Apple's public keys, then maps it to an **existing** member — first by the email Apple shares (against `member_emails`), then by the stable Apple user id (`sub`), which it remembers in `member_apple_ids` so later sign-ins work even behind a private-relay email. There is no public sign-up; an unrecognized Apple ID is rejected.

Two things to know before it works end to end:

1. **The Apple ID must already be a member.** The first sign-in matches by email, so on Apple's consent screen choose **"Share My Email"** with the address the owner has on file (hiding your email on the *first* sign-in can't be matched). After that first link it's keyed by `sub`.
2. **Deploy the backend + run the migration.** The app talks to the live `showpicker.club` API, so `/auth/apple` only exists once this branch is deployed (push to `main`). Apply the new table first:
   ```bash
   wrangler d1 execute shows-db --remote --file=migrations/011_apple_login.sql
   ```
   Until then, Apple sign-in returns an error and you can fall back to phone/email codes.

On the Xcode side, the **Sign in with Apple** capability is already declared in `ShowPickerIOS.entitlements`. With automatic signing and a paid Apple Developer account, Xcode registers it on your App ID when you select your Team. The token audience is the app bundle id (`net.patrickturner.showpickerios`); if you change the bundle id, set `APPLE_CLIENT_ID` in the Pages environment to match.
