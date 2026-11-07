// The win-back email: "we saved your spot", sent from Patrick to members who
// haven't visited in 60+ days. Driven by POST /api/admin-winback, which the
// operator runs from the Actions tab (scripts/winback.mjs) — nothing schedules
// it, and nothing reaches a member until a run is started with mode "send".
//
// Each inactive member gets exactly one of four versions, the first that fits:
//
//   awaiting — shows on their Awaiting list premiered a season since their
//              last visit. Up to three are named, each linked to its card.
//   group    — a group they're in has new shows or Watch Next cards from
//              other members since their last visit.
//   start    — their library is empty, so "your lists are as you left them"
//              would be untrue.
//   general  — everybody else.
//
// "Last visit" is the latest of their last sign-in, any session's last ping
// and their signup. A member who stays signed in never signs in again, so
// last_login_at alone would call daily users inactive.
//
// Who never gets it: disabled members, the demo account, anyone who used the
// unsubscribe link (members.email_opt_out, migration 090), anyone with no
// email address, and anyone already sent one for this lapse —
// winback_sent_at must predate their last visit, so the email goes out again
// only after they come back and go quiet for another 60 days.
//
// Privacy: the email goes to the member's own address and names only their
// own shows and their own groups' activity — never a memo, and a group-mate
// appears by first name only, as inside the group itself.

import { sendEmail } from './email.js';
import { demoMemberSlug } from './demo.js';

export const INACTIVE_DAYS = 60;
export const SITE = 'https://showpicker.club';
export const FROM = 'Patrick at Show Picker Club <patrick@showpicker.club>';
export const REPLY_TO = 'patrick@showpicker.club';
// Preview mode sends one of each version here and nowhere else. A constant
// rather than an input, so the cron secret can't be used to mail anybody.
export const PREVIEW_TO = 'patrick@showpicker.club';
// The example request in the "Bring your AI along" line names a real show,
// linked to its card like every other show in the email.
export const EXAMPLE_SHOW = 'The Diplomat';
const MAX_SHOWS_NAMED = 3;
const EPOCH = "'1970-01-01 00:00:00'";

// Every inactive member, with their last visit normalized to SQLite's
// datetime format so it compares against the other timestamp shapes stored.
const CANDIDATES_CTE = `
  cand AS (
    SELECT slug, first_name, name, winback_sent_at, last_seen FROM (
      SELECT m.slug, m.first_name, m.name, m.winback_sent_at,
        MAX(
          COALESCE(datetime(m.last_login_at), ${EPOCH}),
          COALESCE(datetime(m.created_at), ${EPOCH}),
          COALESCE((SELECT MAX(datetime(s.last_seen_at)) FROM sessions s WHERE s.member_slug = m.slug), ${EPOCH}),
          COALESCE((SELECT MAX(datetime(s.created_at)) FROM sessions s WHERE s.member_slug = m.slug), ${EPOCH})
        ) AS last_seen
      FROM members m
      WHERE m.disabled = 0 AND COALESCE(m.email_opt_out, 0) = 0 AND m.slug <> ?1
    )
    WHERE last_seen < datetime('now', '-${INACTIVE_DAYS} days')
  )`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : '';
}

export const showUrl = (id) => `${SITE}/show/${encodeURIComponent(id)}`;

// ---- unsubscribe tokens ----
//
// HMAC-SHA256 of the slug, keyed by CRON_SECRET under its own label so the
// token can't be mistaken for anything else signed with that key. No expiry:
// an unsubscribe link in an old email must keep working.
export async function unsubscribeToken(env, slug) {
  if (!env.CRON_SECRET) throw new Error('CRON_SECRET is not set');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.CRON_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`unsubscribe:v1:${slug}`),
  ));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}

export async function verifyUnsubscribeToken(env, slug, token) {
  if (!slug || !token || !env.CRON_SECRET) return false;
  const expected = await unsubscribeToken(env, slug);
  if (expected.length !== String(token).length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ String(token).charCodeAt(i);
  return diff === 0;
}

export async function unsubscribeUrl(env, slug) {
  const t = await unsubscribeToken(env, slug);
  return `${SITE}/api/unsubscribe?m=${encodeURIComponent(slug)}&t=${encodeURIComponent(t)}`;
}

// ---- who gets which version ----

function joinNames(names) {
  const n = names.length;
  if (n === 0) return '';
  if (n === 1) return names[0];
  if (n === 2) return `${names[0]} and ${names[1]}`;
  if (n === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${n - 2} others`;
}

// Every inactive member and the version they'd get. `unsentOnly` drops
// anyone already sent one for this lapse (the send path); the plan and the
// preview show everybody.
export async function planWinback(env, { unsentOnly = false } = {}) {
  const demo = (await demoMemberSlug(env).catch(() => null)) || '';
  const all = async (sql) => (await env.DB.prepare(sql).bind(demo).all()).results || [];

  const cands = await all(`WITH ${CANDIDATES_CTE} SELECT * FROM cand ORDER BY slug`);

  // Awaiting rows whose season premiered after the member's last visit and
  // has aired by now. Either date may be the one TMDB filled.
  const backRows = await all(`WITH ${CANDIDATES_CTE}
    SELECT v.member_slug, v.id, v.title, v.current_season,
      CASE
        WHEN v.season_premiere_date IS NOT NULL
         AND datetime(v.season_premiere_date) > c.last_seen
         AND date(v.season_premiere_date) <= date('now') THEN v.season_premiere_date
        ELSE v.next_season_date
      END AS back_on,
      CASE
        WHEN v.season_premiere_date IS NOT NULL
         AND datetime(v.season_premiere_date) > c.last_seen
         AND date(v.season_premiere_date) <= date('now') THEN 1 ELSE 0
      END AS season_known
    FROM shows_v v JOIN cand c ON c.slug = v.member_slug
    WHERE v.list = 'waiting' AND COALESCE(v.archived, 0) = 0
      AND (
        (v.season_premiere_date IS NOT NULL AND datetime(v.season_premiere_date) > c.last_seen
          AND date(v.season_premiere_date) <= date('now'))
        OR (v.next_season_date IS NOT NULL AND datetime(v.next_season_date) > c.last_seen
          AND date(v.next_season_date) <= date('now'))
      )
    ORDER BY back_on DESC, v.id`);

  // Per group the member is in: shows other members added and Watch Next
  // cards from others they haven't answered, both since their last visit.
  const groupRows = await all(`WITH ${CANDIDATES_CTE}
    SELECT c.slug, g.id AS group_id, g.name AS group_name,
      (SELECT COUNT(*) FROM shows s
        JOIN group_members gm2 ON gm2.group_id = g.id AND gm2.member_slug = s.member_slug
        WHERE s.member_slug <> c.slug AND s.created_at IS NOT NULL
          AND COALESCE(s.added_by, '') <> 'seed'
          AND datetime(s.created_at) > c.last_seen) AS added,
      (SELECT GROUP_CONCAT(DISTINCT COALESCE(NULLIF(m2.first_name, ''), m2.name)) FROM shows s
        JOIN group_members gm2 ON gm2.group_id = g.id AND gm2.member_slug = s.member_slug
        JOIN members m2 ON m2.slug = s.member_slug
        WHERE s.member_slug <> c.slug AND s.created_at IS NOT NULL
          AND COALESCE(s.added_by, '') <> 'seed'
          AND datetime(s.created_at) > c.last_seen) AS adders,
      (SELECT COUNT(*) FROM group_suggestions gs
        WHERE gs.group_id = g.id AND gs.suggested_by <> c.slug
          AND datetime(gs.created_at) > c.last_seen
          AND NOT EXISTS (SELECT 1 FROM group_suggestion_responses r
                          WHERE r.suggestion_id = gs.id AND r.member_slug = c.slug)) AS recs
    FROM cand c
    JOIN group_members gm ON gm.member_slug = c.slug
    JOIN groups g ON g.id = gm.group_id`);

  const libRows = await all(`WITH ${CANDIDATES_CTE}
    SELECT c.slug, (SELECT COUNT(*) FROM shows s WHERE s.member_slug = c.slug AND COALESCE(s.archived, 0) = 0) AS n
    FROM cand c`);

  const emailRows = await all(`WITH ${CANDIDATES_CTE}
    SELECT e.member_slug, e.email FROM member_emails e JOIN cand c ON c.slug = e.member_slug
    ORDER BY e.member_slug, e.is_primary DESC, e.id`);

  // The example show: the member's own copy when they have one, else the
  // club's first copy, so the link always opens a real card.
  const exampleRows = (await env.DB.prepare(
    'SELECT id, member_slug FROM shows_v WHERE title = ? AND COALESCE(movie, 0) = 0 ORDER BY id',
  ).bind(EXAMPLE_SHOW).all()).results || [];
  const exampleFallback = exampleRows[0]?.id ?? null;
  const exampleOwn = new Map();
  for (const r of exampleRows) if (!exampleOwn.has(r.member_slug)) exampleOwn.set(r.member_slug, r.id);

  const back = new Map();
  for (const r of backRows) {
    if (!back.has(r.member_slug)) back.set(r.member_slug, []);
    const list = back.get(r.member_slug);
    if (!list.some((x) => x.id === r.id)) list.push(r);
  }
  const bestGroup = new Map();
  for (const r of groupRows) {
    const score = Number(r.added) + Number(r.recs);
    if (score === 0) continue;
    const prev = bestGroup.get(r.slug);
    if (!prev || score > Number(prev.added) + Number(prev.recs)) bestGroup.set(r.slug, r);
  }
  const libSize = new Map(libRows.map((r) => [r.slug, Number(r.n)]));
  const emails = new Map();
  for (const r of emailRows) if (!emails.has(r.member_slug)) emails.set(r.member_slug, r.email);

  const plan = [];
  for (const c of cands) {
    if (unsentOnly && c.winback_sent_at && c.winback_sent_at >= c.last_seen) continue;
    // A sent stamp is datetime('now') format, last_seen is too: comparable.
    const entry = {
      slug: c.slug,
      first_name: c.first_name || (c.name || '').split(' ')[0] || 'there',
      last_seen: c.last_seen,
      email: emails.get(c.slug) || null,
      already_sent: !!(c.winback_sent_at && c.winback_sent_at >= c.last_seen),
      example_show_id: exampleOwn.get(c.slug) ?? exampleFallback,
    };
    const shows = back.get(c.slug);
    const group = bestGroup.get(c.slug);
    if (shows?.length) {
      entry.variant = 'awaiting';
      entry.shows = shows.map((s) => ({
        id: s.id, title: s.title, season: s.season_known ? s.current_season : null, back_on: s.back_on,
      }));
    } else if (group) {
      entry.variant = 'group';
      entry.group = {
        name: group.group_name,
        added: Number(group.added),
        recs: Number(group.recs),
        adders: String(group.adders || '').split(',').filter(Boolean),
      };
    } else if (!libSize.get(c.slug)) {
      entry.variant = 'start';
    } else {
      entry.variant = 'general';
    }
    plan.push(entry);
  }
  return plan;
}

// ---- the email itself ----

const FEATURES = (exampleId) => [
  ['Groups', 'Start a private group with family or friends to see what everybody\'s watching and recommend shows to each other. Only people you invite can join.'],
  ['Bring your AI along', {
    text: `Connect Claude, ChatGPT or another AI app to your lists, and ask things like "what should we watch tonight?" or "add the new season of ${EXAMPLE_SHOW} to my list."`,
    html: `Connect Claude, ChatGPT or another AI app to your lists, and ask things like “what should we watch tonight?” or “add the new season of ${
      exampleId ? `<a href="${esc(showUrl(exampleId))}" style="color:#E67E22;">${esc(EXAMPLE_SHOW)}</a>` : esc(EXAMPLE_SHOW)
    } to my list.”`,
  }],
  ['Trending', 'See what the whole club is watching right now.'],
  ['Your favorite actors', 'Rate your shows and we\'ll rank the actors you keep coming back to.'],
  ['Bring your list with you', 'Have shows sitting in a note or a text? Paste the whole thing in and we\'ll sort it onto your lists.'],
  ['On every screen you own', 'iPhone, iPad, Mac, Apple TV, Apple Watch, Roku, and the web at showpicker.club.'],
];

function showLine(s) {
  const when = shortDate(s.back_on);
  const what = s.season ? `Season ${s.season} premiered` : 'New season premiered';
  return { title: s.title, rest: when ? `${what} ${when}` : what, id: s.id };
}

// Returns { subject, text, html } for one plan entry.
export function renderWinback(entry, { unsubscribe }) {
  const name = entry.first_name;
  const intro = 'It\'s been a little while since you stopped by Show Picker Club';
  let subject, paras = [], cta, lines = null, moreLine = null;

  if (entry.variant === 'awaiting') {
    const shows = entry.shows.slice(0, MAX_SHOWS_NAMED).map(showLine);
    const more = entry.shows.length - shows.length;
    const n = entry.shows.length;
    subject = n === 1
      ? `${entry.shows[0].title} is back`
      : `${n} shows you were waiting on are back`;
    paras.push(`${intro}, and ${n === 1 ? 'a show you were waiting on came' : 'some shows you were waiting on came'} back while you were away:`);
    lines = shows;
    if (more > 0) moreLine = `…and ${more} more.`;
    paras.push(`${n === 1 ? 'It\'s' : 'They\'re'} still right where you left ${n === 1 ? 'it' : 'them'} on your Awaiting list. Move ${n === 1 ? 'it' : 'them'} to Watching when you're ready to dig in.`);
    cta = { label: 'Pick up where you left off', url: `${SITE}/${encodeURIComponent(entry.slug)}` };
  } else if (entry.variant === 'group') {
    const g = entry.group;
    subject = `${g.name} has been busy`;
    const bits = [];
    if (g.added > 0) {
      const who = joinNames(g.adders);
      bits.push(`${who} ${g.adders.length === 1 ? 'has' : 'have'} added ${g.added} show${g.added === 1 ? '' : 's'}`);
    }
    if (g.recs > 0) {
      bits.push(`there ${g.recs === 1 ? 'is 1 recommendation' : `are ${g.recs} recommendations`} waiting for you on Watch Next`);
    }
    const since = bits.length === 2 ? `${bits[0]}, and ${bits[1]}` : bits[0];
    paras.push(`${intro}. Your group, ${g.name}, has kept right on going without you. Since your last visit, ${since}.`);
    paras.push('Come see what they\'re watching. Anything that catches your eye goes onto your own Next Up list with one tap.');
    cta = { label: `See what ${g.name} is watching`, url: `${SITE}/groups` };
  } else if (entry.variant === 'start') {
    subject = 'We saved your spot';
    paras.push(`${intro}, and we've been busy. Your lists are ready whenever you are. Paste in what you've been meaning to watch and you're set.`);
    cta = { label: 'Back to Show Picker Club', url: `${SITE}/` };
  } else {
    subject = 'We saved your spot';
    paras.push(`${intro}, and we've been busy. Your lists are just as you left them, and there's a lot new around them.`);
    cta = { label: 'Back to Show Picker Club', url: `${SITE}/` };
  }

  const features = FEATURES(entry.example_show_id);

  // ---- plain text ----
  const t = [`Hey ${name},`, ''];
  t.push(paras[0], '');
  if (lines) {
    for (const l of lines) t.push(`${l.title}: ${l.rest}`, `  ${showUrl(l.id)}`);
    if (moreLine) t.push(moreLine);
    t.push('');
  }
  for (const p of paras.slice(1)) t.push(p, '');
  t.push(`${cta.label}: ${cta.url}`, '', 'What\'s new since your last visit', '');
  for (const [h, body] of features) t.push(`${h}. ${typeof body === 'string' ? body : body.text}`, '');
  t.push(`Get the apps: ${SITE}/download`, '', 'Hope to see you back soon,', 'Patrick', '',
    `You're getting this because you're a member of Show Picker Club. Unsubscribe: ${unsubscribe}`);
  const text = t.join('\n');

  // ---- HTML ----
  const P = 'font-size:16px;line-height:1.55;margin:0 0 16px;color:#2C2C2C;';
  const showList = lines ? `
    <div style="background:#FBF5EB;border-radius:10px;padding:14px 18px;margin:0 0 16px;">
      ${lines.map((l) => `<p style="font-size:16px;line-height:1.5;margin:0 0 6px;"><a href="${esc(showUrl(l.id))}" style="color:#E67E22;font-weight:600;text-decoration:none;">${esc(l.title)}</a> <span style="color:#666;">· ${esc(l.rest)}</span></p>`).join('\n      ')}
      ${moreLine ? `<p style="font-size:15px;color:#666;margin:6px 0 0;">${esc(moreLine)}</p>` : ''}
    </div>` : '';
  const featureHtml = features.map(([h, body]) => `
      <p style="font-size:15px;line-height:1.5;margin:0 0 12px;color:#2C2C2C;"><strong style="color:#2C3E50;">${esc(h)}.</strong> ${typeof body === 'string' ? esc(body) : body.html}</p>`).join('');
  const html = `<div style="background:#F4F1EC;padding:24px 12px;">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:14px;padding:28px 24px;">
    <p style="font-size:14px;font-weight:600;color:#E67E22;margin:0 0 8px;">Show Picker Club</p>
    <h1 style="font-size:26px;line-height:1.2;color:#2C3E50;margin:0 0 18px;">${esc(subject)}</h1>
    <p style="${P}">Hey ${esc(name)},</p>
    <p style="${P}">${esc(paras[0])}</p>${showList}
    ${paras.slice(1).map((p) => `<p style="${P}">${esc(p)}</p>`).join('\n    ')}
    <p style="margin:22px 0 26px;"><a href="${esc(cta.url)}" style="display:inline-block;background:#E67E22;color:#FFFFFF;font-weight:600;font-size:16px;text-decoration:none;padding:12px 22px;border-radius:999px;">${esc(cta.label)}</a></p>
    <h2 style="font-size:18px;color:#2C3E50;margin:0 0 12px;border-top:1px solid #EEE;padding-top:20px;">What's new since your last visit</h2>${featureHtml}
    <p style="font-size:15px;margin:4px 0 22px;"><a href="${SITE}/download" style="color:#E67E22;">Get the apps</a></p>
    <p style="${P}">Hope to see you back soon,<br>Patrick</p>
  </div>
  <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;color:#888;text-align:center;margin:16px 0 0;">You're getting this because you're a member of Show Picker Club. <a href="${esc(unsubscribe)}" style="color:#888;">Unsubscribe</a></p>
</div>`;

  return { subject, text, html };
}

// Sends one plan entry. `to` overrides the recipient (preview mode).
export async function sendWinback(env, entry, { to, preview = false } = {}) {
  // A preview's unsubscribe link must not be able to opt the sample member
  // out, so it carries a slug no member has.
  const unsubscribe = preview ? `${SITE}/api/unsubscribe?m=preview&t=preview` : await unsubscribeUrl(env, entry.slug);
  const msg = renderWinback(entry, { unsubscribe });
  return sendEmail(env, {
    to: to || entry.email,
    subject: preview ? `[Preview: ${entry.variant}, ${entry.slug}] ${msg.subject}` : msg.subject,
    text: msg.text,
    html: msg.html,
    from: FROM,
    replyTo: REPLY_TO,
    headers: {
      'List-Unsubscribe': `<${unsubscribe}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
}
