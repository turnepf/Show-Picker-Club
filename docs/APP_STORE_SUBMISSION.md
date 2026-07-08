# App Store Submission Checklist

A pre-flight list for every App Store submission of Show Picker Club. It exists
because the app is invite-only with no public sign-up, which trips up App Review
in two predictable ways — a login wall and a privacy-label mismatch. Both are
covered below.

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
- [ ] Redeploy so the secrets take effect, then **verify both paths yourself**:
      - Tap *Sign in with Apple* with a personal Apple ID that is not a member →
        you land in the demo member's account.
      - Enter the demo email + code on the login screen → same result.
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
- [ ] Data you *do* collect (Name, phone, user content) can stay listed under
      "Data Linked to You" / "Data Not Linked to You" as appropriate — that is
      fine. The violation is only the **tracking** flag.
- [ ] Confirm no build adds the `NSUserTrackingUsageDescription` key or calls
      `ATTrackingManager` (it shouldn't — there is no such code).

## 3. Reply to the open rejection (if resubmitting the same version)

If you are responding to submission `2333ecb7-98e5-4b27-9df5-67321971226b`
rather than shipping a fresh build, reply to Apple's message in App Store
Connect so the reviewer knows what changed. Draft:

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

## 4. Review Notes to paste into App Store Connect

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

## 5. Standard build hygiene

- [ ] Build/version number bumped and archived from a clean release build.
- [ ] Launch on an **iPad** (Review used an iPad Air 11-inch / M3) — 2.1(a) was
      caught on iPad, so exercise the full flow there, not just iPhone.
- [ ] Screenshots and metadata current.

---

### Why these two keep coming up

Both stem from the invite-only model: there is no public account, so anything
that assumes a real user (the login, the "we collect Name" label) needs an
explicit accommodation for a reviewer who is a stranger to the club. Steps 1
and 2 are that accommodation.
