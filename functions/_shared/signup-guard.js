// A per-email limit on wrong signup codes.
//
// Member login codes already have a per-account failure cap on top of the
// per-IP one (auth/login.js MAX_MEMBER_FAILS), because the IP cap alone doesn't
// stop a guesser who rotates addresses. Signup codes (enroll_otps) had only the
// IP cap, so a distributed guesser could take a not-yet-registered email by
// guessing its code and enrolling first (security audit run-2).
//
// Failures are counted in failed_logins under a key derived from the email (a
// hash, so the log holds no address). Past the cap the email's live signup
// codes are spent, so a guess that would have matched one stops matching.

export const SIGNUP_WINDOW_MIN = 15;
export const MAX_SIGNUP_FAILS = 10;

async function keyFor(email) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`signup:${email}`));
  return 'signup:' + [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signupFailureCount(env, email) {
  const since = new Date(Date.now() - SIGNUP_WINDOW_MIN * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM failed_logins WHERE member_slug = ? AND created_at > ?'
  ).bind(await keyFor(email), since).first().catch(() => null);
  return row?.cnt || 0;
}

export async function signupLocked(env, email) {
  return (await signupFailureCount(env, email)) >= MAX_SIGNUP_FAILS;
}

// Records one wrong signup code against both the IP and the email. At the cap,
// every live code for the email is spent.
export async function recordSignupFailure(env, ip, email) {
  const nowISO = new Date().toISOString();
  await env.DB.prepare('INSERT INTO failed_logins (ip, member_slug, created_at) VALUES (?, ?, ?)')
    .bind(ip, await keyFor(email), nowISO).run();
  if (await signupLocked(env, email)) {
    await env.DB.prepare('UPDATE enroll_otps SET used_at = ? WHERE email = ? AND used_at IS NULL')
      .bind(nowISO, email).run().catch(() => {});
  }
}
