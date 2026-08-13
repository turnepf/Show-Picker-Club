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
PUBLIC_ENDPOINTS="shows/[id]/actors.js"

note "Deployed output carries the marketing site and the web app"

# The member app came back in 2026-08 after four weeks archived. Its pages are
# useless without the shared scripts they load, and the failure mode is a page
# that renders half-empty rather than one that errors, so check the whole set.
for f in index.html privacy.html terms.html sms.html styles.css favicon.svg \
         sw.js _headers _redirects .well-known/apple-app-site-association \
         app.html welcome.html groups.html vibe.html rate-backlog.html \
         subscriptions.html members.html reporting.html url-cleanup.html \
         vibe-admin.html shell.js nav.js show-renderer.js app-banner.js; do
  [ -e "public/$f" ] || err "public/$f is missing"
done
ok "marketing files and web-app pages present"

# The app is served at /app, not at /. If app.html ever starts treating the
# root as its home again it will read "" as a member slug on the marketing
# page's URL and every home link will point at the pitch instead.
grep -q "APP_HOME = '/app'" public/app.html \
  && ok "app.html anchors its home at /app" \
  || err "public/app.html lost APP_HOME — the app must know it lives at /app, not /"

note "Marketing page"

# The smoke test greps for this marker to prove the root still serves the
# marketing page rather than the app. If the page loses it, that probe silently
# stops proving anything.
grep -q 'id="shelf"' public/index.html \
  && ok "index.html keeps the id=\"shelf\" smoke marker" \
  || err "index.html lost id=\"shelf\" — scripts/smoke.sh's catch-all probe depends on it"

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

# Member approval is gone for good (migration 058) — these four have no page
# behind them and must keep redirecting.
for path in /join /setup /requests /admin; do
  grep -qE "^${path}[[:space:]]" public/_redirects \
    || err "public/_redirects has no rule for $path"
done
ok "every retired path has a redirect rule"

# The web-app surfaces are served by real files again, so a leftover 301 would
# bounce a member off the page they asked for.
for path in /welcome /groups /rate-backlog /subscriptions /vibe /members \
            /reporting /url-cleanup; do
  grep -qE "^${path}[[:space:]]" public/_redirects \
    && err "public/_redirects still redirects $path — that page is served again"
done
ok "restored pages are not redirected away"

# The catch-all must stay a 200 rewrite to the app. As a 301 the URL is
# discarded, and a shared member link stops carrying who it was about.
grep -qE '^/\*[[:space:]]+/app\.html[[:space:]]+200' public/_redirects \
  && ok "catch-all is a 200 rewrite to the app" \
  || err "public/_redirects catch-all must be '/*  /app.html  200'"

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
required = ["/api/*", "/auth/*", "/calendar/*", "/.well-known/*"]
excluded = {c.get("/") for c in comps if c.get("exclude")}
missing = [p for p in required if p not in excluded]
if missing:
    print(f"::error::{path} must exclude {', '.join(missing)}")
    sys.exit(1)
print("  ok  AASA claims /*, excludes API/auth/calendar, carries the app ID")
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
