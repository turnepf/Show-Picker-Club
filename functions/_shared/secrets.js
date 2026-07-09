// Constant-time secret comparison. A plain `===` on a secret leaks, in
// principle, how many leading characters matched via response timing.
// Hashing both sides first makes the byte-wise comparison loop independent
// of both the secret's length and where the first mismatch falls.
export async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// Shared check for the scheduled-job endpoints: a matching X-Cron-Secret
// header authorizes the request. Refuses outright when CRON_SECRET isn't
// configured, so a missing secret can never mean "open".
export async function cronAuthorized(request, env) {
  if (!env.CRON_SECRET) return false;
  const provided = request.headers.get('X-Cron-Secret') || '';
  return await timingSafeEqual(provided, env.CRON_SECRET);
}
