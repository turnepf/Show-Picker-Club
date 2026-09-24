// Protected Resource Metadata (RFC 9728) for the MCP endpoint. An MCP client
// that gets a 401 from /mcp follows the WWW-Authenticate header here to learn
// which authorization server to use. Served at both the bare path and the
// /mcp-suffixed one, which is where the 2025-06 MCP spec tells clients to
// look first. Public by nature: it names endpoints, not members.
import { issuerFor, resourceFor, oauthJson, preflight, SCOPES } from '../../_shared/oauth.js';

export async function onRequestGet({ request }) {
  return oauthJson({
    resource: resourceFor(request),
    authorization_servers: [issuerFor(request)],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Show Picker Club',
    resource_documentation: `${issuerFor(request)}/connect`,
  }, 200, { 'Cache-Control': 'public, max-age=3600' });
}

export const onRequestOptions = () => preflight('GET');
