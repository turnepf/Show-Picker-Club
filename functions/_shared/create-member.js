// Slugs that live at the root path (or could) — member pages are routed as
// /<slug>, so a member slug must never shadow a page, an API prefix, or a
// plausible future route. Candidates on this list are skipped, so a
// self-enrolled "Admin Smith" just lands on "admins"/"admin2" instead.
// `join`, `requests`, and `setup` are retired routes but stay reserved:
// they still 301 to /members, so a member must not land on them.
export const RESERVED_SLUGS = new Set([
  // static pages (public/*.html) and their extensionless routes
  'index', 'admin', 'join', 'members', 'privacy', 'reporting', 'setup',
  'sms', 'subscriptions', 'terms', 'url-cleanup', 'vibe', 'vibe-admin',
  'whats-new', 'requests',
  // routing prefixes and assets
  'api', 'auth', 'calendar', 'favicon', 'manifest', 'styles', 'shell', 'sw',
  // the MCP server and its OAuth screens (migration 071)
  'mcp', 'oauth', 'connect', 'connected-apps',
  // likely future routes / confusing names
  'about', 'account', 'app', 'delete', 'demo', 'help', 'login', 'logout',
  'me', 'new', 'settings', 'signup', 'support', 'test', 'www',
]);

// Core member-creation routine. Self-enrollment (_shared/enroll.js) is the
// only caller — there is no operator-created path any more, so there is no
// phone channel here either (signup is email/Apple/Google; members attach a
// phone afterwards via the roster editor). allowNoContact covers
// Apple/Google identities that arrive without an email.
// Returns either { ok: true, ...details } or { ok: false, status, error }.
export async function createMember(env, { full_name, emails, allowNoContact = false, enrolledVia = null, enrollIp = null }) {
  if (!full_name) {
    return { ok: false, status: 400, error: 'Full name required' };
  }
  if (!emails && !allowNoContact) {
    return { ok: false, status: 400, error: 'Provide at least one email' };
  }

  const emailList = (emails || '')
    .split(/[,;\s]+/)
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  for (const e of emailList) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return { ok: false, status: 400, error: `Email looks invalid: ${e}` };
    }
  }

  const tokens = full_name.trim().split(/\s+/);
  const firstName = tokens[0];
  const lastName = tokens.length > 1 ? tokens[tokens.length - 1] : null;
  const firstSlug = firstName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lastInitial = lastName
    ? lastName.toLowerCase().replace(/[^a-z0-9]/g, '').charAt(0)
    : '';

  if (!firstSlug) {
    return { ok: false, status: 400, error: 'Could not derive slug from name' };
  }

  const candidates = [firstSlug];
  if (lastInitial) candidates.push(firstSlug + lastInitial);
  for (let i = 2; i <= 20; i++) {
    candidates.push((lastInitial ? firstSlug + lastInitial : firstSlug) + i);
  }

  let slug = null;
  for (const cand of candidates) {
    if (RESERVED_SLUGS.has(cand)) continue;
    const hit = await env.DB.prepare('SELECT slug FROM members WHERE slug = ?').bind(cand).first();
    if (!hit) { slug = cand; break; }
  }
  if (!slug) {
    return { ok: false, status: 409, error: 'Could not find available slug' };
  }

  const displayName = `${firstName}'s Shows`;
  const editorName = firstName;
  const lastInitialUpper = lastInitial ? lastInitial.toUpperCase() : null;

  // calendar_token: per-member secret for the /calendar/<slug>.ics feed.
  // enroll_ip (migration 058) backs the per-IP signup cap and goes away with
  // the member when they delete their account.
  await env.DB.prepare(
    "INSERT INTO members (slug, name, first_name, last_initial, last_name, calendar_token, enrolled_via, enroll_ip) VALUES (?, ?, ?, ?, ?, lower(hex(randomblob(16))), ?, ?)"
  ).bind(slug, displayName, firstName, lastInitialUpper, lastName, enrolledVia, enrollIp).run();

  for (let i = 0; i < emailList.length; i++) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, ?)'
    ).bind(emailList[i], slug, i === 0 ? 1 : 0).run();
  }

  return {
    ok: true,
    slug,
    name: displayName,
    editor_name: editorName,
    url: `https://showpicker.club/${slug}`,
    emails: emailList,
  };
}
