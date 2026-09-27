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
| Activity feed tests (`scripts/activity-feed-test.mjs`) | every PR | `/api/activity` stays session-gated, `?member=` shows only what that member chose, bulk adds collapse per list |
| Admin member detail tests (`scripts/admin-member-detail-test.mjs`) | every PR | `/api/admin-member-emails` stays admin-only, and `?member=` returns that member and nobody else |
| Reporting platform tests (`scripts/reporting-platform-test.mjs`) | every PR | `/api/reporting` stays admin-only, and its people numbers count people rather than sessions or devices |
| List import tests (`scripts/import-list-test.mjs`) | every PR | The paste-a-list path: what a model may and may not put in the database, paging, and the commit-side validation |
| Network tests (`scripts/networks-test.mjs`) | every PR | The canonical table: a name claimed by two services, and the catalog `/api/networks` serves to the apps |
| Enrichment identity tests (`scripts/enrich-identity-test.mjs`) | every PR | A stored `tmdb_id` is the row's identity: enrichment never re-guesses a pinned row by title, and propagation never crosses two entries sharing one title |
| Movie enrichment tests (`scripts/enrich-movie-detail-test.mjs`) | every PR | A background pass selects on every field it writes — the movie detail pass is not gated on artwork alone, and its gaps counter matches its selection |
| Streaming-services tests (`scripts/enrich-movie-detail-test.mjs`) | every PR | Enrichment never overwrites a member's `network`; TMDB's current services land in `streaming_on` beside it, refreshed authoritatively and canonicalized |
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

## 2b. A universal link resolves against a roster new enough to contain it

*Broke in 2026-08, found from the signup notification email.* `route(url:)`
matched the slug against the roster already in memory and, on a miss, did
nothing unless the roster was empty. Empty meant cold launch, which was parked
and replayed correctly — so the failure only appeared on a **warm** app, where
the roster is non-empty and predates the member being linked to. That is
precisely the case the operator's "new member joined" email produces: tapping
*Open Stacy's page* opened the app, matched nothing, and left you on Home
looking at a link that appeared to do nothing.

- A member slug that misses the loaded roster refetches once and replays,
  rather than being dropped. Both `HomeView` and `IPadHomeView` — the iPad
  ignored the link just as silently.
- The replay is bounded: `load()` re-routes with `allowRefetch: false`, so an
  unresolvable slug gives up instead of refetching forever.
- Generally: a roster miss is "my copy is old" until a fresh fetch says
  otherwise. The roster is not a closed world — anyone can sign up at any
  moment, and the links that matter most point at whoever just did.

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

## 4. The catch-all can only point at `/index.html`

Restored 2026-08 after four weeks archived (`docs/PRODUCT.md#web-app-status`).
The app is the site root; the marketing page is a real page at `/download`.

- `public/_redirects` ends with `/*  /index.html  200` and nothing else. A
  `.html` destination is canonicalized to its extensionless form with a 308 and
  loops every path on the site; an extensionless one stops being a fallback and
  swallows real files, the AASA included. Both were tried against
  `wrangler pages dev` on 2026-08-13, one of them in production.
- Therefore **`public/index.html` is the app**. Nothing else can answer
  `/patrick`, and there must be no `app.html` for a rewrite to aim at.
- The catch-all stays a **200 rewrite**. As a 301 it discards the URL, and a
  shared `/patrick` link stops carrying who it was about — which is also what
  iOS matches against the associated-domains file.
- `index.html` carries the fallback `og:image`: every URL without tags of its
  own previews from whatever the catch-all serves.
- Restored pages must not be redirected. The catch-all renders the app at every
  path, so a stale 301 fails quietly rather than 404ing.
- The CSP carries the Apple, Google and Turnstile sources web sign-in needs. Each
  fails silently without them: the button renders, the flow never completes.
- Comments in `_headers` stay at column 0 — Pages parses an indented line inside
  a rule block as a header and silently corrupts the block.
- The web is frozen at its restored state: fixes keep it functional, new
  member-facing features go to iOS/iPad only. Falling behind is the intent, not
  a defect to close.

- Enforced by `scripts/check-static.sh` (the file set, index.html being the app,
  no `app.html`, the catch-all's exact destination, the absent redirects, the
  CSP sources) and `scripts/smoke.sh` (the same properties against the deployed
  site, plus `/patrick` answering 200 rather than a redirect).

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

## 8. A model's output is content, never an identifier

Claude is on a write path now (`/api/import/parse` → `/api/import/commit`), and
the rule that makes that safe is that the model supplies **text** and the
existing sources of truth supply **identity**.

- A title comes from the model. The `tmdb_id`, canonical spelling, poster and
  year come from TMDB, which is the only thing that says a title exists.
- The model is never asked for an id, and the extraction schema has no field
  for one. A model asked for an id will produce a plausible one.
- Nothing a model produced reaches the database without passing the same
  validation a hand-typed value would: the list must be one of the four,
  `poster_url` must be on `https://image.tmdb.org/`, `tmdb_id` must be an
  integer, strings are trimmed and length-capped.
- Nothing a model produced is written without a member confirming it. Parse
  writes nothing; commit writes what the member reviewed.

This generalises past the importer: if a second model-backed write path appears,
these four points are the bar it has to clear.

Enforcer: `scripts/import-list-test.mjs` (a deliberately badly-behaved fake
Claude returns a hallucinated id and an unknown title, and asserts neither
reaches the database), plus this file for the general rule.

## 9. An import is bounded, and says so when it stops

A paste has no length limit, but every request it turns into does.

- `/api/import/parse` processes one slice per call and returns the cursor for
  the next, because a Claude call and a TMDB search per title are both bounded
  per Worker invocation.
- Slices cut on line boundaries and carry the section heading forward. A slice
  that starts mid-list without its heading misclassifies everything under it.
- `/api/import/commit` has its own daily ceiling (300 rows/member, imports and
  hand-adds together) rather than borrowing or bypassing the 50/day human-pace
  cap on `/api/shows`.
- `/api/import/parse` has its own daily ceiling too — 100 slices (Claude
  calls) per member, counted in `member_spend` (§28) — because parse writes no
  row that commit's cap could count. Bounding each invocation bounds nothing
  about how many invocations one member makes.
- A failure surfaces. A Claude outage returns 502, not an empty list — an empty
  list means "no titles in that text", and the two must never look alike.

Enforcer: `scripts/import-list-test.mjs`.

## 10. A club-level exclusion bounds math, never visibility

`EXCLUDED_FROM_TASTE` (`functions/_shared/excluded-members.js`) exists so one
sprawling library can't skew what the *club* computes — Trending, the
recommendation neighbour pool, the aligned-picks candidate pool. It is a filter
on aggregate arithmetic, not a status the member carries around, and it must
never decide who is allowed to look at something.

- Visibility has exactly one gate: group membership. `/api/vibe` lists the
  viewer plus their group-mates and serves the same full profile for all of
  them, whatever list anyone is on. Using the exclusion as a second gate made
  one member invisible to the group-mates whose vibes she could read — inside a
  group whose members can already open each other's libraries.
- A member always reads their own data, whatever any list says.
- Catalog work is club-wide. `/api/admin-vibe-fill` scores every active title,
  including titles only an excluded member holds — `show_traits` describes a
  title, it doesn't count anyone's taste. Skipping them is how the exclusion
  reaches its own member by the back door: a profile computed from the handful
  of her titles somebody else happens to share.
- Any new exclusion list gets the same reading. Scope it at the query that
  computes a shared signal, never at the endpoint that serves a member their
  own.

Enforcer: `scripts/vibe-scope-test.mjs`.

## 11. Reporting counts people, not rows or devices

Every activity number on `/api/reporting` answers "how many people", not "how
many database rows happened to exist". Sessions are the wrong unit and always
flatter: a reinstall, a re-login, an iPhone plus a browser tab and an Apple TV
all mint their own `sessions` row, so a two-member club read "13 iPhone / 22 /
31" on the platform breakdown — thirteen phones' worth of activity from one
person and a spare device.

**Devices are the wrong unit too, and for the same reason.** One member signed
in on three Apple TVs, two Macs or four Rokus is one user. Every per-person
count groups by the same expression — `COALESCE(member_slug, 'email:' ||
email)`, defined once as `PERSON` in `functions/api/reporting.js` — so a person
is a person on every row of the dashboard rather than per query. The fallback
is for rows that predate `member_slug` (nothing mints one now, and a session
lives 30 days): they dedupe on the identity they do carry, so one household's
old devices collapse into one person and two strangers stay two. The `email:`
prefix is what keeps a legacy identity from ever colliding with a real slug.

- Active members, Active-by-platform and How-people-sign-in all count distinct
  people. Someone on two platforms — or using two sign-in methods — counts once
  on each row, so those rows deliberately don't sum to Active members. Say so
  in the UI rather than letting a reader add them up, and don't print a total
  over rows that can double-count a person.
- Counts of *events* — ratings submitted, shows added, calendar fetches — stay
  counts of events. The rule is that the label says which it is: "people who
  rated" and "ratings submitted" are two rows for a reason.
- **What couldn't be attributed is omitted, not labelled "Unknown".** A session
  with no `platform`, or no `auth_method`, says only that the dashboard failed
  to ask — a fact about the instrumentation, not about anybody's viewing or
  sign-in. Those people still count once in Active members, so the platform
  rows can sum to *less* than it as well as more. Say that in the UI. The
  corollary is that the fix for an unattributed session is to capture the
  value, never to invent a bucket for it: `/auth/check` is the only writer of
  `sessions.platform`, so every client call must carry `X-Client-Platform`
  (gated by `scripts/check-static.sh` for the web pages).

Enforcer: `scripts/reporting-platform-test.mjs`.

## 12. A write into someone else's library needs a relationship, and stops at their choices

Cross-member writes were retired in 2026-07 — suggest-a-show and
share-to-member still return 410 — because *any* logged-in member could put
rows on *any* other member's list, and self-enrollment meant members are no
longer all friends. "Watching With" naming a group-mate (migration 064)
reopens that door deliberately, on much narrower terms. Those terms are the
invariant, not the feature.

- **Shared group membership is the gate.** Every slug arriving from a client
  is validated against `group_members` before anything is written. A slug for
  someone the caller shares no group with is dropped — the rest of the save
  proceeds, but nothing lands. A member of the club you have no group with is
  as unreachable as a stranger, which is the point: a group is a relationship
  both people opted into, and a bare "is a member" check is not.
- **Their existing choices are read-only to you.** A copy they already have is
  linked where it sits — same list, same order, no duplicate, no promotion.
  Only a title they don't have is created. Anything else is a stranger
  rearranging their lists.
- **Nothing you write is unremovable, and removing it is bounded.** Unlinking
  takes your name off their copy and leaves the show on their list. The write
  can be undone by the person who made it; the *consequences* of it on their
  library can only be undone by them.
- **The fan-out is capped** (`MAX_WATCHERS`), and cleanup is symmetrical:
  deleting your own copy takes your name off every row that mirrors it. A
  cascade only reaches the links hanging off the row being deleted, so the
  mirrors have to be swept explicitly or a deleted show leaves its owner's
  name on other people's lists permanently.
- **The write is legible to its recipient.** A copy created by someone else's
  tag tells its owner who put it there: the owner's reads resolve `added_by`
  to the member it names (`added_by_member`), and the show card renders it. A
  title appearing on your list with no explanation reads as a breach even
  when it isn't one — Paula reported exactly that — so the one write another
  member can make into your library must never be anonymous to you. Owner-only,
  like every other personal field on the row.
- **A new cross-member write is a decision, not a refactor.** Anything else
  that writes to a library the session doesn't own belongs in this section
  first, with its own answer to "what relationship authorises this, and what
  of theirs does it refuse to touch".

Enforcer: `scripts/watching-with-test.mjs`.

## 12a. A recommendation is an invitation, never a write

"Recommend to group" (migration 065) is the retired suggest-a-show reborn at
the one scope that makes it acceptable — and the way it stays acceptable is
that it sits *outside* §12 entirely: it contains **no cross-member write**.
Watching With remains the only one.

- **The card belongs to the group, not to anyone's library.** Recommending
  writes a `group_suggestions` row and nothing else. No copy appears on any
  list until its owner taps for it.
- **Adding is pull.** "Add to Next Up" runs under the *recipient's* session
  and writes only to the recipient's own library, through the same
  copy-honouring path as Watching With: an existing copy is linked where it
  sits (never moved to Next Up), an archived one is revived, their memos are
  never overwritten. A fresh copy says who to thank (`recommended_by`) but
  records the adder's own tap as `added_by`.
- **Dismiss is per-member.** One member's dismissal is a mark about them; the
  card stands for everyone else, and a dismiss can be superseded by an add.
  Your own recommendation never asks you to respond.
- **The note is group-visible by design.** It is addressed to the group —
  the deliberate exception to the owner-only memo rule (`notes`,
  `recommended_by`, `watching_with` on library rows), and the exception is
  written down here so it never becomes a precedent by accident.
- **Attention fan-out is bounded like write fan-out.** A recommendation pops
  up at the whole group, so: only a copy you own can be recommended, a
  duplicate title folds into the existing card, `MAX_SUGGESTIONS_PER_DAY`
  caps each member per group, and removal is the recommender or the group's
  creator. Group-mates only in every direction — an outsider can neither
  read a board nor put a card on it.
- **Your cards leave when you do.** Leaving a group deletes your
  recommendations in it; account deletion sweeps both tables.

Enforcer: `scripts/group-suggestions-test.mjs`.

## 13. A group's membership is legible to admins; its content never is

Private groups are private to their members (§12's gate is the same one), with
exactly one exception, added 2026-08: `GET /api/admin-member-groups` lets an
**admin** see which groups any member is in and who else is in them. The
exception is bounded, and the bounds are the invariant.

- **The bar is an admin session, not a group-mate.** A logged-in non-admin gets
  403 — including for a group they are in, which they read through `/api/groups`
  like anyone else. There is no "nearly an admin" tier here.
- **Membership, never content.** Names, rosters, who created it, when. What the
  group is *watching* — Group Trending, the shared library, anyone's lists —
  stays behind `group_members` in `/api/groups/[id]`. An operator answering
  "who is this person in a group with?" needs the shape of the graph, not
  everybody's libraries.
- **Reading is not joining.** The endpoint writes nothing. An admin who can see
  a group still can't post to it, invite to it, rename it or leave it, and
  their own group-scoped features (vibe, Also watching, cross-library reads)
  don't widen by one row because they looked.
- **The justification is proportionality, and it has a floor.** Admins already
  read every member's login email and phone through `/api/admin-member-emails`;
  a group name and a roster of names is a smaller disclosure than that. If a
  future admin surface can't clear that bar, it doesn't get the exception.

Enforcer: `scripts/admin-member-detail-test.mjs`.

## 14. A list served to a client degrades to something usable, never to nothing

The network picker moved from a literal in the app to `GET /api/networks`
(2026-08) so a service added on the server reaches phones already installed.
That trade is worth making only if the failure modes of a network fetch can't
reach the member, so:

- **A bad payload never empties the picker.** Empty, all-junk, or unparseable
  falls back to the last cached list and then to the seed compiled into the
  build. A member opening Add Show mid-deploy to find no networks at all is
  strictly worse than a slightly stale list.
- **The cache answers a failed pull; it is never a reason to skip one.** The
  client tries the server on launch, on every foreground and every time the
  picker appears — not once per launch, which left a resident app on a
  week-old list. That's affordable because the catalog version doubles as an
  ETag and an unchanged list answers 304 with no body, so "ask often" and
  "cost nothing" aren't in tension.
- **The shipped seed is a fallback, not a second source of truth.** It may be
  shorter than the server's list — that is the entire point — but it must never
  name a service the server wouldn't canonicalize, or the app writes an
  unrecognized value into `shows.network`.
- **Sections come from the server, not from a client-side map of regions.**
  A client groups consecutive entries by the section string it is handed and
  renders that string as the header. Nothing in the app knows what "United
  Kingdom" means, so a region added later needs no App Store release either.
- **The endpoint's absence has to be noticed by a machine.** A 404 here breaks
  nothing loudly: every installed app just stays frozen on its cached list
  until a member asks where a service went. `smoke.sh` asserts it after every
  deploy for that reason.

This generalizes past networks: any list a client renders from an endpoint
needs a defined answer for "the server said nothing usable", and that answer
can't be an empty screen.

Enforcers: `ShowPickerCore` tests (`NetworkCatalogTests`),
`scripts/networks-test.mjs`, `scripts/smoke.sh`.

## 15. A query grows with a member's library only in chunks

D1 refuses any query binding more than 100 parameters — far below the size of
a keen member's library, and far above what `node:sqlite` enforces, so a test
suite passes cleanly on SQL that 500s in production. The failure mode is the
worst kind: everything works until one member's data crosses the line, and
then *their* screen — nobody else's — goes empty. That is how a library's
101st show broke its owner's list load (2026-08, `watchersForShows`).

- **An `IN (...)` built per owned row pages through the ids** in chunks under
  the limit, rather than binding them all at once.
- **A bind list scaled by anything member-sized** — shows owned, members
  enrolled — needs either a hard cap it can cite (Trending's `LIMIT 50`) or
  chunking. A list bounded by the schema (one title's cast, one group's
  roster, the four lists) is fine as it is.
- **The harness enforces D1's limit, not SQLite's.** The D1 shim in the test
  scripts throws over 100 bound parameters, so the next unchunked query fails
  on a laptop instead of on a member.

Enforcer: `scripts/watching-with-test.mjs` (the shim's parameter guard, and
the 121-show list-load case).

## 16. A credential at rest is encrypted; a cache holds no secrets

The session cookie is a live 30-day credential, and several targets need it —
the app, the Share Extension, the widgets, the watch app. Sharing it is not the
same as leaving it in the open.

- **The cookie lives in the Keychain, never in `UserDefaults`.** App Group
  `UserDefaults` is a plist inside the shared container: readable by anything
  with file access to the container, and unencrypted on disk. The App Group ID
  doubles as the keychain access group, so the same targets still share one
  item (`ShowPickerCore.SessionStore`).
- **Moving a credential migrates it, it doesn't drop it.** A build that finds a
  cookie in the old plaintext slot copies it into the Keychain and scrubs the
  slot on first read. Nobody gets signed out by a storage change.
- **A cache holds no secrets.** `Member` carries `calendar_token`, the
  per-member secret for the `.ics` feed. Decoding reads it so the live session
  can show Subscribe; encoding — which only ever happens when `OfflineCache`
  writes to disk — leaves it out.
- **Cache files are protected at rest.** `OfflineCache` writes with
  `.completeFileProtection`. It reads and writes in the foreground only, so the
  device is unlocked whenever the files are needed.

The general rule: when something moves from memory to disk, decide what it is.
A credential goes in the Keychain, a secret gets dropped, and everything else
gets file protection on the way down.

Enforcer: review, plus `SessionStore`'s own structure — the plaintext slot has
no writer left, only the migrating reader.

## 17. A stored `tmdb_id` is the row's identity

*Broke in 2026-08.* A member picked the new Little House on the Prairie from
type-ahead search and the 1974 original appeared on her Watching list. The add
had stored her pick correctly; the next `/api/enrich` rotation re-resolved the
row **by title**, and TMDB's popularity-ordered search returned the original —
same exact name — whose poster, year, overview, cast and "Ended" status then
overwrote hers. Two TMDB entries can share one exact title (a remake next to
the original it remade), so a title is a display string, never an identifier.

- **Enrichment never re-guesses a pinned row.** A row with a `tmdb_id` is
  fetched by that id; the title search serves only rows nothing ever pinned,
  or an id TMDB no longer serves (404). The pick made in type-ahead — or the
  id a previous search resolved — is the row's identity from then on.
- **Title-scoped propagation stops at an identity boundary.** Catalog fields,
  cast, artwork and URLs copied "to every copy of the title" skip copies
  pinned to a *different* `tmdb_id` — those are a different show. This covers
  the enrich passes, the cast refresh, the artwork syncs (write-time and
  display-time), add-time network/URL inheritance, and the Watchmode URL
  propagation.
- **Grouped enrichment queues group by `(title, tmdb_id)`**, not title alone,
  so a pinned remake and its same-titled original each get their own fetch
  rather than whichever row the GROUP BY kept answering for both.
- **When a bare title has to be resolved, the newest version wins.** For rows
  nothing ever pinned, `pickBestMatch` prefers exact title matches as before,
  but among several same-named entries it takes the newest dated one — the
  club wants the current version of a remade show, not the one TMDB's
  popularity ranking favors (stated by Patrick, 2026-08). A trailing
  `"(YYYY)"` in the stored title pins that year's entry instead (and is
  stripped from the search query itself, which often returns nothing for the
  suffixed form). Dateless entries never beat dated ones — those are usually
  catalog junk, not upcoming remakes. Every resolution path shares this
  matcher: `fetchEnrichment`, `searchTmdbTitle`/`searchTmdbId` (list import,
  TMDB backfill) and `enrich.js`'s lighter search.

Enforcer: `scripts/enrich-identity-test.mjs` (every PR) — drives the add and
`/api/enrich` against a fake TMDB serving two same-titled entries, popular
original first, and asserts each pin keeps its own data.

## 18. A public endpoint costs O(1) reads per request

Trending taught this the expensive way. `/api/popular` is public, sits on
every platform's launch screen, and its ranking query title-matches copies
across the whole `shows` table — so every anonymous hit paid a cost
proportional to the whole library. On 2026-09-01 bot traffic against it
burned the free tier's entire daily D1 `rows_read` budget and took the API
down for everyone. The rules that came out of it:

- **Trending is a daily snapshot.** The first request of a UTC day computes
  the full 50-row ranking into `trending_cache`; every other request that
  day — every bot hit included — reads one row and slices it to `?limit=`.
  New adds trend the next UTC day on purpose.
- **Nothing session-scoped is cached.** The snapshot stores member *slugs*,
  never names; the names a viewer may see (group-mates only, per §1)
  are resolved fresh from their session on every request. A cache shared
  across viewers holds only what the least-privileged viewer may read, plus
  keys to resolve more.
- **A stale, corrupt or missing cache degrades to a recompute, never an
  error** — §14's rule again: "the cache said nothing usable" needs a
  defined answer, and that answer can't be an outage.

This generalizes: an endpoint in the logged-out tier answers request volumes
the club doesn't control, so its per-request read cost must not scale with
the size of the library. A public endpoint whose cost grows with the data is
a resource-exhaustion outage waiting for one crawler.

- **`/api/members` is the other public read, and it tiers instead of caching.**
  A logged-out caller gets names from one read of `members` — no join to
  `shows` or `sessions` — because nothing it needs lives there. The per-list
  counts wait for a session, and `last_activity_at` (when somebody last used
  the app) for an admin one; the order is alphabetical below admin, since an
  activity order would publish the same fact without the field.

Enforced by `scripts/trending-cache-test.mjs` and
`scripts/members-order-test.mjs`.

## 19. A background pass selects on everything it writes

A pass that fills data picks its rows with one predicate and writes with
another statement. When the write is wider than the predicate, the difference
is a set of rows that qualify for nothing and are never repaired — and because
they carry a fresh `enriched_at`, they look finished from the outside.

The movie pass in `functions/api/enrich.js` wrote eighteen fields — genres,
overview, runtime, tagline, studio, director, trailer, content rating — while
selecting on `poster_url IS NULL OR network IS NULL`. A film inserts *with* a
poster and a network (synchronous insert enrichment sets both, and nothing on
that path writes genres), so it never qualified again and never received the
other sixteen. By 2026-09 that was **125 of 137 unarchived films with no
genre, overview or runtime** — 91% of the movie library. The member-visible
symptom was the genre filter on Next Up hiding every movie, because a movie
matched no genre at all.

- **The gate must cover the write.** `MOVIE_GAP` now names artwork, network,
  genres and cast together — genres standing in for the whole detail block,
  since overview, runtime, tagline and studio arrive in the same response.
- **Two repair paths that share a blind spot are one repair path.** These rows
  were invisible to *both*: the normal pass skipped them for having artwork,
  and `mode: 'gaps'` skipped them for having cast. A repair mode has to select
  on the absence of the data it repairs, not on a proxy that happened to
  correlate once.
- **A "remaining" count is part of the gate.** `mode: 'gaps'` reports
  `remaining` so an operator can drive it to zero; while that count used a
  narrower predicate than the pass, a dry run answered "nothing to do" over a
  backlog of 125. A counter that disagrees with the selection is worse than no
  counter — it certifies the gap it can't see.
- **A widened gate needs a budget check.** The movie loop had none, which was
  safe only while its selection was nearly always empty. Giving a loop real
  work without bounding it spends straight past `SUBREQUEST_BUDGET` into
  Cloudflare's own per-request ceiling.

The same audit found the mirror-image defect: `network_logo_url` was never in
the movie write at all. TV reads its logo from `detail.networks[0].logo_path`,
a field TMDB does not return for films, so 128 of 137 movies had a network and
no badge. The logo now comes off the flatrate provider that already names the
network, out of a response the pass was fetching anyway.

**But a data-absence gate needs data that is always obtainable.** That repair
is `mode: 'logos'`, a deliberate sweep, and deliberately *not* part of
`MOVIE_GAP`: a rent/buy-only film has no flatrate provider and therefore no
badge to fetch, so a standing `network_logo_url IS NULL` gate would re-select
those rows on every member page load forever — spending the whole budget on
rows nothing can fill. Its count bottoms out above zero for the same reason,
so the driver stops when the number stops falling rather than when it reaches
zero. New films need no sweep: they insert without genres, so `MOVIE_GAP`
already selects them and the pass writes the badge on the way past.

**A derived label and its artwork must come from the same source.** The first
cut of the badge took the highest-priority flatrate provider TMDB returned,
independent of the network the row displays. A film's `network` is often the
member's own answer, or an older one, and TMDB ranks by `display_priority` —
so a card reading "HBO Max" was given Amazon's logo, HBO Max being present in
the list but not first. About 22% of badged films were affected. The badge is
now looked up by the row's own network (canonicalized for the lookup, matched
on the stored string for the write, since a legacy row can hold "Max" where
the table says "HBO Max"), and a network TMDB doesn't list gets **no badge**
rather than a plausible wrong one. A logo that contradicts its own label is
worse than a blank.

The general rule: when you widen what a pass writes, widen what it selects in
the same change, or you have created rows that are permanently done and
permanently empty. And when you gate on the absence of data, check whether that
data is always obtainable — if it isn't, the gate is a treadmill, and the
repair belongs in a sweep you invoke rather than a rotation that never ends.

Enforced by `scripts/enrich-movie-detail-test.mjs`.

## 20. A shared-object change notice is exactly-once, and never to the editor

Migration 068 opened `PATCH /api/groups/[id]` to any group member, not just
its creator — Patrick hit the old creator-only bar as a member of a group he
didn't start. Loosening a write from "one person" to "anyone in the
relationship" (the same shape §12's Watching With already takes) needs the
other members told, or an edit becomes indistinguishable from someone
quietly overwriting what was there. The telling has its own bounds:

- **Diff against the stored row, not the request.** A PATCH that resends the
  current name stamps nothing — `existing.name`/`icon`/`color` are compared
  before anything is written, so a no-op edit can't manufacture a notice.
- **Never to the person who made it.** The editor's own
  `group_members.last_seen_change_at` is stamped in the same write that
  records the change, so their own next `GET` has nothing to tell them about
  themselves.
- **Never to someone who joined afterward.** `GET` also checks the viewer's
  `joined_at` against the change's timestamp — a member who has never known
  the group any other way isn't told it used to be different.
- **Exactly once.** Seeing the notice is what advances a member's own
  high-water mark, whether or not it happened to be theirs to receive — a
  second `GET` after the first never repeats it.
- **Millisecond precision on purpose.** The stamp uses
  `strftime('%Y-%m-%d %H:%M:%f','now')`, not `datetime('now')`'s whole
  seconds — two edits landing in the same second (a rename right after an
  icon change) still have to stay distinguishable, or the second correctly
  overwrites the first's notice before anyone ever saw it.
- **Latest change only, not a log.** There is one `profile_changed_*` triple
  per group, not an append-only history — a second edit before anyone visits
  replaces the first's notice rather than queuing both. Acceptable for a
  cosmetic banner; would not be for anything load-bearing.

Enforcer: `scripts/group-icons-test.mjs`.

## 20. A machine never overwrites a member's answer; it answers beside it

`shows.network` is written `network = COALESCE(network, ?)` in both enrichment
passes. Fill-only, on purpose: the member picks a network when they add a
title, and enrichment supplies one only when they didn't. It is the same rule
`updated_at` encodes — member intent outranks a background job.

**A link a machine fetched is still the machine talking.** `PUT /api/shows/:id`
derived the network from the row's existing `network_url` and let that beat the
dropdown — a rule written when members pasted their own links, where the URL
really was the member's answer. Since Watchmode nobody pastes them, so what it
did was let a machine outrank a person: a row holding a `tv.apple.com` deep
link could not be moved off Apple TV+ at all, because every save read the old
link and put the network back, silently and with no error. A URL supplied *in
that same request* still decides, because that one is the member talking. The
row's own URL is now only a last resort, for an edit that names no service at
all. Moving a row also drops the link that belonged to its old service —
pointing the Watch button confidently into the wrong app is worse than
dropping to a search page until the lookup refills it — and the replacement
reaches only copies naming the new service, the same scoping §24 puts on
`sync-urls`. Enforcer: `scripts/show-edit-network-test.mjs`.

The cost is staleness. Once set, `network` is never revisited, and licensing
moves: **61 of 137 unarchived films (45%) carry a network TMDB no longer lists
as a US flatrate provider.** Conclave reads Apple TV+ where TMDB now says
Starz; Avatar reads Netflix where TMDB says Paramount+. The wrong movie badges
of 2026-09 were this staleness becoming visible — the badge didn't cause it,
it exposed it.

The fix is *not* to start overwriting. **We store no provenance**, so nothing
distinguishes "the member chose Hulu" from "TMDB said Hulu in March", and a
refresh would silently discard deliberate answers to correct machine-set ones.
Instead `streaming_on` (migration 069) carries TMDB's current answer beside
`network`, and the UI surfaces the difference.

- **`network` stays fill-only. `streaming_on` is refreshed authoritatively** —
  including across sibling copies, where a fill-only propagation would pin the
  first answer any copy ever received. It holds no member intent, and being
  current is its whole purpose.
- **Canonical names, matching `network`'s own vocabulary** (`_shared/networks.js`).
  TMDB says "Max"; the table says "HBO Max"; a member comparing the two should
  not have to know they are the same service. A provider that maps to nothing
  we can name — "Starz Amazon Channel" — is omitted rather than shown.
- **Empty string and NULL mean different things.** Empty means TMDB was asked
  and named nothing (a film that only rents); NULL means it was never asked. A
  UI that conflates them tells a member a title streams nowhere when the truth
  is that nobody has looked.

The general rule: when a machine's answer and a member's disagree, store both
and show the difference. Overwriting is only safe on a field that never held
an answer of theirs.

Enforced by `scripts/enrich-movie-detail-test.mjs`.

## 21. A filter narrows a scoped query; it never widens it

Several endpoints answer "what may this session see" with a `WHERE` clause —
group membership, ownership, `archived = 0`. When a convenience filter is
bolted onto one of those, the privacy rule and the search rule end up in the
same `WHERE`, and the failure mode is a filter that reaches *past* the
boundary it was meant to search within. Nothing about the feature looks wrong:
results appear, they match the query, and they belong to someone the viewer
was never supposed to see.

`?q=` on `/api/shows/all` is the live case. It exists so Roku, which runs on
hardware going back about eight years, receives matches instead of the whole
club library.

- **The scope clause is not optional and not conditional.** The group-scoping
  `AND` is part of the query whether or not a filter is present, and a filter
  is only ever `AND`-ed alongside it. A filter that can be expressed as an
  `OR` at the top level is a bug.
- **The filtered and unfiltered paths obey the same boundary.** Whatever a
  search can return is a subset of what the unfiltered endpoint would have
  returned for that session — never a row that was not already visible.
- **A query string is text, not a pattern.** `LIKE` reads `%` and `_` as
  wildcards, so user input is escaped before it becomes one. A bare `%` must
  return nothing rather than the entire library, which is precisely the
  request a filter like this exists to prevent.
- **A filtered response is bounded.** An unbounded filter is the problem it
  was added to solve, wearing a parameter.
- **Blank means "no filter", not "match nothing".** An empty search box should
  not look like an empty library.

Enforcer: `scripts/shows-all-search-test.mjs` — in particular the case that
types a stranger's title exactly and gets nothing back.

## 22. A row you may not write is a row you may not read

A handler that scopes its write by owner and then re-reads the row by primary
key alone has two different answers to "whose row is this" three lines apart.
The write is refused, which looks like the control worked — and then the
response hands back the row anyway. `/api/shows/:id/move` did exactly that,
and because `added_by` carries a login email address, the leak was PII and not
only a memo.

- **The read-back carries the write's predicate.** Not a weaker one, and not
  none. If the `UPDATE` says `AND member_slug = ?`, so does the `SELECT` that
  follows it.
- **A write that matched nothing does not fall through into a read.** Check the
  change count and answer 404. Letting control continue is how the disagreement
  stays invisible.
- **A refused row and a row that does not exist answer alike.** Otherwise the
  404 is an existence oracle and the id space is walkable, which is the
  difference between guessing an id and enumerating them.
- **But a no-op write is still a write.** SQLite counts a matched row as
  changed even when no column value differs, and `updated_at` moves on every
  call — so moving a row onto the list it already sits on must not read as
  "matched nothing".

This is the read half of the rule §3 states for personal fields: the four
owner-only columns are redacted on every *listing* path, and the reason the
audit found this one is that a single-row response never went through them.

Enforcer: `scripts/shows-authz-test.mjs`.

## 23. A stored string is markup by the time somebody reads it

`canonicalNetwork()` echoes a name it doesn't recognize rather than rejecting
it, which is the right call for a catalog that gains services faster than the
table does — and it means an arbitrary member-supplied string reaches the
`network` column intact. That column is then rendered into the member page's
service-count footer and into the admin URL-cleanup console.

- **Escape at the sink, but close the source.** A sink-only fix leaves every
  future read path — a new page, an export, an email body — trusted to
  remember. The write is the one place that is not repeated.
- **Every writer of a column, not the one you found.** `network` has two:
  the add handler and the edit handler. Guarding only the insert leaves the
  field open.
- **A fix at the sink does not clean stored rows.** Anything already persisted
  needs a backfill or it stays dangerous to any reader that forgets.

Enforcer: `scripts/shows-authz-test.mjs`.

## 24. Provenance decides what may be copied onto another member's row

`network_url` has two writers with very different trust: provider enrichment
(Watchmode, TMDB), and a member's own request body. `safeNetworkUrl` checks
the scheme and the character class, not the host, so the member-supplied value
is safe to *render* and says nothing about whether it is safe to *propagate*.
`/api/sync-urls` copied whichever it found onto every member's copy of the
title, which turned one self-enrolled member into the author of everybody's
Watch button under a real service's name.

- **A club-wide write needs a provider-grade source.** Today that is the host
  check: a URL only propagates when `networkFromUrl()` maps it to the row's own
  service. A `network_url_source` column would say it directly and is the
  better long-term answer.
- **A denylist is not the control.** Excluding the demo account was correct and
  insufficient — open signup means the next untrusted row is one registration
  away.
- **A narrowing check reports what it narrowed.** `skipped` is in the response
  so a provider host missing from the domain index surfaces as a number to go
  fix, rather than as the feature quietly doing less.
- **And it still stops at a different show.** §17 applies here like everywhere
  else: a copy pinned to another `tmdb_id` is a different title sharing a name.

Enforcer: `scripts/shows-authz-test.mjs`.

## 25. A time window compares like with like

SQLite has no date type. Every timestamp in this schema is TEXT, and there are
two formats in play: `datetime('now')` from a column default writes
`YYYY-MM-DD HH:MM:SS`, and JavaScript's `toISOString()` writes
`YYYY-MM-DDTHH:MM:SS.sssZ`. Comparison is byte-wise, and `' '` (0x20) sorts
below `'T'` (0x54) — so a same-day row compared against an ISO bound is always
"older", and `created_at > since` is unsatisfiable. It fails silently: the
query runs, returns zero, and the cap it feeds reads as "nobody is near the
limit". Every hourly quota on `/auth/request-code` was inert this way, for
roughly 23 hours out of every 24, from the day it was written.

- **Know which format the column holds.** It is decided by the writer, not the
  schema: `login_otps`, `enroll_otps` and `members` take the SQLite default,
  while `failed_logins.created_at` is `NOT NULL` and written by JS as ISO. The
  login throttle works precisely because both of its sides are ISO.
- **Normalize both sides at the comparison.** `datetime(created_at) >
  datetime(?)` is correct for a column holding either format, needs no
  migration, and leaves no rows behind. Changing a column default instead
  fixes new rows and silently keeps the bug for every old one.
- **A cap that has never fired is not evidence that it works.** Nothing in the
  product tells you a `COUNT(*)` came back zero because the limit was
  respected rather than because the predicate was unsatisfiable. That is why
  the enforcer asserts the refusal, not the query.
- **A quota is only as wide as the paths it counts.** The signup branch wrote
  a different table and returned before the shared check, so one source could
  spend the same hourly allowance twice. A budget has to cover every path that
  spends it.

Enforcer: `scripts/auth-code-flow-test.mjs`.

## 26. An invitation is bounded, revocable, and not redeemable cross-site

Group membership is what scopes vibe reads, `GET /api/shows/all`, Also
watching, Group Trending, the recommendation board, and who Watching With may
name. A `group_members` row is therefore the most valuable write in the
product, and an invite token is the only credential that produces one.

- **Redeeming is a write, so it obeys write rules.** It is reached by a
  cookie-authenticated `GET`, which means a cross-site top-level navigation
  carries the victim's session into it; `SameSite=Lax` permits exactly that
  navigation and is not a defence. The write is refused when `Sec-Fetch-Site`
  says cross-site, falling back to an `Origin` check. Native clients send
  neither header and are unaffected — a header an attacker's browser cannot
  suppress is what does the work, and a client that omits it is not a browser.
  Refusing with a *preview* rather than an error keeps the refusal from
  confirming anything.
- **A credential that is never consumed is not a credential.** Redemptions are
  counted against a ceiling, and the claim is an atomic
  `UPDATE ... WHERE use_count < max_uses` — a guard evaluated in JavaScript
  lets two racing redemptions both read the same count and both proceed.
- **Every credential has a way to be destroyed.** Deleting the group was not
  an acceptable answer for a leaked link.
- **An invite is somebody vouching, so it dies with their membership.**
  Leaving deletes your outstanding invites, and redemption re-checks the
  issuer's membership for rows removed some other way.
- **Dead is dead in one uniform way.** Revoked, exhausted, expired and
  issuer-departed answer identically, and the unauthenticated link-preview
  card goes generic for all of them. A dead link must not name the group it
  used to open, or confirm it was ever real — which is the same rule §20-era
  link previews already follow.
- **A bound the member can't see is a trap.** The ceiling is stated to
  whoever is about to share the link, so "good for up to 10 people" is a
  promise rather than something they discover when the eleventh person is
  refused. That means the number travels in the mint response
  (`_shared/group-invites.js` is the one place it is written down) instead of
  being copied into each client, where the stated bound and the enforced one
  would drift apart.

Enforcer: `scripts/group-invite-lifecycle-test.mjs`, plus the preview cases in
`scripts/og-preview-test.mjs`.

## 27. A connected AI app gets the member's permissions, no more

Members can connect an AI app (Claude, ChatGPT, Claude Code) to `/mcp`, and it
reads and changes their lists on their behalf. The app is steered by text the
member doesn't control (a group-mate's show title or recommendation note ends
up in the model's context), so everything it can do has to be something the
member could do anyway, and nothing it does may widen what anyone can see.

- **One set of rules, not two.** Every tool calls an existing `/api` handler
  in process, with the member's session riding on the `Request` object
  (`actingAs()` in `_shared/auth.js`, a module-private `WeakMap` — there is no
  header or cookie a network caller could forge to get there). Owner-only
  memos, group scoping and the Watching With rule are enforced by the code the
  apps already call, so a fix to one is a fix to both. Where a handler answers
  "success" for a row it didn't touch (archive, delete), the tool checks
  ownership first rather than tell the model something false.
- **Narrower than the app where the app leans on a person looking.** A
  connection gets no roster, so `list_member_shows` reaches group-mates only.
  Account-shaped actions stay in the app: no redeeming invites, no household,
  no group rename/delete, no account deletion, passkeys, import or export.
  Creating a group, minting an invite and leaving are allowed.
- **Never admin.** `getAdminSession()` refuses a delegated request, so even an
  admin's own token can't reach an operator tool.
- **Only a token opens `/mcp`.** A session cookie is ignored there: the
  endpoint takes writes, and a cookie rides along from any page the member
  visits. Tokens are opaque and only their SHA-256 is stored.
- **Consent is the member's and only theirs.** An unknown client or an
  unregistered redirect gets an error page and no redirect, so the endpoint is
  never an open redirector. The consent POST must be same-origin and carries a
  value derived from the session that rendered it. The screen names the
  redirect host beside the client's self-chosen name, because registration is
  open and anybody can register an app called "Claude".
- **A replay costs the connection.** PKCE S256 is mandatory; a code redeemed
  twice, or a rotated refresh token presented again, revokes the grant.
- **Scopes decide what exists.** A read-only grant isn't shown the write tools
  and can't call one by name.
- **Stopping is immediate.** Revoking from Connected apps, the app's own
  RFC 7009 revoke, a ban and account deletion all end the grant on the next
  call; a ban revokes rather than merely suspending, so re-enabling a member
  doesn't quietly bring their connections back. Connected apps accepts only a
  cookie session — an AI can't be talked into listing or cutting connections.
- **Caps that have been seen to refuse.** Per-member daily ceilings on calls,
  writes and TMDB searches (`DAILY_CAPS` in `_shared/mcp-tools.js`), counted in
  SQL on the SQLite clock (§25), with tests that assert the refusal.

Enforcer: `scripts/mcp-test.mjs`, plus the AASA exclusions for `/oauth/*`,
`/mcp`, `/connect` and `/connected-apps` in `check-static.sh`.

## 28. Spend is metered where it happens, and nobody joins a household uninvited

Signup is open and self-service, so a session is an identity, not a budget.
Anything that spends on an operator-held key is bounded per member per day,
counted where the money goes rather than inferred from rows that happen to be
written.

- **Count the call, not the row.** `member_spend` (migration 072,
  `_shared/spend-meter.js`) charges before the upstream call: `claude` for
  `/api/import/parse` slices, `lookups` for the TMDB/Watchmode fan-out behind
  add, edit and suggest, `searches` for type-ahead. The 50-add and 300-import
  row caps stay as the product rules they are; they never saw the paths that
  spend without inserting.
- **A refusal costs nothing upstream.** A duplicate add is refused *before*
  enrichment, and every metered path checks the ledger before its first
  fetch. A refused request still counts, so a loop stays refused.
- **Degrade the way clients already handle.** Parse, add and suggest answer
  429 `rate_limited`; type-ahead answers the empty `{results: []}` clients
  already treat as "no suggestions"; an edit past the ceiling still saves what
  the member typed and skips only the re-enrichment.
- **The meter fails open.** A ledger error must never stop a member adding a
  show; the ceilings are there for a script, not for a person.
- **A club-wide sweep is not a member action.** `/api/sync-urls` costs one
  write per distinct title in the whole club. It runs nightly from
  `watch-urls-fill.yml` and for admins; a member session gets the old answer
  with nothing done.
- **A household is joined, not claimed.** `PUT /api/household` may only narrow
  the caller's own set — anyone new comes in through an invite they redeem
  under their own session. `GET` reports `member_of` so a claim on you is
  visible, and `POST /api/household/remove` works from either end.

Enforcer: `scripts/spend-limits-test.mjs`.

## Adding an invariant

Add a section here, then decide which enforcer covers it. Prefer a deterministic
check — an assertion in `check-static.sh` or `smoke.sh`, or a test in
`ShowPickerCore` — and leave it to the review workflow only when the rule needs
judgement. A rule with no enforcer is a comment, and comments don't fail builds.
