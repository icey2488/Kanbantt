/**
 * Kanbantt — OAuth authorization-code exchange (Cloudflare Pages Function).
 *
 * Route: POST /api/auth/exchange
 *
 * The ONLY server-side component in Kanbantt. It exists for one reason: Google's
 * "Web application" OAuth client type requires the client_secret at the token
 * endpoint even when PKCE is used, so the exchange cannot happen in the browser
 * without publishing the secret. This Function holds the secret in its env and
 * swaps an authorization code for an access token. It never sees Drive data, sets
 * no cookies, and stores nothing — a stateless secret-holder.
 *
 * Env (Cloudflare Pages -> Settings -> Environment variables):
 *   GOOGLE_CLIENT_ID       public client id
 *   GOOGLE_CLIENT_SECRET   the secret (mark Encrypted)
 *   OAUTH_REDIRECT_URI     the exact registered redirect URI, e.g.
 *                          https://kanbantt.icehunter.net/   (trailing slash included)
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const { code, code_verifier, redirect_uri } = body || {};
  if (!code || !code_verifier || !redirect_uri) {
    return json({ error: 'missing_parameters' }, 400);
  }

  // Refuse to act as a generic exchanger: the redirect_uri must be the one we
  // registered. Cheap guard against this route being driven by another origin.
  if (redirect_uri !== env.OAUTH_REDIRECT_URI) {
    return json({ error: 'redirect_uri_mismatch' }, 400);
  }

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri,
  });

  let resp;
  try {
    resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch {
    return json({ error: 'token_endpoint_unreachable' }, 502);
  }

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    // Surface Google's error label for debugging; never echo our secret.
    return json(
      { error: data.error || 'token_exchange_failed', detail: data.error_description || null },
      resp.status,
    );
  }

  // Return only what the SPA needs. We deliberately do NOT forward a refresh_token
  // (Shape A holds no long-lived credential anywhere): the browser requests online
  // access so none is issued, but drop it defensively regardless.
  return json({
    access_token: data.access_token,
    expires_in: data.expires_in,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
