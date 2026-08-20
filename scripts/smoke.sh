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
  local code attempt
  for attempt in 1 2 3; do
    code=$(status "$1" "$2")
    [ "$code" = "$3" ] && break
    # A 5xx — or no response at all — is the edge having a moment, not the
    # endpoint answering wrongly: the 2026-08-20 nightly failed on two
    # consecutive 503s from Cloudflare with healthy responses either side
    # (#398). Only that shape is retried. A definitive wrong answer (a 200
    # where a 401 belongs) is the regression this suite exists to catch and
    # fails on the first sighting.
    case "$code" in
      5??|000) [ "$attempt" -lt 3 ] && sleep 5 ;;
      *) break ;;
    esac
  done
  if [ "$code" != "$3" ]; then
    err "$1 $2 returned $code, expected $3 ($4)"
  else
    ok "$1 $2 → $3"
  fi
}

# `grep -q` exits on its first match, so a `printf … | grep -q` pipeline leaves
# printf writing into a closed pipe. Under `set -o pipefail` that SIGPIPE
# becomes the pipeline's exit status and reads as "not found" — but only once
# the body outgrows the 64KB pipe buffer, which is why it never fired against
# the 15KB marketing page and fires on every check against the ~180KB app.
# Herestrings hand grep the whole body at once, with no pipe to break.

note "Marketing page + catch-all"

# The catch-all must serve the web app for any path that isn't a real file —
# that's what makes a shared /patrick link render that member's lists in a
# browser, and what lets every stale deep link land somewhere sensible.
#
# This is the assertion that caught the 2026-08-13 outage, when the catch-all
# pointed at /app.html and Pages 308-looped every path on the site. Asserted by
# content, not byte count: a size floor would eventually trip for the wrong
# reason.
#
# The /.env probe used to live here and folded two questions into one
# assertion, which is why it failed on deploys that were fine: the edge
# sometimes answers a scanner-shaped request with a block page. The leak
# question is asked separately below, on terms that don't depend on what
# Cloudflare decides to do with it. Retried because one dropped response
# shouldn't fail a deploy.
catchall=""
for attempt in 1 2 3; do
  catchall=$(get "$(cb "$BASE/no-such-page-$RANDOM")")
  grep -q 'id="loginOverlay"' <<< "$catchall" && break
  [ "$attempt" -lt 3 ] && sleep 5
done
if grep -q 'id="loginOverlay"' <<< "$catchall"; then
  ok "catch-all serves the web app"
else
  err "an unknown path did not return the web app — see public/_redirects"
fi

# A member slug is the case the catch-all exists for, and it must arrive as a
# 200 rather than a redirect: a 301 would discard which member the link named.
slug_code=$(get -o /dev/null -w "%{http_code}" "$(cb "$BASE/patrick")")
[ "$slug_code" = "200" ] \
  && ok "/patrick → 200 with its URL intact" \
  || err "/patrick returned $slug_code — member links must be a 200 rewrite, not a redirect"

# Leaked-path probe, asked the way it actually matters. Nothing under public/
# is a dotfile, so /.env should never resolve — but what would make it a real
# incident is env content coming back, not which non-answer the edge chose.
# The marketing page and a Cloudflare block page are both fine; KEY=value is
# not. Named secrets are listed in README.md#secrets.
dotenv=$(get "$(cb "$BASE/.env")")
if grep -qE '^[A-Z][A-Z0-9_]{2,}=.' <<< "$dotenv"; then
  err "/.env returned environment-variable assignments — secrets are leaking"
elif grep -qE 'CLOUDFLARE_API_TOKEN|TWILIO_|RESEND_API_KEY|ANTHROPIC_API_KEY|OMDB_API_KEY|TMDB_API_KEY|CRON_SECRET' <<< "$dotenv"; then
  err "/.env named a known secret — secrets are leaking"
else
  ok "/.env exposes no environment content"
fi

# The root is the app — that is the only shape the catch-all supports (see
# public/_redirects). It must carry its shared scripts, which it loads by src:
# a missing one is a page that renders and then does nothing.
home=$(get "$(cb "$BASE/")")
for needed in "id=\"loginOverlay\"" "nav.js" "show-renderer.js"; do
  grep -qF "$needed" <<< "$home" \
    && ok "root carries $needed" \
    || err "root is missing $needed — the web app is broken (docs/PRODUCT.md#web-app-status)"
done
# Every unmatched URL previews from this page, so its og:image is the fallback
# card for every share without tags of its own.
grep -qF 'og-default.png' <<< "$home" \
  && ok "root carries the fallback og:image" \
  || err "root has no og:image — shared links arrive with no artwork"

# The marketing page moved to /download when the app took the root back. It is
# still the page the App Store CTA lives on.
download=$(get "$(cb "$BASE/download")")
grep -q 'id="shelf"' <<< "$download" \
  && ok "/download serves the marketing page" \
  || err "/download is not the marketing page — see public/download.html"
grep -qF 'apps.apple.com/app/id' <<< "$download" \
  && ok "marketing page links the App Store" \
  || err "marketing page has no App Store link"

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
if grep -q '"shows"' <<< "$popular"; then
  ok "/api/popular responds"
else
  err "/api/popular did not return a shows array"
fi
# `members` must be present-but-empty (or absent) for an anonymous caller.
if grep -qE '"members":\[[^]]' <<< "$popular"; then
  err "/api/popular named members to an anonymous caller — see functions/api/popular.js"
else
  ok "/api/popular names no members when logged out"
fi
# member_slugs is deleted server-side before the response is built.
if grep -q 'member_slugs' <<< "$popular"; then
  err "/api/popular exposed member_slugs"
else
  ok "/api/popular hides member_slugs"
fi

# The network picker the apps fetch. Public on purpose (a constant table, no
# member data), and worth a live check because a 404 here doesn't break an app
# loudly — every installed copy just stays frozen on the list it cached, and
# nobody finds out until a member asks where a service went.
networks=$(get "$(cb "$BASE/api/networks")")
if grep -q '"networks"' <<< "$networks" && grep -q '"stored"' <<< "$networks"; then
  ok "/api/networks serves the picker"
else
  err "/api/networks did not return a networks array — installed apps are stuck on their cached list"
fi
if grep -qE '"stored":"Netflix"' <<< "$networks"; then
  ok "/api/networks carries the canonical names"
else
  err "/api/networks is missing canonical entries"
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

# These are real files. A 301 here means a stale rule in _redirects is bouncing
# a member off the page they asked for; a 308 means the catch-all is rewriting
# to something Pages canonicalizes, which is what took the site down on
# 2026-08-13. Either way the catch-all would hide it by rendering the app.
for path in /download /welcome /groups /rate-backlog /subscriptions /vibe \
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
grep -qF 'NQ6AJVVBBJ.net.patrickturner.showpickerios' <<< "$aasa" \
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
