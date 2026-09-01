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
| Reporting platform tests (`scripts/reporting-platform-test.mjs`) | every PR | `/api/reporting` stays admin-only, and the platform breakdown counts people rather than sessions |
| List import tests (`scripts/import-list-test.mjs`) | every PR | The paste-a-list path: what a model may and may not put in the database, paging, and the commit-side validation |
| Network tests (`scripts/networks-test.mjs`) | every PR | The canonical table: a name claimed by two services, and the catalog `/api/networks` serves to the apps |
| Enrichment identity tests (`scripts/enrich-identity-test.mjs`) | every PR | A stored `tmdb_id` is the row's identity: enrichment never re-guesses a pinned row by title, and propagation never crosses two entries sharing one title |
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

## 11. Reporting counts people, not rows

Every activity number on `/api/reporting` answers "how many people", not "how
many database rows happened to exist". Sessions are the wrong unit and always
flatter: a reinstall, a re-login, an iPhone plus a browser tab and an Apple TV
all mint their own `sessions` row, so a two-member club read "13 iPhone / 22 /
31" on the platform breakdown — thirteen phones' worth of activity from one
person and a spare device.

- Active-by-platform counts distinct `member_slug` per platform. A member on
  two platforms counts once on each row, so the rows deliberately don't sum to
  Active members — say so in the UI rather than letting a reader add them up.
- A session with no member (an anonymous tvOS device) has nothing to dedupe by
  and counts as one, rather than collapsing every anonymous device in the club
  into a single phantom person or dropping out of the breakdown entirely.
- Counts of *events* — ratings submitted, shows added, sessions minted per
  sign-in method — stay counts of events. The rule is that the label says which
  it is: "people who rated" and "ratings submitted" are two rows for a reason.

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

Enforced by `scripts/trending-cache-test.mjs`.

## Adding an invariant

Add a section here, then decide which enforcer covers it. Prefer a deterministic
check — an assertion in `check-static.sh` or `smoke.sh`, or a test in
`ShowPickerCore` — and leave it to the review workflow only when the rule needs
judgement. A rule with no enforcer is a comment, and comments don't fail builds.
