// Not an OpenID provider — a plain 404 says so. Without this file the path
// fell through to the SPA catch-all and answered 200 with the home page's
// HTML, which a client probing OpenID discovery can read as metadata it then
// fails to parse, instead of moving on to oauth-authorization-server.
import { oauthJson, preflight } from '../../_shared/oauth.js';

export function onRequestGet() {
  return oauthJson({ error: 'not_found', error_description: 'Use /.well-known/oauth-authorization-server.' }, 404);
}

export const onRequestOptions = () => preflight('GET');
