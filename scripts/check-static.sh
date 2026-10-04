#!/usr/bin/env bash
#
# Show Picker Club — repo-level invariant checks. No network, no deploy.
#
#   scripts/check-static.sh
#
# This is the PR gate: it runs against the working tree, so it can block a
# change *before* it ships, which the post-deploy smoke test by definition
# cannot. Everything here is deterministic — the judgement calls live in
# docs/INVARIANTS.md and the review workflow that reads it.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
err() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error::$1"; else echo "FAIL: $1"; fi
  fail=1
}
ok()   { echo "  ok  $1"; }
note() { echo; echo "== $1"; }

# Endpoints under functions/api/ that are deliberately reachable with no
# session and are not 410 stubs. Adding a file here is a conscious decision to
# publish it — that is the entire point of the list.
#
#   shows/[id]/actors.js — cast list for a title. Catalog data, and it reveals
#     nothing about whose row the id belongs to.
#   networks.js — the network picker the apps fetch instead of hardcoding. A
#     constant table compiled into the Worker: no member data of any kind, and
#     the same brand names already ship in public/index.html's <select> to
#     logged-out visitors. Public so an app that hasn't signed in yet can still
#     warm its picker, and so the edge can cache a response that doesn't vary.
PUBLIC_ENDPOINTS="shows/[id]/actors.js networks.js"

note "Deployed output carries the web app and the marketing page"

# The member app came back in 2026-08 after four weeks archived. Its pages are
# useless without the shared scripts they load, and the failure mode is a page
# that renders half-empty rather than one that errors, so check the whole set.
for f in index.html download.html privacy.html terms.html sms.html styles.css \
         favicon.svg og-default.png sw.js _headers _redirects \
         .well-known/apple-app-site-association \
         welcome.html groups.html vibe.html rate-backlog.html favorite-actors.html calendar.html \
         subscriptions.html members.html reporting.html url-cleanup.html \
         vibe-admin.html shell.js nav.js show-renderer.js app-banner.js; do
  [ -e "public/$f" ] || err "public/$f is missing"
done
ok "web-app pages and marketing page present"

# index.html IS the app, and app.html must not exist. Both halves matter: the
# catch-all can only point at /index.html (see public/_redirects), so an app
# living anywhere else is an app member slugs never reach — and an app.html
# sitting alongside is the first step back toward the rewrite that 308-looped
# the entire site on 2026-08-13.
grep -q 'id="loginOverlay"' public/index.html \
  && ok "index.html is the member app" \
  || err "public/index.html is not the app — the catch-all can only fall through to /index.html"
[ -e public/app.html ] \
  && err "public/app.html exists — the app must be index.html, not a rewrite target (see public/_redirects)" \
  || ok "no app.html to rewrite to"

note "Marketing page"

# The smoke test greps for this marker to prove /download still serves the
# marketing page. If the page loses it, that probe silently stops proving
# anything.
grep -q 'id="shelf"' public/download.html \
  && ok "download.html keeps the id=\"shelf\" smoke marker" \
  || err "download.html lost id=\"shelf\" — scripts/smoke.sh depends on it"

# The CTA link and the Smart App Banner must name the same listing; they drifted
# apart once already when the listing was re-created. Both pages carry a link
# now — the marketing page's CTA and the app's logged-out join card.
meta_id=$(grep -o 'apple-itunes-app" content="app-id=[0-9]\+' public/download.html | grep -o '[0-9]\+$')
section_ok=1
for f in download.html index.html; do
  cta_id=$(grep -o 'apps\.apple\.com/app/id[0-9]\+' "public/$f" | head -1 | grep -o '[0-9]\+')
  if [ -z "$cta_id" ] || [ "$cta_id" != "$meta_id" ]; then
    err "App Store id mismatch in public/$f: link=${cta_id:-none} meta=${meta_id:-none} (docs/APP_STORE_SUBMISSION.md §7)"
    section_ok=0
  fi
done
[ "$section_ok" -eq 1 ] && ok "App Store id consistent across both pages ($meta_id)"

# Every unmatched URL previews from index.html, so its og:image is the fallback
# card for every share that has no tags of its own.
grep -q 'og:image" content="https://showpicker.club/og-default.png"' public/index.html \
  && ok "index.html carries the fallback og:image" \
  || err "public/index.html has no og:image — shared links lose their artwork"

note "Redirects"

# Member approval is gone for good (migration 058) — these four have no page
# behind them and must keep redirecting.
for path in /join /setup /requests /admin; do
  grep -qE "^${path}[[:space:]]" public/_redirects \
    || err "public/_redirects has no rule for $path"
done
ok "every retired path has a redirect rule"

# The web-app surfaces are served by real files again, so a leftover 301 would
# bounce a member off the page they asked for.
for path in /welcome /groups /rate-backlog /favorite-actors /subscriptions /vibe /members \
            /reporting /url-cleanup; do
  grep -qE "^${path}[[:space:]]" public/_redirects \
    && err "public/_redirects still redirects $path — that page is served again"
done
ok "restored pages are not redirected away"

# The catch-all must stay a 200 rewrite to /index.html. Every other shape was
# tried against `wrangler pages dev` on 2026-08-13: /app.html 308-loops the
# whole site, and /app swallows real files including the AASA. As a 301 it
# discards the URL, and a shared /patrick link stops carrying who it was about.
grep -qE '^/\*[[:space:]]+/index\.html[[:space:]]+200' public/_redirects \
  && ok "catch-all is a 200 rewrite to /index.html" \
  || err "public/_redirects catch-all must be '/*  /index.html  200' — no other destination works (see the file's own comment)"

note "Headers"

# A comment indented inside a rule block is parsed as a header by Cloudflare
# Pages, which silently corrupts the block it's in.
if grep -nE '^[[:space:]]+#' public/_headers; then
  err "public/_headers has an indented comment — Pages parses it as a header. Keep comments at column 0."
else
  ok "no indented comments in _headers"
fi

csp_line=$(grep -i 'Content-Security-Policy:' public/_headers || true)
[ -n "$csp_line" ] && ok "CSP present" || err "public/_headers has no Content-Security-Policy"

# Web sign-in is back, and each of these fails silently when its source is
# missing: the button renders and simply never completes.
for src in appleid.cdn-apple.com appleid.apple.com accounts.google.com challenges.cloudflare.com; do
  echo "$csp_line" | grep -qF "$src" \
    || err "CSP no longer allows $src — web sign-in needs it (docs/ARCHITECTURE.md#frontend-pages)"
done
ok "CSP carries the web sign-in sources"
echo "$csp_line" | grep -q "frame-ancestors 'none'" \
  && ok "CSP denies framing" \
  || err "CSP is missing frame-ancestors 'none'"

note "Universal links"

aasa=public/.well-known/apple-app-site-association
python3 - "$aasa" <<'PY' || fail=1
import json, sys
path = sys.argv[1]
try:
    d = json.load(open(path))
except Exception as e:
    print(f"::error::{path} is not valid JSON: {e}")
    sys.exit(1)
try:
    details = d["applinks"]["details"][0]
    comps = details["components"]
except Exception:
    print(f"::error::{path} has no applinks.details[0].components")
    sys.exit(1)

if "NQ6AJVVBBJ.net.patrickturner.showpickerios" not in details.get("appIDs", []):
    print(f"::error::{path} is missing the app ID — universal links would be dead")
    sys.exit(1)

# Member pages must stay claimed: this is what opens the app from a shared
# /patrick link and from the new-signup email.
if not [c for c in comps if c.get("/") == "/*" and not c.get("exclude")]:
    print(f"::error::{path} no longer claims /* — member-page links would stop opening the app")
    sys.exit(1)

# Passkeys are scoped to the domain, not the app: without this block iOS
# refuses to hand the app a credential for showpicker.club, and passkey
# sign-in fails with nothing in the logs to say why.
if "NQ6AJVVBBJ.net.patrickturner.showpickerios" not in d.get("webcredentials", {}).get("apps", []):
    print(f"::error::{path} is missing the webcredentials block — passkey sign-in would break")
    sys.exit(1)

# Anything the app can't render must stay excluded, or iOS swallows the URL and
# shows the user nothing.
# /oauth/* and /mcp matter more than most: the consent screen is reached by a
# redirect from another app, and if iOS hands that URL to Show Picker instead
# of the browser, connecting an AI app dead-ends in a screen that can't render
# it. /connect and /connected-apps are web pages the app has no view for.
required = ["/api/*", "/auth/*", "/calendar/*", "/.well-known/*", "/oauth/*", "/mcp",
            "/connect", "/connected-apps"]
excluded = {c.get("/") for c in comps if c.get("exclude")}
missing = [p for p in required if p not in excluded]
if missing:
    print(f"::error::{path} must exclude {', '.join(missing)}")
    sys.exit(1)
# The app keeps the same list (WebOnlyLinks.swift) to hand these URLs back to
# the browser when a device's cached copy of this file still sends them to the
# app. A path excluded here but not there is dropped by the app for as long as
# any device holds the old file — how "Connect Claude" dead-ended in 2026-09.
import re
swift = open("ShowPickerCore/Sources/ShowPickerCore/WebOnlyLinks.swift").read()
body = swift.split("patterns: [String] = [", 1)[1].split("]", 1)[0]
app_list = set(re.findall(r'"([^"]+)"', body))
if app_list != excluded:
    only_web = sorted(excluded - app_list)
    only_app = sorted(app_list - excluded)
    print(f"::error::WebOnlyLinks.swift and {path} disagree — "
          f"missing from Swift: {only_web or 'none'}; missing from AASA: {only_app or 'none'}")
    sys.exit(1)
print("  ok  AASA claims /*, excludes API/auth/calendar, carries the app ID")
print("  ok  the app's WebOnlyLinks matches the AASA exclusions")
print("  ok  AASA carries the webcredentials block passkeys need")
PY

# The other half of the same association. Both entitlement files, because the
# Catalyst build has its own and they have drifted before.
for ent in ios/ShowPickerIOS/ShowPickerIOS.entitlements \
           ios/ShowPickerIOS/ShowPickerIOS-Catalyst.entitlements; do
  grep -q 'webcredentials:showpicker.club' "$ent" \
    || err "$ent is missing webcredentials:showpicker.club — passkey sign-in needs it (docs/ARCHITECTURE.md#passkeys)"
done
ok "both entitlement files carry the webcredentials association"

# _headers must serve it as JSON or iOS ignores the file entirely.
grep -A2 '^/\.well-known/apple-app-site-association' public/_headers | grep -qi 'application/json' \
  && ok "AASA has its application/json rule" \
  || err "public/_headers must serve the AASA file as application/json"

note "security.txt (RFC 9116)"

# Contact and Expires are the two required fields; a file past its Expires is
# treated as absent by scanners, so fail a month early rather than on the day.
sectxt=public/.well-known/security.txt
if [ ! -f "$sectxt" ]; then
  err "$sectxt is missing"
else
  grep -q '^Contact: ' "$sectxt" || err "$sectxt has no Contact field"
  expires=$(sed -n 's/^Expires: //p' "$sectxt")
  if [ -z "$expires" ]; then
    err "$sectxt has no Expires field"
  elif ! python3 -c 'import sys,datetime as d; e=d.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")); sys.exit(0 if e - d.datetime.now(d.timezone.utc) > d.timedelta(days=30) else 1)' "$expires"; then
    err "$sectxt expires $expires — move Expires out to a year from today"
  else
    ok "security.txt has Contact and an Expires more than 30 days out"
  fi
fi

note "Every API endpoint is gated"

# A new endpoint that forgets its session check is the highest-cost mistake in
# this repo: it publishes members' libraries. Anything with no gate and no 410
# has to be named in PUBLIC_ENDPOINTS above, which makes publishing a decision
# somebody wrote down rather than something that just happened.
section_ok=1
while IFS= read -r f; do
  rel="${f#functions/api/}"
  case " $PUBLIC_ENDPOINTS " in *" $rel "*) continue ;; esac
  if ! grep -qE 'getSession|getAdminSession|getConnectorAdminSession|isAdmin|CRON_SECRET|410' "$f"; then
    err "functions/api/$rel has no session/admin/cron gate and is not a 410 stub. Gate it, or add it to PUBLIC_ENDPOINTS in scripts/check-static.sh."
    section_ok=0
  fi
done < <(find functions/api -name '*.js' | sort)
[ "$section_ok" -eq 1 ] && ok "all API endpoints gated or explicitly public"

note "Session-scoped UI state"

# The 2026-08 logout bug: view-local state derived from the session outlived
# the session. SessionScope is the one place that state is defined, and the
# ShowPickerCore tests cover its teardown — so the thing worth asserting here
# is that the views still route through it.
for v in ios/ShowPickerIOS/Views/HomeView.swift ios/ShowPickerIOS/Views/IPadHomeView.swift; do
  grep -q 'SessionScope()' "$v" \
    || err "$v no longer uses SessionScope — session-derived state must clear on logout (docs/INVARIANTS.md)"
done
grep -q 'session.clear()' ios/ShowPickerIOS/Views/IPadHomeView.swift \
  || err "IPadHomeView must call session.clear() on logout"
ok "iPhone and iPad views route session state through SessionScope"

# Every web /auth/check must carry X-Client-Platform. That endpoint is the only
# writer of sessions.platform, and the same write is what makes a session
# visible to the reporting dashboard — so a call without the header counts the
# member in the "Unknown" row instead of on a web row. shell.js alone is loaded
# by eight pages, which is how most of that row got there.
note "Web auth checks name their platform"
missing=""
for f in $(grep -rl "fetch('/auth/check'" public 2>/dev/null); do
  # Each call must name the platform within its own options object — either the
  # header literal or one of the per-page helpers that returns it. There is no
  # shared module on this stack, so the literal is repeated per page and the
  # options can wrap onto the following lines.
  calls=$(grep -c "fetch('/auth/check'" "$f")
  named=$(grep -A 3 "fetch('/auth/check'" "$f" | grep -cE "X-Client-Platform|[pP]latformHeader\(\)")
  [ "$named" -ge "$calls" ] || missing="$missing $f"
done
if [ -n "$missing" ]; then
  err "these pages call /auth/check without X-Client-Platform, which lands the member in reporting's Unknown row:$missing"
else
  ok "every web /auth/check sends X-Client-Platform"
fi

# The mirror of the same bug, shipped in 1.2 (build 21): a brand-new member is
# not in the roster the app fetched before they had an account, so `myMember`
# resolved to nil and Home lost My Shows, Groups, Calendar, Rate My Shows,
# Subscription Audit and Vibe until the app was force-quit. Signing in has to
# refetch what was loaded without a session.
for v in ios/ShowPickerIOS/Views/HomeView.swift ios/ShowPickerIOS/Views/IPadHomeView.swift; do
  awk '/onChange\(of: auth\.memberSlug\)/{n=20} n&&n--' "$v" | grep -q 'await load()' \
    || err "$v must refetch the roster when auth.memberSlug becomes non-nil (docs/INVARIANTS.md)"
done
ok "signing in refetches the roster myMember is resolved from"

echo
if [ "$fail" -eq 0 ]; then echo "PASS — static invariants hold"; else echo "FAILED"; fi
exit $fail
