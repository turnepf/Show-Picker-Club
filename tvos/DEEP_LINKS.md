# tvOS Deep-Linking — Research Findings

After several rounds of on-device testing and community-source research, here's the honest picture for opening a specific show in a streaming service's tvOS app from our app.

## The headline

**tvOS deep-linking to a specific show is broadly broken across the industry.** It's a platform-level limitation, not a Show Picker Club bug. The streaming services have largely chosen *not* to honor third-party deep links into specific content on tvOS — they only let you launch the app. Apple's official path forward isn't custom URL schemes at all; it's the Apple TV app and Universal Search, which require services to submit metadata feeds to Apple. That's not accessible to us from outside that system.

Where this leaves us:

- **What works:** HBO Max and Apple TV+ honor https universal links and deep-link to the show. These are the exceptions, not the rule.
- **What doesn't:** Netflix, Amazon Prime, Hulu, Peacock, Paramount+, Disney+ — best case the app opens to its home; worst case the URL isn't claimed at all and `openURL` fails outright.

Even commercial smart-home vendors (Josh.ai etc.) who specialize in this kind of integration have only partial coverage and call Netflix "coming soon." This isn't a problem we can fully solve.

## Per-service test matrix

Status after the latest in-app code with custom-scheme fallbacks:

| Service | Watchmode URL form | tvOS result | What we do | Notes |
|---|---|---|---|---|
| **HBO Max** | `play.hbomax.com/...` | ✅ opens to the show | "Watch on HBO Max" — pass-through https | The one that just works |
| **Apple TV+** | `tv.apple.com/...` | ✅ opens to the show | "Watch on Apple TV+" — pass-through https | Confirmed working on device |
| **Netflix** | `netflix.com/title/<id>` | Opens app to home | "Open Netflix" — pass-through https | Both https and `nflx://` only get to home. A community source mentions `ntflx://` (note the extra t) — worth testing as one more shot before giving up |
| **Amazon Prime** | `watch.amazon.com/detail?gti=...` | Used to fail; with `aiv://` opens app to home | "Open Amazon Prime" — rewrite to `aiv://aiv/landing` | Bundle id: `com.amazon.aiv.AIVApp` |
| **Hulu** | `hulu.com/series/...` | Failed to open with https; rewrite to `hulu://` | "Open Hulu" — rewrite | Untested with new fallback; Apple bundle id `com.hulu.plus` |
| **Peacock** | `peacocktv.com/...` | Failed with https; opens app with `peacocktv://` | "Open Peacock" — rewrite | Bundle id `com.peacocktv.peacock` |
| **Paramount+** | `paramountplus.com/...` | Failed with https; trying `paramountplus://` | "Open Paramount+" — rewrite | Untested with new fallback |
| **Disney+** | `disneyplus.com/...` | Untested | "Open Disney+" — rewrite to `disneyplus://` | Bundle id `com.disney.disneyplus` |

## Why this is the way it is

The Apple-blessed integration path for tvOS streaming apps is the **Apple TV app + Universal Search**. Services submit XML metadata feeds to Apple containing show catalogs and per-territory availability + deep-link URLs ("locator elements"). The Apple TV app and Siri then call into those services with the right URL when a user picks the show through Apple's UI. **The streaming services' own apps mostly do not honor those same deep-link URLs when invoked by third parties** — the integration is one-way, into the Apple TV app's ecosystem, not out to arbitrary callers.

So tools like Show Picker Club that want to bypass the Apple TV app entirely are working against the grain.

## Realistic UX (what's now shipped)

- Button label adapts: **"Watch on …"** for services known to deep-link, **"Open …"** for the rest. Sets the right expectation.
- For services whose tvOS app refuses to open the https URL at all, we rewrite to their custom scheme (`aiv://`, `hulu://`, `peacocktv://`, `paramountplus://`, `disneyplus://`) so at least the app launches and the member can search inside it.
- The "Couldn't open" message stays for cases where even the scheme doesn't open the app.

## Open avenues worth one more shot

1. **`ntflx://` for Netflix.** One community source specifically calls out `ntflx://` (with the 't') as opposed to the more commonly cited `nflx://`. Both might launch the app, but `ntflx://` could possibly carry a title param. Worth 5 minutes on the device.
2. **Trying multiple aiv:// formats for Amazon.** `aiv://aiv/detail?asin=<asin>` or `aiv://aiv/play?asin=<asin>` are sometimes mentioned for iOS; tvOS might honor a subset. Watchmode gives us a `gti` not an `asin` though — would need a translation table.
3. **The Apple TV app as a router.** A Watchmode lookup that returns a `tv.apple.com/us/show/<slug>/umc.cmc.<id>` URL opens the Apple TV app's show page, which has buttons to launch the right streaming app for that show — sometimes deep-linking. This bypasses our problem by delegating to Apple. Watchmode does include `tv.apple.com` URLs in some responses; we'd need to check if it does so for non-Apple-TV+ shows too.
4. **In-app search hint UX.** When tapping "Open Netflix," we could briefly overlay the show title on screen with "search inside Netflix for: *Severance*" so the member arrives with the title fresh in mind. Tiny UI polish that takes the sting out.

## Recommended near-term plan

1. **Accept the limitation.** Stop trying to fix every service. Current state (HBO Max / Apple TV+ work; rest "Open the app") is the realistic ceiling.
2. **Test `ntflx://` for Netflix.** One-line code change to verify if it's any different from `nflx://`.
3. **Polish the "Open" UX** (option 4 above): show the title prominently as the app launches, so the user sees what to search for. Small Swift change.
4. **Watchmode tv.apple.com URLs (option 3 above).** Worth investigating whether Watchmode returns these for non-Apple-TV+ shows. If yes, we could route any show through the Apple TV app as a universal middle-page that knows how to deep-link.

Not recommended: keep guessing at undocumented per-service URL formats. The streaming services have signaled their position and that won't change for our use case.

## Sources

- [URL Schemes on tvOS? — Apple Developer Forums](https://developer.apple.com/forums/thread/19373)
- [Apple TV App and Universal Search Guide](https://help.apple.com/itc/tvpumcstyleguide/en.lproj/static.html)
- [Apple TV App and Universal Search Video Integration (WWDC Tech Talks)](https://developer.apple.com/videos/play/tech-talks/509/)
- [Deep Linking on tvOS — WWDC17](https://developer.apple.com/videos/play/wwdc2017/246/)
- [AppleTV Integration Deep Link URLs — Which Are Working? (Home Assistant community)](https://community.home-assistant.io/t/appletv-integration-deep-link-urls-which-are-working/592862)
- [pyatv: Apps (bundle IDs and known deep links)](https://pyatv.dev/development/apps/)
- [Channels DVR — Stream Links](https://getchannels.com/docs/channels-dvr-server/how-to/stream-links/)
- [How to deeplink to apps & where to find the ASIN — Amazon Developer Community](https://community.amazondeveloper.com/t/how-to-deeplink-to-apps-where-to-find-the-asin-product-id-number/2178)
- [Universal Link/Deep Link to Amazon Prime Video iOS app](https://forums.developer.amazon.com/questions/210283/universal-linkdeep-link-to-amazon-prime-video-ios.html)
- [Josh.ai — AppleTV Deep-Linking](https://joshdotai.medium.com/josh-ai-doubles-down-on-apple-user-experience-launching-appletv-deep-linking-ios-app-684a29f823d4)
