# App Store Submission Checklist

A pre-flight list for every App Store submission of Show Picker Club. It exists
because the app is invite-only with no public sign-up, which trips up App Review
in two predictable ways — a login wall and a privacy-label mismatch. Both are
covered below.

The listing is **universal**: one bundle id covers iPhone + Mac (Catalyst) +
Apple TV (the watch app rides along with the iOS build), so one submission
reviews every surface — work the checklist for **iPhone/iPad, Mac, and Apple
TV**. That means **three archives** per submission: iOS, macOS (Mac Catalyst),
and tvOS.

Work top to bottom before you hit **Submit for Review**.

---

## 1. Give App Review a way in (Guideline 2.1(a) — App Completeness)

App Review signs in with **their own Apple ID**, which is not a member, so a
strict invite-only build shows them an error and gets rejected ("unable to log
in with Sign in with Apple"). Open the demo door before submitting.

- [ ] A throwaway **demo member** exists, with an email in `member_emails` and a
      little sample data on its lists so the app looks alive.
- [ ] Cloudflare Pages secrets are set on the `shows` project:
      ```bash
      printf "demo@example.com" | wrangler pages secret put DEMO_LOGIN_EMAIL   --project-name shows
      printf "424242"           | wrangler pages secret put DEMO_LOGIN_CODE    --project-name shows  # 6 digits
      printf "1"                | wrangler pages secret put DEMO_APPLE_FALLBACK --project-name shows
      ```
      - `DEMO_LOGIN_EMAIL` + `DEMO_LOGIN_CODE` → the email/code reviewer login
        (`functions/auth/login.js`).
      - `DEMO_APPLE_FALLBACK=1` → **Sign in with Apple** by an unrecognized Apple
        ID lands in that same demo member (`functions/auth/apple.js`). This is
        the piece that fixes the 2.1(a) rejection.
      - **Exception — self-enroll live:** with the `SELF_ENROLL` secret set,
        the Apple handler enrolls an unrecognized Apple ID as a brand-new
        member and `DEMO_APPLE_FALLBACK` is inert (`functions/auth/apple.js`).
        That also satisfies 2.1(a) — the reviewer signs up like anyone else.
        In that mode skip `DEMO_APPLE_FALLBACK`, keep the demo email/code for
        the Review notes, and expect Apple sign-in to create a fresh account
        in the verification below.
- [ ] Redeploy so the secrets take effect, then **verify both paths yourself**:
      - Tap *Sign in with Apple* with a personal Apple ID that is not a member →
        you land in the demo member's account (or a fresh self-enrolled one,
        if `SELF_ENROLL` is on).
      - Enter the demo email + code on the login screen → the demo account.
- [ ] Repeat the email + code sign-in **on an Apple TV** (on-screen keyboard) —
      the reviewer exercises the tvOS half of the universal app the same way.
- [ ] Fill in **App Store Connect → App Review Information → Sign-In required**
      with the demo email + code (see Review Notes below).

**Making it public instead of review-only:** leave `DEMO_APPLE_FALLBACK=1` on
permanently and anyone can try the app via Sign in with Apple; they share the
one demo member. To go back to a strict invite-only wall, unset the secret:
```bash
wrangler pages secret delete DEMO_APPLE_FALLBACK --project-name shows
```

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
      extension, watch app, watch complication, tvOS app) — they declare
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
> **2.1(a) — Sign in with Apple:** The app is an invitation-only club. We have
> enabled a demo path so review can sign in with their own Apple ID and land in
> a fully functional demo account — just tap "Sign in with Apple" on the login
> screen. A demo email + one-time code is also provided in App Review
> Information if you prefer that route.
>
> **5.1.2(i) — Tracking:** The app does not track users — it uses no
> advertising, data brokers, or cross-app tracking. We have corrected the App
> Privacy information so that no data is marked as used to track. No
> AppTrackingTransparency prompt is required because the app does not track.

## 5. Review Notes to paste into App Store Connect

```
This is an invitation-only TV-show club (no public sign-up).

To sign in, either:
  • Tap "Sign in with Apple" — an unrecognized Apple ID is signed into a
    fully functional demo account.
  • Or use the demo login on the same screen:
      Email: <DEMO_LOGIN_EMAIL>
      Code:  <DEMO_LOGIN_CODE>

The app does not track users: no advertising, data brokers, or cross-app
tracking, so no App Tracking Transparency prompt is presented.
```
(Fill in the real demo email/code — keep them out of git.)

**Self-enroll variant** — with `SELF_ENROLL` on, Apple sign-in creates a
fresh account instead of landing in the demo, so use this wording:

```
This is an invitation-only TV-show club. New members can also self-enroll.

To sign in, either:
  • Tap "Sign in with Apple" — you'll be asked for a name and a new
    account is created for you.
  • Or use the demo login on the same screen (a pre-populated account):
      Email: <DEMO_LOGIN_EMAIL>
      Code:  <DEMO_LOGIN_CODE>

The demo code is entered in the app's own login screen (it is a fixed
code, not sent by email).

The app does not track users: no advertising, data brokers, or cross-app
tracking, so no App Tracking Transparency prompt is presented.
```

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
      if empty.
- [ ] **Version Number field on each platform's version page** matches
      `MARKETING_VERSION` — a page created as 1.0 keeps saying 1.0 until
      edited, even with a 1.0.1 build attached.
- [ ] **Age-rating questionnaire updates** (e.g. the 2026 social-media
      questions) answered — for this app: no chat/messaging, no public UGC;
      lists and notes are visible only inside the private club.

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
- [ ] Verify the demo sign-in once on the **Mac** build too — Review opens
      every platform on the listing.

---

### Why these two keep coming up

Both stem from the invite-only model: there is no public account, so anything
that assumes a real user (the login, the "we collect Name" label) needs an
explicit accommodation for a reviewer who is a stranger to the club. Steps 1
and 2 are that accommodation.
