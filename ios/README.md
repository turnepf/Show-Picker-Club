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
    └── LoginView.swift         4-digit code entry
```

## Build it on your Mac

1. **Xcode → File → New → Project → iOS → App.**
   - Product Name: `ShowPickerIOS`
   - Interface: **SwiftUI**, Language: **Swift**
   - Uncheck Core Data / Tests if you don't want them.
2. Save the project inside the repo: `~/Documents/Dev/Shows/ios/` (Xcode will create `ios/ShowPickerIOS/`). The existing `ios/ShowPickerIOS/*.swift` files I've written sit alongside; in Xcode's left sidebar, **drag the four root `.swift` files plus the `Views` folder onto the ShowPickerIOS group** with the target checked. (Same workflow you used for the tvOS app — see `tvos/README.md` if you need a refresher.)
3. **Signing & Capabilities** → select your Team. Bundle Identifier should be unique, e.g. `net.patrickturner.showpickerios`.
4. Pick the iPhone simulator and **Cmd+R**. You should see the home screen load against the live API.
5. To run on your actual iPhone, plug it in (or pair via Wi-Fi: Window → Devices and Simulators), pick it from the device dropdown, then Cmd+R.

Same TestFlight distribution path as the tvOS app once you're ready to share with members.

## Share Extension (iOS share sheet → Up Next)

The Share Extension lets you hit the share button in Netflix, the Apple TV app, or any other streaming app and send that show straight to your Up Next list — without opening Show Picker first.

### How it works

- The extension runs as a separate process bundled inside the main app.
- Session credentials (the cookie + your member slug) are stored in a shared App Group container by the main app after you log in. The extension reads them from there to make authenticated API calls.
- When you share from the source app, the extension gets the URL and, when the source app provides it, the show title as well. For Apple TV URLs (`tv.apple.com/*/show/show-name/id`) it can extract the title directly from the URL path. For Netflix and others it prefills whatever the app shares; you can edit the title before saving.
- A small compose form appears: title (editable), network (auto-detected from the URL), list (defaults to **Up Next**), movie toggle, optional notes. Tap **Add** and it calls `POST /api/shows` and dismisses.

### Add the extension to your Xcode project

The Swift source is already in `ios/ShowPickerShareExtension/` and `ios/Shared/`. You just need to wire it up in Xcode:

#### 1. Add a Share Extension target

- **File → New → Target → Share Extension**
- Product Name: `ShowPickerShareExtension`
- Language: **Swift**, interface: **SwiftUI** *(Xcode will create stubs — you'll replace them)*
- Make sure **"Embed in Application"** is set to `ShowPickerIOS`

#### 2. Replace the generated stubs

Delete the files Xcode generated (`ShareViewController.swift`, `ShareView.swift`, any `.intentdefinition`). Then drag in the files from this repo into the `ShowPickerShareExtension` group in the sidebar (check the `ShowPickerShareExtension` target):

```
ios/ShowPickerShareExtension/
├── ShareViewController.swift
├── ShareComposeView.swift
├── ShareAPI.swift
└── Info.plist           ← replace the generated one
```

Also drag `ios/Shared/SharedSession.swift` into the sidebar — check **both** the `ShowPickerIOS` **and** `ShowPickerShareExtension` targets in the file inspector so it compiles into each.

#### 3. Set up the App Group

An App Group is the shared container that lets two targets in the same app share data.

1. Select the `ShowPickerIOS` target → **Signing & Capabilities** → **+ Capability → App Groups**.
2. Add `group.net.patrickturner.showpickerios`.
3. Do the same for the `ShowPickerShareExtension` target — same group ID.
4. Xcode will create `ShowPickerIOS.entitlements` and `ShareExtension.entitlements` automatically with the group already listed. The hand-written entitlement files in this repo (`ios/ShowPickerIOS/ShowPickerIOS.entitlements` and `ios/ShowPickerShareExtension/ShareExtension.entitlements`) are the expected content — Xcode's generated ones should match.

#### 4. Link the extension's Info.plist

Xcode generates its own `Info.plist` for the extension target. Replace its content (or swap the file reference in Build Settings → `INFOPLIST_FILE`) to point at `ios/ShowPickerShareExtension/Info.plist` from this repo, which configures the `NSExtensionActivationRule` to activate on URLs.

#### 5. Build and test

Cmd+R to the simulator or your device. Then open Safari (or the Apple TV app) → navigate to any show → share button → scroll the share sheet to find **Show Picker**. You should see the compose form.

> **First launch note:** the extension reads your session from the App Group. If you've never opened the main Show Picker app and logged in on that device, the extension will show "Not logged in — open Show Picker first." Open the app, log in once, and the extension will work from then on.

### File map after setup

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

## Feature status

| Feature | Status |
|---|---|
| Browse popular + members | ✅ |
| Member's four lists with sort by rating | ✅ |
| Show detail (title, network, rating, genres, recommender, notes, cast, dates) | ✅ |
| Log in with 4-digit code | ✅ (will swap to SMS code once Twilio campaign clears) |
| Add show | ✅ |
| Edit show | ✅ |
| Archive show (swipe action) | ✅ |
| Suggest a show to another member | ✅ |
| Watch on streaming service (deep link) | ✅ for services that support it |
| Share from Netflix / Apple TV / etc. → Up Next | ✅ (Share Extension) |
| Cross-library search | not in v1 — could be added with `.searchable` |
| Vibe profile | not in v1 |
| Recommendations / "Picks for you" | not in v1 |
| Calendar feed | not in v1 (could add a "Subscribe in Calendar" button that opens the webcal:// URL) |

Anything in "not in v1" is straightforward to add later; it's the same backend endpoints, just more views.
