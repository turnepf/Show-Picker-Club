# Invariants

Rules that hold across the whole product, each one written down because
breaking it has already cost something. Three things enforce them, and they
catch different classes of mistake:

| Enforcer | When | Catches |
|---|---|---|
| `scripts/check-static.sh` | every PR | Repo-shape facts: gates present, redirects present, AASA well-formed |
| `ShowPickerCore` tests (`swift test`) | every PR | Logic in the shared core, including session teardown |
| Passkey tests (`scripts/webauthn-test.mjs`, `scripts/passkey-flow-test.mjs`) | every PR | Passkey signature verification and the endpoint flows around it |
| Auth code tests (`scripts/auth-code-flow-test.mjs`) | every PR | The email login/signup code flow: codes that arrive, and failures that are reported |
| `scripts/smoke.sh` | after deploy, and nightly | Live behavior: auth gates, headers, leakage, redirects |
| Invariants review (`.github/workflows/pr-review.yml`) | every PR | Judgement calls the four above can't express |

The review workflow reads *this file* and checks the diff against it, so adding
a rule here is how you extend it. Write rules as things that must be true, and
say what broke when it wasn't.

---

## 1. Nothing member-derived is public

Public surface is deliberately tiny: roster first names, Trending, catalog-level
show detail, and the auth endpoints. Everything computed from a member's library
requires a session.

- Every file under `functions/api/` calls `getSession`, `getAdminSession`,
  checks `isAdmin`, validates `CRON_SECRET`, or is a 410 stub. The only
  exceptions are named in `PUBLIC_ENDPOINTS` in `scripts/check-static.sh`, and
  adding one there is a decision, not a formality.
- A public endpoint must not name members. `/api/popular` is the worked
  example: it returns titles to anyone, but only fills in `members` for people
  in the caller's own groups, because "added by" needs a relationship a stranger
  doesn't have.
- *Closed 2026-08:* `functions/api/shows/suggest.js` used to take an
  unauthenticated POST and proxy TMDB/OMDB — no member data, but an open tap on
  our upstream quota. It requires a session now. It was found by
  `check-static.sh` on the day that check was written, which is the argument
  for the check.

## 2. Session-derived UI state dies with the session

*Broke in 2026-08.* Logging out on Mac and iPad left the signed-in sidebar on
screen — a focused member above their four lists, the roster below with
everyone's show counts — and every row 401'd on tap. `AuthStore.logout()` had
cleared the session; it could not reach the views' `@State`.

- State derived from a session lives in `SessionScope`
  (`ShowPickerCore/Sources/ShowPickerCore/SessionScope.swift`), not in loose
  `@State` properties on a view.
- `clear()` reassigns the whole value, so a property added later is torn down
  by construction. Don't rewrite it to nil fields one at a time.
- Visibility rules must fail safe independently of teardown:
  `visibleMemberSlugs(mySlug:)` answers "nobody" when signed out regardless of
  what it still holds. Two independent guards, because one of them will
  eventually be forgotten.
- A new view holding session-derived state adopts `SessionScope` and clears it
  when `auth.memberSlug` goes nil.

## 2a. A session arriving refreshes what was loaded without one

*Broke in 2026-08, shipped in 1.2 (build 21).* Home resolves the signed-in
member as `members.first { $0.slug == auth.memberSlug }`, and the roster is
fetched once, on first appearance. Someone who **signed up** inside that
session was not in the copy the app already held, so `myMember` stayed nil and
Home silently lost My Shows, Groups, Calendar, Rate My Shows, Subscription
Audit and Vibe — leaving Trending and nothing else. Adding a show still worked
from cross-library search (it posts against `auth.memberSlug` directly), which
is exactly how it was reported: *"couldn't add shows except from other people's
lists; force-quitting fixed it."*

- `HomeView` and `IPadHomeView` refetch on `auth.memberSlug` becoming non-nil,
  not only on becoming nil. Logout teardown (invariant 2) is half the rule.
- `HomeView.load()` owns the replay of a parked universal link: it clears
  `pendingLink` and routes it *after* the roster lands. That has been true
  since link-parking shipped — the sign-in handler leans on it rather than
  re-implementing it, which is why a diff that changes sign-in behavior won't
  show it. A link that waited for a session is therefore routed against the
  fresh roster, not the stale one.
- Anything else keyed off the roster — a new view resolving "me", or a count —
  inherits the same requirement: a fetch that predates the session is stale the
  moment the session exists.
- Enforced by `scripts/check-static.sh` ("signing in refetches the roster").

## 3. Member-page URLs stay universal links

`showpicker.club/<slug>` must keep falling through `_redirects` as a **200
rewrite**, never a 301. iOS and macOS resolve the URL against
`.well-known/apple-app-site-association` before any request goes out, so the
app opens either way — but a redirect throws away which member the link was
about on every device that doesn't have the app.

- The AASA file keeps its `/*` claim and its `/api/*`, `/auth/*`, `/calendar/*`
  and `/.well-known/*` exclusions. A path the app can't render must be excluded
  or iOS swallows the link and shows the user nothing.
- It must be served as `application/json` (it has no file extension, so Pages
  would otherwise guess). Apple's CDN caches it for hours, so a bad deploy is
  slow to undo.
- The new-signup operator email depends on all of this: its button is a member
  page precisely so it opens the app.
- The file's `webcredentials` block, and the matching
  `webcredentials:showpicker.club` in **both** entitlement files, are what let
  the app use a passkey scoped to the domain. Lose either half and passkey
  sign-in fails with nothing in the logs to explain it.

## 3a. A passkey is added from a session, never in place of one

Registering a passkey requires an existing session; signing in with an
unrecognized credential is refused, not enrolled. A passkey is therefore always
an *addition* to an account someone already proved was theirs — which is also
why removing every passkey is safe, and why `DELETE /api/passkeys/:id` needs no
"last credential" guard.

- Challenges are single-use and typed. A `register` challenge cannot authorize
  a sign-in, an `authenticate` challenge cannot enroll a credential, and a
  registration challenge minted for one member cannot be completed by another.
- A credential id already registered is never re-pointed at a second account.
- `/auth/passkey-begin` takes no identifier and answers identically for
  everyone — it must not become a way to probe who is a member.
- Enforced by `scripts/passkey-flow-test.mjs` (endpoint flows) and
  `scripts/webauthn-test.mjs` (signature verification), both in `pr-checks.yml`.

## 4. The web is a marketing site

Retired 2026-08 (`docs/PRODUCT.md#web-app-status`). `public/` holds the
marketing page, the three legal pages, and their assets — nothing else. The
member app and admin tools live in `archive/web/`, outside the build output.

- No member-facing feature is built for the web.
- Nothing under `public/` may reintroduce sign-in UI.
- The CSP carries only what the marketing page loads. The Apple/Google/Turnstile
  sources went with web sign-in and should not come back.
- Comments in `_headers` stay at column 0 — Pages parses an indented line inside
  a rule block as a header and silently corrupts the block.

## 5. `updated_at` means member intent

Only member-initiated writes bump `updated_at`; enrichment writes `enriched_at`.
`updated_at != created_at` is how the app tells a member's action apart from a
background job. Seeded rows have NULL `created_at`/`updated_at` and
`added_by='seed'`, and the "seed-only member" check depends on exactly that
signature.

## 6. Enrollment is the only way a member row appears

`createMember()` is called from one place, `functions/_shared/enroll.js`. There
is no operator-created path and no approval step. Anything that needs a member
to exist goes through enrollment.

## 6a. A requested code arrives, or the caller is told why

*Broke in 2026-08.* App Review rejected tvOS 1.2 under 2.1(a): "unable to
receive the OTP code to sign in with email (no code received even when using
any other email)". Two separate faults, both invisible from the code:
`request-code` mailed a login code to `DEMO_LOGIN_EMAIL` — a reserved domain
Resend refuses with a 422, surfaced as a 502 one screen before the fixed demo
code would have worked — and the signup-code branch re-checked a Turnstile
token, which fails closed for native clients and dropped every signup code the
apps asked for behind `{success: true}`.

- The demo login never depends on a mailbox. `request-code` sends nothing for
  `DEMO_LOGIN_EMAIL`; `DEMO_LOGIN_CODE` is what signs in.
- Turnstile is a web-only gate, checked once, at the front door. Nothing
  downstream re-checks the token: it is single-use, and native clients have
  none.
- A guard that stops abuse may fail silently. A failed *delivery* may not — it
  says nothing about who is a member, so it returns `502 send_failed` for
  members and strangers alike, and the apps say so instead of blaming the
  network.
- Enforced by `scripts/auth-code-flow-test.mjs`, whose fake Resend refuses
  reserved domains the way the real one does.

## 6b. One definition of "what's on the calendar"

*Broke in 2026-08.* The Up Next widget read `next_season_date` alone while the
Calendar screen and the `.ics` feed also carried season finales, so the widget
sat empty for weeks whenever nothing on the member's lists had an announced
premiere — a home-screen widget that shows nothing most of the time.

- The dated-events rule lives once, in
  `ShowPickerCore/Sources/ShowPickerCore/ShowCalendar.swift`. Anything on Apple
  that answers "what's next" calls `ShowCalendar.upcoming`/`next` rather than
  filtering `nextSeasonDate` itself.
- Both dates count. A show contributes its premiere *and* its finale as
  candidates; the sooner one represents it, so no show appears twice.
- A row says which date it is showing ("Premieres Aug 20" / "Finale Aug 14").
  An undifferentiated date reads as a premiere and is wrong half the time.
- `yyyy-MM-dd` values are calendar days: parse them in the device time zone and
  compare against `Calendar.current.startOfDay`. A UTC parse loses today's date
  and displays every row a day early for anyone west of UTC.
- Enforced by `ShowCalendarTests` in `ShowPickerCore`.

## 7. Platform parity is stated, not assumed

iOS/iPad get features; tvOS is view-only; watchOS is read-only. When a feature
lands, say which platforms it reaches. Home leads and Home is the launch screen
on every platform (`docs/PRODUCT.md#navigation-standard`).

The statement lives in the repo, not in a pull request description: a
`Platforms:` line in the feature's `docs/PRODUCT.md` section (see Passkeys and
"Also watching" for the shape), naming the targets that don't get it and why.
A PR body is not the record — it isn't checked out, isn't greppable a year
later, and isn't what the next person reads.

- Enforced by the invariants review, which is shown this PR's `docs/PRODUCT.md`
  and `docs/ARCHITECTURE.md` diff alongside the code for exactly this rule.
  Silence in the docs is the violation; a client that deliberately skips a
  feature is not.

---

## Adding an invariant

Add a section here, then decide which enforcer covers it. Prefer a deterministic
check — an assertion in `check-static.sh` or `smoke.sh`, or a test in
`ShowPickerCore` — and leave it to the review workflow only when the rule needs
judgement. A rule with no enforcer is a comment, and comments don't fail builds.
