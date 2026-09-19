// Raw accessor for the dupe_ignores table. Originally backed the interactive
// /members "Possible duplicates" panel (removed 2026-09, along with the
// panel's merge UI — Patrick decided not to keep worrying about it there);
// now it's the ledger admin-dupe-check.js writes to so its monthly email
// doesn't repeat the same pair, and this endpoint is what's left to inspect
// or hand-clear a row (curl with an admin session cookie — no UI button
// anywhere calls it).
//
//   GET  → { ignores: [{ slug_a, slug_b }] }
//   POST { action: 'ignore'|'unignore', pairs: [[a, b], ...] }
//
// A pair is stored sorted (slug_a <= slug_b) so either direction matches; a
// self-pair (a === a) means "stop flagging this account's hidden-email-only
// status". The table is created on demand so the feature works regardless of
// whether migration 034 has run yet (the migration is the same CREATE,
// idempotent).

import { isAdmin } from '../_shared/admin.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS dupe_ignores (
  slug_a TEXT NOT NULL,
  slug_b TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (slug_a, slug_b)
)`;

function sortedPair(raw) {
  if (!Array.isArray(raw)) return null;
  const a = String(raw[0] || '').trim();
  const b = String(raw[1] !== undefined ? raw[1] : raw[0] || '').trim();
  if (!a || !b) return null;
  return a <= b ? [a, b] : [b, a];
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) {
    return json({ error: 'forbidden' }, 403);
  }
  // Pre-table (or pre-migration) databases just have no ignores yet.
  const { results } = await env.DB.prepare(
    'SELECT slug_a, slug_b FROM dupe_ignores ORDER BY created_at'
  ).all().catch(() => ({ results: [] }));
  return json({ ignores: results || [] });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAdmin(request, env))) {
    return json({ error: 'forbidden' }, 403);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const action = body.action;
  if (action !== 'ignore' && action !== 'unignore') {
    return json({ error: 'unknown_action' }, 400);
  }
  const pairs = (Array.isArray(body.pairs) ? body.pairs : [])
    .map(sortedPair).filter(Boolean);
  if (!pairs.length) return json({ error: 'missing_pairs' }, 400);

  if (action === 'ignore') {
    await env.DB.prepare(CREATE_TABLE).run();
    // Only ignore matches between members that actually exist — a typo'd
    // slug would otherwise sit invisibly in the table forever.
    for (const [a, b] of pairs) {
      const known = await env.DB.prepare(
        'SELECT COUNT(*) AS cnt FROM members WHERE slug IN (?1, ?2)'
      ).bind(a, b).first();
      if ((known?.cnt || 0) < (a === b ? 1 : 2)) {
        return json({ error: 'unknown_member' }, 404);
      }
      await env.DB.prepare(
        'INSERT OR IGNORE INTO dupe_ignores (slug_a, slug_b) VALUES (?1, ?2)'
      ).bind(a, b).run();
    }
  } else {
    for (const [a, b] of pairs) {
      await env.DB.prepare(
        'DELETE FROM dupe_ignores WHERE slug_a = ?1 AND slug_b = ?2'
      ).bind(a, b).run().catch(() => {});
    }
  }
  return json({ ok: true, action, count: pairs.length });
}
