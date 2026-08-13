#!/usr/bin/env bash
#
# Show Picker Club — live smoke + security assertions against a running site.
#
#   scripts/smoke.sh [base-url]      # default https://showpicker.club
#
# Exits non-zero if any assertion fails, printing every failure rather than
# stopping at the first — one run should tell you everything that's wrong.
# Emits GitHub Actions ::error:: annotations when running under Actions, and
# plain text otherwise, so it's equally usable from a laptop.
#
# This is the deterministic half of the safety net. It cannot catch client-side
# regressions (the 2026-08 logout bug was stale SwiftUI @State — every HTTP
# response involved was correct); those are covered by the ShowPickerCore tests
# and the invariants review. What it does catch: an endpoint that stops
# requiring a session, a retired endpoint coming back to life, a redirect that
# stops redirecting, missing security headers, a public endpoint that starts
# leaking member-derived fields, and a broken app-site-association file — which
# would silently kill every universal link, including the one in the new-signup
# email.

set -uo pipefail

BASE="${1:-https://showpicker.club}"
BASE="${BASE%/}"

fail=0
checks=0

err() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error::$1"; else echo "FAIL: $1"; fi
  fail=1
}
ok()   { checks=$((checks + 1)); echo "  ok  $1"; }
note() { echo; echo "== $1"; }

# Cache-buster on every request: Cloudflare will happily serve an edge-cached
# copy of the previous deploy and make a broken one look fine.
cb() { echo "$1?nocache=$RANDOM$RANDOM"; }

# Every request goes out looking like a browser. Bare curl asking a production
# domain for paths like /.env is indistinguishable from a vulnerability
# scanner, and Cloudflare will sometimes answer it with a block page instead of
# the site — correct behavior at the edge, but it used to fail this suite for a
# reason that had nothing to do with the deploy.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
get() { curl -sS -A "$UA" "$@"; }

status() { # method path -> http code
  get -o /dev/null -w "%{http_code}" -X "$1" \
    -H "Content-Type: application/json" -d '{}' "$(cb "${BASE}$2")"
}

expect_status() { # method path expected label
  local code
  code=$(status "$1" "$2")
  if [ "$code" != "$3" ]; then
    err "$1 $2 returned $code, expected $3 ($4)"
  else
    ok "$1 $2 → $3"
  fi
}

note "Marketing page + catch-all"

# The catch-all must serve the web app for any path that isn't a real file —
# that's what makes a shared /patrick link render that member's lists in a
# browser, and what lets every stale deep link land somewhere sensible.
# Asserted by content, not byte count: a size floor would eventually trip for
# the wrong reason.
#
# This used to probe /.env and fold two questions into one assertion, which is
# why it failed on deploys that were fine: the edge sometimes answers a
# scanner-shaped request with a block page. The leak question is asked
# separately below, on terms that don't depend on what Cloudflare decides to do
# with it. Retried because one dropped response shouldn't fail a deploy.
catchall=""
for attempt in 1 2 3; do
  catchall=$(get "$(cb "$BASE/no-such-page-$RANDOM")")
  printf '%s' "$catchall" | grep -q 'id="loginOverlay"' && break
  [ "$attempt" -lt 3 ] && sleep 5
done
if printf '%s' "$catchall" | grep -q 'id="loginOverlay"'; then
  ok "catch-all serves the web app"
else
  err "an unknown path did not return the web app — see public/_redirects"
fi

# Leaked-path probe, asked the way it actually matters. Nothing under public/
# is a dotfile, so /.env should never resolve — but what would make it a real
# incident is env content coming back, not which non-answer the edge chose.
# The marketing page and a Cloudflare block page are both fine; KEY=value is
# not. Named secrets are listed in README.md#secrets.
dotenv=$(get "$(cb "$BASE/.env")")
if printf '%s' "$dotenv" | grep -qE '^[A-Z][A-Z0-9_]{2,}=.'; then
  err "/.env returned environment-variable assignments — secrets are leaking"
elif printf '%s' "$dotenv" | grep -qE 'CLOUDFLARE_API_TOKEN|TWILIO_|RESEND_API_KEY|ANTHROPIC_API_KEY|OMDB_API_KEY|TMDB_API_KEY|CRON_SECRET'; then
  err "/.env named a known secret — secrets are leaking"
else
  ok "/.env exposes no environment content"
fi

# The root is the marketing page, and it is what the Google Ads campaign pays
# to land on — so it must keep its App Store CTA and its way into the app.
home=$(get "$(cb "$BASE/")")
printf '%s' "$home" | grep -q 'id="shelf"' \
  && ok "root serves the marketing page" \
  || err "root is not the marketing page — see public/index.html"
printf '%s' "$home" | grep -qF 'apps.apple.com/app/id' \
  && ok "landing page links the App Store" \
  || err "landing page has no App Store link"
printf '%s' "$home" | grep -qF 'href="/app"' \
  && ok "landing page links into the web app" \
  || err "landing page has no /app link — there is no way into the web app from the root"

# The app itself, at its own URL. It loads its shared scripts by src, so a
# missing one is a page that renders and then does nothing.
app=$(get "$(cb "$BASE/app")")
for needed in "id=\"loginOverlay\"" "nav.js" "show-renderer.js"; do
  printf '%s' "$app" | grep -qF "$needed" \
    && ok "/app carries $needed" \
    || err "/app is missing $needed — the web app is broken (docs/PRODUCT.md#web-app-status)"
done

note "Security headers"

headers=$(get -I "$(cb "$BASE/")")
for h in content-security-policy strict-transport-security x-frame-options \
         x-content-type-options permissions-policy; do
  if echo "$headers" | grep -qi "^$h:"; then ok "$h present"; else err "missing header $h"; fi
done

# Directives that carry real weight — a CSP that loses these is a CSP in name
# only. frame-ancestors backs X-Frame-Options; base-uri and form-action close
# off injection routes the others don't.
csp=$(echo "$headers" | grep -i '^content-security-policy:' || true)
for directive in "default-src" "frame-ancestors 'none'" "base-uri 'self'" "object-src\|default-src"; do
  if echo "$csp" | grep -qi -- "$directive"; then ok "CSP has $directive"; else err "CSP missing $directive"; fi
done
# Web sign-in is back. Each of these fails silently without its source — the
# button renders and the flow simply never completes — so assert them here
# rather than finding out from a member who can't log in.
for src in "appleid.apple.com" "accounts.google.com" "challenges.cloudflare.com"; do
  if echo "$csp" | grep -qF "$src"; then
    ok "CSP allows $src"
  else
    err "CSP no longer allows $src — web sign-in needs it"
  fi
done

note "Auth gates (no session → 401)"

expect_status GET  /api/vibe            401 "member taste profile"
expect_status POST /api/enrich          401 "background enrichment"
expect_status POST /api/sync-urls       401 "watch-URL sync"
expect_status GET  /api/shows           401 "a member's lists"
expect_status GET  /api/shows/all       401 "every list"
expect_status GET  /api/shows/check     401 "list membership"
expect_status GET  /api/activity        401 "activity feed"
expect_status GET  /api/recommendations 401 "picks for you"
expect_status GET  /api/subscriptions   401 "subscription audit"
expect_status GET  /api/groups          401 "groups"
expect_status GET  /api/rate-backlog    401 "unrated shows"
expect_status POST /api/shows/suggest   401 "catalog lookup (gated 2026-08: it proxies TMDB/OMDB)"
expect_status GET  /api/passkeys        401 "registered passkeys"
# Adding a passkey is what turns a device into a way back in, so this endpoint
# being open would let anyone attach their own credential to any account.
expect_status POST /auth/passkey-register-begin  401 "passkey enrollment"
expect_status POST /auth/passkey-register-finish 401 "passkey enrollment (finish)"

note "Admin gate (no session → 403)"

expect_status GET /api/reporting 403 "admin metrics"

note "Retired endpoints stay retired (410)"

# Share-to-member and suggest-a-show were removed in 2026-07. They reject every
# caller regardless of session, so they're checked separately from the 401 set.
expect_status POST /api/shows/share 410 "retired: share to member"
expect_status POST /api/suggestions 410 "retired: suggest a show"

note "Calendar feeds require their key"

expect_status GET /calendar/patrick.ics 404 "bare slug, no key"

note "Public surface leaks nothing member-derived"

# Trending is public on purpose — the titles are the club's taste. But logged
# out it must name nobody: "added by" needs a relationship a stranger doesn't
# have. This is the endpoint behind the marketing page's shelf.
popular=$(get "$(cb "$BASE/api/popular")")
if printf '%s' "$popular" | grep -q '"shows"'; then
  ok "/api/popular responds"
else
  err "/api/popular did not return a shows array"
fi
# `members` must be present-but-empty (or absent) for an anonymous caller.
if printf '%s' "$popular" | grep -qE '"members":\[[^]]'; then
  err "/api/popular named members to an anonymous caller — see functions/api/popular.js"
else
  ok "/api/popular names no members when logged out"
fi
# member_slugs is deleted server-side before the response is built.
if printf '%s' "$popular" | grep -q 'member_slugs'; then
  err "/api/popular exposed member_slugs"
else
  ok "/api/popular hides member_slugs"
fi

note "Retired paths still redirect"

# Member approval went away for good in 2026-08 (migration 058). These four
# have no page behind them.
for path in /join /setup /requests /admin; do
  code=$(get -o /dev/null -w "%{http_code}" "$(cb "${BASE}${path}")")
  if [ "$code" = "301" ] || [ "$code" = "308" ]; then
    ok "$path → $code"
  else
    err "$path returned $code, expected a 301 (public/_redirects)"
  fi
done

note "Web-app pages are served, not redirected"

# These are real files again. A 301 here means a stale rule in _redirects is
# bouncing members off the page they asked for; the catch-all would otherwise
# hide the mistake by rendering the app at every one of them.
for path in /app /welcome /groups /rate-backlog /subscriptions /vibe \
            /members /reporting /url-cleanup /vibe-admin; do
  code=$(get -o /dev/null -w "%{http_code}" "$(cb "${BASE}${path}")")
  if [ "$code" = "200" ]; then
    ok "$path → 200"
  else
    err "$path returned $code, expected 200 (public/_redirects)"
  fi
done

note "Universal links (apple-app-site-association)"

# A broken AASA silently breaks every universal link on every device, and
# Apple's CDN caches it for hours — so a bad deploy is expensive to undo.
aasa_headers=$(get -I "$(cb "$BASE/.well-known/apple-app-site-association")")
echo "$aasa_headers" | grep -qi '^content-type: *application/json' \
  && ok "AASA served as application/json" \
  || err "AASA is not application/json — iOS will ignore it (see public/_headers)"

aasa=$(get "$(cb "$BASE/.well-known/apple-app-site-association")")
if printf '%s' "$aasa" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  ok "AASA is valid JSON"
else
  err "AASA is not valid JSON"
fi
printf '%s' "$aasa" | grep -qF 'NQ6AJVVBBJ.net.patrickturner.showpickerios' \
  && ok "AASA carries the app ID" \
  || err "AASA is missing the app ID — universal links are dead"

# Member slugs must NOT be excluded: that catch-all is what lets a shared
# /patrick link (and the new-signup email) open the app.
printf '%s' "$aasa" | python3 -c '
import json, sys
d = json.load(sys.stdin)
comps = d["applinks"]["details"][0]["components"]
catchall = [c for c in comps if c.get("/") == "/*" and not c.get("exclude")]
sys.exit(0 if catchall else 1)
' 2>/dev/null \
  && ok "AASA still claims member pages via /*" \
  || err "AASA no longer claims /* — member-page links stopped opening the app"

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — $checks assertions against $BASE"
else
  echo "FAILED against $BASE"
fi
exit $fail
