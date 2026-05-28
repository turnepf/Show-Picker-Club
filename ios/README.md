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
| Cross-library search | not in v1 — could be added with `.searchable` |
| Vibe profile | not in v1 |
| Recommendations / "Picks for you" | not in v1 |
| Calendar feed | not in v1 (could add a "Subscribe in Calendar" button that opens the webcal:// URL) |

Anything in "not in v1" is straightforward to add later; it's the same backend endpoints, just more views.
