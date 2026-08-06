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
#   shows/suggest.js — catalog lookup for the Add-a-Show flow. Returns no
#     member data, but it does proxy TMDB/OMDB unauthenticated, so it spends
#     our upstream quota for anyone who calls it. Known; see docs/INVARIANTS.md.
#   shows/[id]/actors.js — cast list for a title. Catalog data, and it reveals
#     nothing about whose row the id belongs to.
PUBLIC_ENDPOINTS="shows/suggest.js shows/[id]/actors.js"

note "Deployed output contains only the marketing site"

# The member app and the four admin tools were archived in 2026-08. If any of
# them reappear under public/ they deploy, and the web member app is back.
section_ok=1
for f in members.html reporting.html url-cleanup.html vibe-admin.html vibe.html \
         subscriptions.html groups.html rate-backlog.html welcome.html \
         shell.js nav.js show-renderer.js app-banner.js; do
  if [ -e "public/$f" ]; then
    err "public/$f is back — the web member app was retired (docs/PRODUCT.md#web-app-status)"
    section_ok=0
  fi
done
[ "$section_ok" -eq 1 ] && ok "no retired pages under public/"

for f in index.html privacy.html terms.html sms.html styles.css favicon.svg \
         sw.js _headers _redirects .well-known/apple-app-site-association; do
  [ -e "public/$f" ] || err "public/$f is missing"
done
ok "expected marketing files present"

note "Marketing page"

# The smoke test's leaked-path probe greps for this marker. If the page loses
# it, that probe silently stops proving anything.
grep -q 'id="shelf"' public/index.html \
  && ok "index.html keeps the id=\"shelf\" smoke marker" \
  || err "index.html lost id=\"shelf\" — scripts/smoke.sh's /.env probe depends on it"

# The CTA link and the Smart App Banner must name the same listing; they drifted
# apart once already when the listing was re-created.
cta_id=$(grep -o 'apps\.apple\.com/app/id[0-9]\+' public/index.html | head -1 | grep -o '[0-9]\+')
meta_id=$(grep -o 'apple-itunes-app" content="app-id=[0-9]\+' public/index.html | grep -o '[0-9]\+$')
if [ -n "$cta_id" ] && [ "$cta_id" = "$meta_id" ]; then
  ok "App Store id consistent (CTA and meta both $cta_id)"
else
  err "App Store id mismatch: CTA=${cta_id:-none} meta=${meta_id:-none} (docs/APP_STORE_SUBMISSION.md §7)"
fi

note "Redirects"

for path in /join /setup /requests /admin /welcome /groups /rate-backlog \
            /subscriptions /vibe /members /reporting /url-cleanup /vibe-admin; do
  grep -qE "^${path}[[:space:]]" public/_redirects \
    || err "public/_redirects has no rule for $path"
done
ok "every retired path has a redirect rule"

# The catch-all must stay a 200 rewrite. As a 301 the URL is discarded, and a
# shared member link stops carrying who it was about.
grep -qE '^/\*[[:space:]]+/index\.html[[:space:]]+200' public/_redirects \
  && ok "catch-all is a 200 rewrite" \
  || err "public/_redirects catch-all must be '/*  /index.html  200'"

# Member slugs must not be redirected — that would break the universal-link
# behaviour the new-signup email depends on.
grep -qE '^/(patrick|whitt|dorothy)[[:space:]]' public/_redirects \
  && err "member slugs must not be redirected (they must fall through to the catch-all)" \
  || ok "member slugs fall through to the catch-all"

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
for stale in appleid.apple.com accounts.google.com challenges.cloudflare.com; do
  echo "$csp_line" | grep -qF "$stale" \
    && err "CSP still allows $stale — web sign-in was retired in 2026-08"
done
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

# Anything the app can't render must stay excluded, or iOS swallows the URL and
# shows the user nothing.
required = ["/api/*", "/auth/*", "/calendar/*", "/.well-known/*"]
excluded = {c.get("/") for c in comps if c.get("exclude")}
missing = [p for p in required if p not in excluded]
if missing:
    print(f"::error::{path} must exclude {', '.join(missing)}")
    sys.exit(1)
print("  ok  AASA claims /*, excludes API/auth/calendar, carries the app ID")
PY

# _headers must serve it as JSON or iOS ignores the file entirely.
grep -A2 '^/\.well-known/apple-app-site-association' public/_headers | grep -qi 'application/json' \
  && ok "AASA has its application/json rule" \
  || err "public/_headers must serve the AASA file as application/json"

note "Every API endpoint is gated"

# A new endpoint that forgets its session check is the highest-cost mistake in
# this repo: it publishes members' libraries. Anything with no gate and no 410
# has to be named in PUBLIC_ENDPOINTS above, which makes publishing a decision
# somebody wrote down rather than something that just happened.
section_ok=1
while IFS= read -r f; do
  rel="${f#functions/api/}"
  case " $PUBLIC_ENDPOINTS " in *" $rel "*) continue ;; esac
  if ! grep -qE 'getSession|getAdminSession|isAdmin|CRON_SECRET|410' "$f"; then
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

echo
if [ "$fail" -eq 0 ]; then echo "PASS — static invariants hold"; else echo "FAILED"; fi
exit $fail
