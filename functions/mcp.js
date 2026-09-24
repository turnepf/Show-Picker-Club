// /mcp — Show Picker Club as a remote MCP server (Streamable HTTP transport,
// stateless, JSON responses only).
//
// A member connects an AI app here and the app can read and change their
// lists with exactly the permissions they have in the app — the tools in
// _shared/mcp-tools.js call the same handlers the apps do. How that stays
// safe is docs/INVARIANTS.md §27; scripts/mcp-test.mjs pins it. The short
// version:
//
//   - Only an OAuth access token gets in. A session cookie does NOT: this
//     endpoint takes writes, and a cookie would let any web page a member
//     visits drive it. No cookie, no CSRF.
//   - The token's scopes decide which tools exist. A read-only connection
//     isn't shown the write tools, and can't call them by name.
//   - Per-member daily caps, because an agent in a loop is a client that
//     never gets bored (the D1 read budget went on 2026-09-01 to bots).
//
// Stateless: no Mcp-Session-Id and no server-initiated stream, so GET is 405
// as the transport spec allows. Every POST carries everything it needs.

import { authenticateBearer, issuerFor, oauthJson, preflight } from './_shared/oauth.js';
import { recordPlatformUsage } from './_shared/platform.js';
import { toolsFor, toolNamed, ToolError, DAILY_CAPS } from './_shared/mcp-tools.js';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];


const SERVER_INFO = { name: 'show-picker-club', title: 'Show Picker Club', version: '1.0.0' };

const INSTRUCTIONS = `Show Picker Club is the member's TV and movie tracker. They keep four lists:
watching, awaiting (finished the current season, waiting for the next), loved (finished and would recommend), and next_up (want to watch).
Shows are identified by show_id. To add something, call search_titles first and pass its tmdb_id and media_type to add_show.
Notes, recommended_by and watching_with are the member's private memos. Group-mates (people in the member's private groups) can be seen with list_member_shows and named in watching_with_members.
Prefer archive_show over delete_show, and confirm with the member before delete_show, leave_group or remove_recommendation.`;

function unauthorized(request, presented) {
  const meta = `${issuerFor(request)}/.well-known/oauth-protected-resource/mcp`;
  const challenge = presented
    ? `Bearer error="invalid_token", error_description="The access token is invalid or expired", resource_metadata="${meta}"`
    : `Bearer resource_metadata="${meta}"`;
  return oauthJson({ error: presented ? 'invalid_token' : 'unauthorized' }, 401, { 'WWW-Authenticate': challenge });
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// Counts this call against the member's day and says whether it's allowed.
// Counted before it runs, so a refused call still counts — a client that
// hammers past the cap stays past it.
async function spend(env, slug, tool) {
  const w = tool.scope === 'shows:write' ? 1 : 0;
  const s = tool.search ? 1 : 0;
  const row = await env.DB.prepare(
    `INSERT INTO mcp_usage (member_slug, day, calls, writes, searches) VALUES (?, date('now'), 1, ?, ?)
     ON CONFLICT(member_slug, day) DO UPDATE SET
       calls = calls + 1, writes = writes + excluded.writes, searches = searches + excluded.searches
     RETURNING calls, writes, searches`
  ).bind(slug, w, s).first();
  if (!row) return null;
  if (row.calls > DAILY_CAPS.calls) return `You've reached today's limit of ${DAILY_CAPS.calls} Show Picker Club actions from connected apps. It resets at midnight UTC.`;
  if (w && row.writes > DAILY_CAPS.writes) return `You've reached today's limit of ${DAILY_CAPS.writes} changes from connected apps. It resets at midnight UTC.`;
  if (s && row.searches > DAILY_CAPS.searches) return `You've reached today's limit of ${DAILY_CAPS.searches} catalog searches from connected apps. It resets at midnight UTC.`;
  return null;
}

async function callTool(ctx, params) {
  const name = params && params.name;
  const tool = toolNamed(name);
  // A tool outside the token's scopes is reported as unknown, the same as
  // one that doesn't exist: tools/list never offered it.
  if (!tool || !ctx.scopes.includes(tool.scope)) {
    return { error: { code: -32602, message: `Unknown tool: ${String(name).slice(0, 60)}` } };
  }
  const args = (params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
  const over = await spend(ctx.env, ctx.session.member_slug, tool);
  if (over) return { result: { content: [{ type: 'text', text: over }], isError: true } };
  try {
    const out = await tool.run(ctx, args);
    return {
      result: {
        content: [{ type: 'text', text: JSON.stringify(out) }],
        structuredContent: out,
      },
    };
  } catch (e) {
    const message = e instanceof ToolError ? e.message : 'Something went wrong on Show Picker Club’s side. Try again.';
    return { result: { content: [{ type: 'text', text: message }], isError: true } };
  }
}

async function handle(ctx, msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id, -32600, 'Invalid Request');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params && msg.params.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, { tools: toolsFor(ctx.scopes) });
    case 'tools/call': {
      const r = await callTool(ctx, msg.params || {});
      return r.error ? rpcError(msg.id, r.error.code, r.error.message) : rpcResult(msg.id, r.result);
    }
    case 'resources/list':
      return rpcResult(msg.id, { resources: [] });
    case 'prompts/list':
      return rpcResult(msg.id, { prompts: [] });
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method.slice(0, 60)}`);
  }
}

// Who used a connection, and on which "platform", for the Connected apps
// screens and /api/reporting. Throttled to once every five minutes per grant
// so a chatty session isn't a write per call.
async function noteUse(env, auth) {
  try {
    const res = await env.DB.prepare(
      `UPDATE oauth_grants SET last_used_at = datetime('now')
        WHERE id = ? AND (last_used_at IS NULL OR datetime(last_used_at) < datetime('now', '-5 minutes'))`
    ).bind(auth.grant_id).run();
    if (res.meta && res.meta.changes) await recordPlatformUsage(env, auth.member_slug, 'mcp');
  } catch (e) { /* bookkeeping never fails a call */ }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const presented = /^Bearer\s/i.test(request.headers.get('Authorization') || '');
  const auth = await authenticateBearer(request, env);
  if (!auth) return unauthorized(request, presented);

  let payload;
  try { payload = await request.json(); } catch {
    return oauthJson(rpcError(null, -32700, 'Parse error'), 400);
  }

  const ctx = {
    env,
    origin: issuerFor(request),
    session: { member_slug: auth.member_slug, email: auth.email, expires_at: null },
    scopes: auth.scopes,
    waitUntil: (p) => (context.waitUntil ? context.waitUntil(p) : p),
  };
  ctx.waitUntil(noteUse(env, auth));

  if (Array.isArray(payload)) {
    if (!payload.length) return oauthJson(rpcError(null, -32600, 'Empty batch'), 400);
    const out = [];
    for (const m of payload.slice(0, 20)) {
      const r = await handle(ctx, m);
      if (r) out.push(r);
    }
    return out.length ? oauthJson(out) : new Response(null, { status: 202 });
  }
  const r = await handle(ctx, payload);
  return r ? oauthJson(r) : new Response(null, { status: 202, headers: { 'Access-Control-Allow-Origin': '*' } });
}

// No server-initiated stream and no sessions to end (transport spec: 405).
export function onRequestGet() {
  return new Response(JSON.stringify({ error: 'Use POST. Show Picker Club’s MCP server is stateless.' }), {
    status: 405, headers: { Allow: 'POST', 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
export const onRequestDelete = onRequestGet;
export const onRequestOptions = () => preflight('POST, GET, DELETE');
