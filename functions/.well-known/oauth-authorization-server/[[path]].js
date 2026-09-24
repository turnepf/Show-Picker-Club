// Authorization Server Metadata (RFC 8414). Everything an MCP client needs
// to connect without a developer portal: where to register itself, where to
// send the member, where to trade the code. Public by nature.
import { issuerFor, oauthJson, preflight, SCOPES } from '../../_shared/oauth.js';

export async function onRequestGet({ request }) {
  const issuer = issuerFor(request);
  return oauthJson({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/connect`,
  }, 200, { 'Cache-Control': 'public, max-age=3600' });
}

export const onRequestOptions = () => preflight('GET');
