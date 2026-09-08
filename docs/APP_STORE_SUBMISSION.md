# App Store Submission Checklist

A pre-flight list for every App Store submission of Show Picker Club. Signup is
open — a reviewer can create their own account with Sign in with Apple — but a
demo account with real data still makes the review go smoothly, and the
privacy-label mismatch still bites. Both are covered below.

The listing is **universal**: one bundle id covers iPhone + Mac (Catalyst) +
Apple TV (the watch app rides along with the iOS build), so one submission
reviews every surface — work the checklist for **iPhone/iPad, Mac, and Apple
TV**. That means **three archives** per submission: iOS, macOS (Mac Catalyst),
and tvOS.

Work top to bottom before you hit **Submit for Review**.

---

## 1. Give App Review a way in (Guideline 2.1(a) — App Completeness)

App Review signs in with **their own Apple ID**. Signup is open, so that now
creates a real account for them and satisfies 2.1(a) on its own — but a fresh
account has an empty library, so also provide the demo account below: it is
pre-populated, and it is what the Review notes point at.

- [ ] A throwaway **demo member** exists, with an email in `member_emails` and a
      little sample data on its lists so the app looks alive.
- [ ] Cloudflare Pages secrets are set on the `shows` project:
      ```bash
      printf "demo@example.com" | wrangler pages secret put DEMO_LOGIN_EMAIL   --project-name shows
      printf "424242"           | wrangler pages secret put DEMO_LOGIN_CODE    --project-name shows  # 6 digits
      ```
      - `DEMO_LOGIN_EMAIL` + `DEMO_LOGIN_CODE` → the email/code reviewer login
        (`functions/auth/login.js`).
      - The demo address never receives mail: `request-code` short-circuits it
        and the fixed code is what signs in, so `demo@example.com` is fine even
        though Resend refuses to deliver to it. (Before 2026-08 it didn't
        short-circuit, the refusal surfaced as "Couldn't send the code", and
        that rejected tvOS 1.2 — see `docs/ARCHITECTURE.md#demo-account`.)
      - There is no `DEMO_APPLE_FALLBACK` any more (removed 2026-08). Signup is
        open, so an unrecognized Apple ID becomes a real member instead of
        landing in the demo (`functions/auth/apple.js`).
- [ ] Redeploy so the secrets take effect, then **verify both paths yourself**:
      - Tap *Sign in with Apple* with a personal Apple ID that is not a member →
        you're asked for a name and a fresh account is created.
      - Enter the demo email + code on the login screen → the demo account.
- [ ] Repeat the email + code sign-in **on an Apple TV** (on-screen keyboard) —
      the reviewer exercises the tvOS half of the universal app the same way.
- [ ] Fill in **App Store Connect → App Review Information → Sign-In required**
      with the demo email + code (see Review Notes below).

## 2. Fix the privacy label (Guideline 5.1.2(i) — Data Use and Sharing)

The June 2026 rejection flagged that the App Store Connect privacy label said
the app collects **Name** and **uses it to track**, but the app never calls
AppTrackingTransparency. The app genuinely does **not** track (no ads, no data
brokers, no cross-app tracking — see `public/privacy.html`), so the label is
simply wrong. **Correct the label; do not add the ATT prompt.**

Requires the **Account Holder or Admin** role (that's you).

- [ ] App Store Connect → your app → **App Privacy**.
- [ ] Under **Tracking**, make sure **nothing** is marked "Used to Track You" —
      in particular **Name** must not be. Set tracking to **none**.
- [ ] Data you *do* collect — **Name, email address, phone number, user
      content** (show lists/notes) — is listed under "Data Linked to You",
      purpose App Functionality. This must match `public/privacy.html` and the
      `PrivacyInfo.xcprivacy` manifests in each target, which declare the same
      set. The violation is only the **tracking** flag.
- [ ] Confirm no build adds the `NSUserTrackingUsageDescription` key or calls
      `ATTrackingManager` (it shouldn't — there is no such code).
- [ ] `PrivacyInfo.xcprivacy` present in every target (iOS app, share
      extension, widget extension, watch app, tvOS app) — they declare
      UserDefaults required-reason use and "no tracking". Without them uploads
      draw an `ITMS-91053 Missing API declaration` warning.

## 3. Account deletion (Guideline 5.1.1(v))

Apps that create accounts must offer **in-app** account deletion. All three
account-creating clients have it — verify each before submitting:

- [ ] iOS: account menu → **Delete Account…** (`DeleteAccountView`).
- [ ] tvOS: Account tab → **Delete account…** (`DeleteAccountView`).
- [ ] Web: account panel → Delete account (`public/index.html`).

All ride the same two-step `/api/account-delete` (emailed code → immediate
hard delete). If review asks: deletion is self-service, immediate, and removes
the member row, emails, phones, Apple/Google links, sessions, and show data.

## 4. Reply to the open rejection (historical — only if resubmitting that version)

If you are responding to submission `2333ecb7-98e5-4b27-9df5-67321971226b`
rather than shipping a fresh build, reply to Apple's message in App Store
Connect so the reviewer knows what changed. (For a fresh 1.0.1+ submission,
skip this section.) Draft:

> Thank you for the review.
>
> **2.1(a) — Sign in with Apple:** Sign-up is open, so review can sign in with
> their own Apple ID and land in the app — just tap "Sign in with Apple" on the
> login screen and an account is created. A pre-populated demo email + one-time code is also provided in App
> Review Information if you prefer that route.
>
> **5.1.2(i) — Tracking:** The app does not track users — it uses no
> advertising, data brokers, or cross-app tracking. We have corrected the App
> Privacy information so that no data is marked as used to track. No
> AppTrackingTransparency prompt is required because the app does not track.

## 5. Review Notes to paste into App Store Connect

```
This is a TV-show tracking club with open sign-up.

To sign in, either:
  • Tap "Sign in with Apple" — you'll be asked for a name and a new
    account is created for you.
  • Or use the demo login on the same screen (a pre-populated account):
      Email: <DEMO_LOGIN_EMAIL>
      Code:  <DEMO_LOGIN_CODE>

The app does not track users: no advertising, data brokers, or cross-app
tracking, so no App Tracking Transparency prompt is presented.
```
(Fill in the real demo email/code — keep them out of git.)

## 5a. App Store Connect gotchas (hit during the July 2026 resubmission)

- [ ] **Demo secrets have no trailing newline** — set them with `printf`,
      never `echo`. `login.js` compares the code exactly, so a newline in
      `DEMO_LOGIN_CODE` makes every login fail. Secrets only take effect on
      the **next deployment** — redeploy after setting them
      (`wrangler pages deploy public --project-name=shows --branch=main
      --commit-dirty=true`, or re-run the deploy workflow).
- [ ] **App Privacy label**: every collected data type (Name, Email, Phone,
      Other User Content) reads *App Functionality* + *Linked to the user's
      identity*, nothing under tracking — identical to the
      `PrivacyInfo.xcprivacy` manifests. Edits sit as drafts: hit
      **Publish** or they don't count.
- [ ] **Apple TV privacy policy is pasted TEXT, not a URL** (tvOS has no
      browser). App Privacy → Privacy Policy → the Apple TV field wants the
      plain-text rendering of `public/privacy.html`. Blocks Add for Review
      if empty. **Because it is a paste, it does not track edits to the
      file** — re-paste whenever `public/privacy.html` has changed since the
      last submission. `git log -1 --format=%as public/privacy.html` gives
      the date it last changed; the policy's own "Last updated" line should
      match what you paste. **Outstanding: it changed 2026-08-03** (retired
      OMDB dropped from the third-party list; the operator-adds-you signup
      path removed) and has not been re-pasted since.
- [ ] **Version Number field on each platform's version page** matches
      `MARKETING_VERSION` — a page created as 1.0 keeps saying 1.0 until
      edited, even with a 1.0.1 build attached.
- [ ] **Age-rating questionnaire updates** (e.g. the 2026 social-media
      questions) answered — for this app: no chat/messaging, no public UGC;
      lists and notes are visible only inside the private club.

## 5b. Deferred Apple-side cleanup (carried from the 2026-08 approval removal)

Backend approval was removed in migration 058, but the Apple targets were
deliberately left on known-good code so the launch archive wouldn't build
from unverified edits. Both items below are safe to leave — nothing is
broken — but clear them in the first build after the apps have shipped.

- [ ] **tvOS still credits the retired OMDB.** `GroupsListViewTV.swift` and
      `tvos/ShowPickerTV/HomeView.swift` display "Ratings and metadata from
      IMDb (via OMDb) and TMDB". TMDB has been the sole source since
      2026-07. Replace with the string iOS and the web already use:
      "Ratings and metadata from TMDB. This product uses the TMDB API but is
      not endorsed or certified by TMDB." (iOS is already correct — only its
      code comments mention OMDb.)
- [ ] **Strip the inert approval queue from the iPhone/iPad app.** The
      endpoints it calls are gone, so it renders empty and degrades cleanly
      (see the note in `docs/ARCHITECTURE.md` under [Frontend pages](ARCHITECTURE.md#frontend-pages)). To
      remove: the queue sections in `ManageMembersView.swift`,
      `SignupRequest`/`CreateMemberResult` in `Models.swift`,
      `signupRequests()`/`actOnSignupRequest()`/`approveMember()` in
      `API.swift`, `WelcomeIntroPanel.swift`, and the `AdminView` waiting
      badge.

## 6. Standard build hygiene

- [ ] Build/version number bumped and archived from a clean release build.
      `MARKETING_VERSION` must match across the iOS and tvOS targets (one
      universal listing). Three archives: iOS (Any iOS Device), macOS
      (Any Mac — Mac Catalyst, built from the iOS project so it shares the
      same version/build), and tvOS (Any tvOS Device).
- [ ] Launch on an **iPad** (Review used an iPad Air 11-inch / M3) — 2.1(a) was
      caught on iPad, so exercise the full flow there, not just iPhone.
- [ ] Launch on an **Apple TV** (device or simulator): sign in with the demo
      email + code, confirm Sign in with Apple presents (entitlement is set on
      both Debug and Release configs), and confirm Delete account is reachable.
- [ ] Export compliance: `ITSAppUsesNonExemptEncryption = NO` is set in both
      the iOS and tvOS build settings, so uploads shouldn't stall on the
      compliance prompt.
- [ ] Screenshots and metadata current — including the **Mac** and **Apple
      TV** screenshot sets on the same listing.
- [ ] **What's New text** filled in from `docs/RELEASE_NOTES.md` (the
      *Unreleased* section). After the version ships, move that section under
      its version and date and open a fresh *Unreleased*.
- [ ] Verify the demo sign-in once on the **Mac** build too — Review opens
      every platform on the listing.

## 6a. Run sheet: releasing from a second Mac

Written for 1.4.1, but the shape is every release. The development Mac
(PaddyMac) runs **Xcode beta**, which cannot be used for App Store archives —
so the archive is cut elsewhere and that machine needs nothing but a pull.

**Before you start, on the archiving Mac:** a release (non-beta) Xcode, signed
into the Apple ID with App Store Connect access for Show Picker Club, and a
clone of this repo.

**1. Get the code.**

```
cd <path-to>/Show-Picker-Club
git checkout main
git pull
```

**2. Confirm the version without opening Xcode.** Both must print `10` and `2`
respectively, and the stale-value check must print nothing:

```
grep -c "MARKETING_VERSION = 1.4.1;" ios/ShowPickerIOS.xcodeproj/project.pbxproj
grep -c "MARKETING_VERSION = 1.4.1;" tvos/ShowPickerTV.xcodeproj/project.pbxproj
```

**Do not bump the build number.** 1.4.1 / build 24 is already committed in both
projects. Build 24 was never uploaded to Apple, so the number is still free
even though several test builds have carried it.

**3. Open the workspace** — `ShowPickerClub.xcworkspace` at the repo root, not
either `.xcodeproj`. The workspace is what wires in the `ShowPickerCore`
package.

**4. Three archives**, per §6: iOS (Any iOS Device), macOS (Any Mac — Mac
Catalyst, from the iOS project so it shares the version and build), tvOS (Any
tvOS Device, `ShowPickerTV` scheme). Product → Archive each, then Distribute →
App Store Connect.

A `Stamp git commit` build phase runs during the archive and writes the commit
into Info.plist so the account menu can show it. It needs command-line `git`;
without it the value reads `unknown` and the app drops the suffix. Harmless
either way — it never fails the build.

**5. Create the version records — in the web UI, not the API.** All three
platforms shipped 1.4.1's predecessor, so each needs a *new* 1.4.1 record and
none can be renamed from an unsubmitted one.

Use **＋ Version or Platform** in App Store Connect. Do not reach for
`POST /v1/appStoreVersions`: it refuses with *"You cannot create a new version
of the App in the current state"* whenever a release is in flight on another
platform, and a throwaway version string draws the same error — the block is
the app's state, not the version number. This cost real time in 1.4; the UI
creates the record without complaint.

**6. Paste the What's New text** from the current version's section in
`docs/RELEASE_NOTES.md` — the fenced block, **byte for byte identical on all
three platforms**. 1.4.1's is 2,560 characters against Apple's 4,000 cap, so
no trimming; 1.4 needed roughly 1,700 characters cut and that is worth
checking before you paste rather than after.

**7. Work §6's hygiene list** — iPad and Apple TV launches, demo sign-in on
Mac, screenshots, export compliance — then submit.

**8. After it ships:** move the version's section in `docs/RELEASE_NOTES.md`
under its release date and open a fresh *Unreleased*.

## 7. The marketing site's App Store link

The web member app was removed in 2026-08, so there is no longer a banner
riding on top of it — `showpicker.club` **is** the App Store pitch. Two things
still point at the listing, and both live in `public/index.html`:

- The **call-to-action button**, hard-coded to
  `https://apps.apple.com/app/id6780282764`. Its wording adapts per device
  (iPhone / iPad / Mac); the destination never does, because one universal
  listing covers iPhone, iPad, Mac and Apple TV.
- The native **Smart App Banner** via `<meta name="apple-itunes-app">`, which
  iPhone/iPad Safari renders as OPEN when the app is installed and GET when it
  isn't. This is the only "is it installed" signal a browser gets, and Apple
  renders it — there is no JS API for it, and the custom-URL-scheme probe trick
  fires an OS dialog and fails silently in Safari.

`public/app-banner.js` — the custom dismissible bar for Chrome/Firefox on Apple
hardware — came back with the member app in the 2026-08 restore. It promotes the
app *from inside* the web app, which is again where a browser member sits; the
marketing page at `/` needs no such bar, being the promotion already.

- [ ] If the listing is ever re-created under a new Apple ID (App Store
      Connect → the app → App Information → "Apple ID"), update **both** the
      CTA `href` and the `apple-itunes-app` meta tag in `public/index.html`
      (currently `6780282764`, the July 2026 listing).

