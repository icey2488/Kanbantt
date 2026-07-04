/**
 * Kanbantt — Google OAuth (authorization-code + PKCE).
 *
 * Replaces the deprecated GIS implicit token model. Flow:
 *   Connect -> top-level redirect to Google's consent -> Google returns an
 *   authorization code to REDIRECT_URI -> the code + PKCE verifier are exchanged
 *   for an access token by a same-origin Cloudflare Pages Function
 *   (/api/auth/exchange) that holds the client_secret server-side. No popup, so
 *   the COOP window.closed failure that killed popup mode cannot occur.
 *
 * Why a Function at all: Google's "Web application" OAuth client requires the
 * client_secret at the token endpoint even with PKCE, so the exchange cannot be
 * done in the browser without publishing the secret. The Function is the only
 * server-side component; it touches an auth code + the secret, never Drive data.
 *
 * Tokens live in memory only. There is NO refresh token (online access): when the
 * access token expires, withToken() silently re-acquires via a prompt=none
 * top-level redirect. Data-safe because the board persists locally and to Drive
 * across the navigation. A per-tab attempt counter caps consecutive silent
 * re-acquires so a persistent failure can never become an infinite redirect loop.
 *
 * Public API is unchanged from the GIS version:
 *   initAuth, signIn, signOut, withToken, getUser, isSignedIn, isGisReady, getGrantedScopes
 *
 * --- Behavioral note ----------------------------------------------------------
 * To avoid a redirect bounce on every page load, a returning device does NOT
 * acquire a token at boot; it reports signed-OUT until a token is first needed
 * (explicit Connect or deliberate sync), then the prompt=none redirect restores
 * the session. Optional upgrades if that window matters: cache a minimal profile
 * at sign-in for an optimistic connected state, or beginAuth('none') at boot.
 *
 * --- Caller contract ----------------------------------------------------------
 * withToken() MAY navigate the page (the prompt=none redirect). Passive/background
 * callers must gate on isSignedIn() and skip when false; only explicit user intent
 * should reach a navigating withToken(). drive-sync.js already enforces this in
 * triggerRead/requestWrite/markDirty/requestWriteKeepalive/start.
 *
 * Failure handling: terminal failures (4xx, state mismatch, malformed token)
 * clear the connected flag and require an explicit reconnect; transient failures
 * (network, 5xx) keep the flag and report signed-out so a later need can recover.
 */

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'openid',
  'email',
  'profile',
].join(' ');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';
const EXCHANGE_ENDPOINT = '/api/auth/exchange'; // same-origin Cloudflare Pages Function

// Must EXACTLY match the Authorized redirect URI registered in the Google console
// (scheme + host + trailing slash). Sent to the Function, which re-checks it.
const REDIRECT_URI = typeof window !== 'undefined' ? window.location.origin + '/' : '';

// Refresh this many ms before the real expiry.
const EXPIRY_BUFFER_MS = 60_000;

// Device-local flag (NOT board data): set after a successful exchange, cleared on
// explicit sign-out, a terminal failure, or the loop breaker tripping.
const CONNECTED_FLAG = 'kanbantt_google_connected';

// PKCE handshake values — sessionStorage so they survive the top-level redirect
// within the same tab, and are gone when the tab closes.
const SS_VERIFIER = 'kanbantt_pkce_verifier';
const SS_STATE = 'kanbantt_oauth_state';

// Per-tab counter of consecutive silent (prompt=none) re-acquires without a
// success. Caps the redirect loop. Reset on a successful exchange and on an
// explicit sign-in.
const SS_ATTEMPTS = 'kanbantt_oauth_attempts';
const MAX_SILENT_REDIRECTS = 2;

let currentToken = null; // { access_token, expires_at }
let currentUser = null;  // { sub, email, name, picture }
let onChangeCb = null;
let initialized = false;
let clientId = null;
let returnHandled = false; // module scope: handle the redirect-return at most once per load
let redirecting = false;   // module scope: at most one redirect in flight per load

/* ------------------------------------------------------------------------ */
/* Setup + redirect-return handling                                         */
/* ------------------------------------------------------------------------ */

/**
 * Initialize auth. Call once at app boot, before signIn(). If the page is loading
 * as the OAuth redirect target (has ?code or ?error), the return is handled here.
 *
 * @param {string} id - GCP OAuth 2.0 Web client ID
 * @param {object} opts
 * @param {(state: {user, signedIn}) => void} opts.onChange
 */
export async function initAuth(id, { onChange } = {}) {
  if (!id) throw new Error('initAuth: clientId is required');
  // Trim so a stray space in VITE_GOOGLE_CLIENT_ID can't corrupt the auth URL.
  clientId = String(id).trim();
  onChangeCb = onChange || null;
  initialized = true;

  const params = new URLSearchParams(window.location.search);

  if (params.has('code') && params.has('state')) {
    // Idempotency guard: StrictMode/HMR/remount can invoke this twice, and the
    // early scrubUrl below normally clears the params before a second read — but
    // if replaceState ever fails silently, this prevents a second pass from
    // mis-handling the return. At most one handling per page load.
    if (returnHandled) return;
    returnHandled = true;
    await handleAuthReturn(params);
    return;
  }
  if (params.has('error')) {
    // prompt=none could not silently comply, or the user denied consent. Fail
    // quietly and clear the flag so the next load does NOT auto-bounce (loop guard).
    clearPkce();
    scrubUrl();
    failQuietly();
    return;
  }
  // Normal load: do NOT navigate. A previously-connected device acquires its token
  // lazily on first need (see Behavioral note), so a look-and-leave visit never
  // redirects to Google.
}

async function handleAuthReturn(params) {
  const returnedState = params.get('state');
  const code = params.get('code');
  const expectedState = ssGet(SS_STATE);
  const verifier = ssGet(SS_VERIFIER);
  clearPkce();
  scrubUrl();

  // No stored verifier/state means we never initiated this sign-in: a stale tab or
  // a crafted ?code&state link. Ignore it; do not disturb the existing session.
  if (!expectedState || !verifier) {
    return;
  }
  // A flow was in progress but the state doesn't match — failed/forged handshake.
  if (returnedState !== expectedState) {
    failQuietly();
    return;
  }

  let resp;
  try {
    resp = await fetch(EXCHANGE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: REDIRECT_URI }),
    });
  } catch (e) {
    // Couldn't reach our own Function — transient. Keep the connected flag so a
    // later attempt can recover; report signed-out for now.
    console.warn('auth exchange network error:', e);
    reportSignedOut();
    return;
  }

  if (resp.status >= 500) {
    // Edge / Function / upstream 5xx — transient. Keep the flag.
    console.warn('auth exchange transient error:', resp.status);
    reportSignedOut();
    return;
  }
  if (!resp.ok) {
    // 4xx — terminal (invalid_grant, redirect_uri_mismatch, ...). Clear the flag.
    console.warn('auth exchange rejected:', resp.status);
    failQuietly();
    return;
  }

  const data = await resp.json().catch(() => ({}));
  const ttl = Number(data.expires_in);
  if (!data.access_token || !Number.isFinite(ttl) || ttl <= 0) {
    // Malformed success: never compute a NaN/garbage expiry. Treat as terminal.
    console.warn('auth exchange returned an unusable token');
    failQuietly();
    return;
  }

  currentToken = {
    access_token: data.access_token,
    expires_at: Date.now() + ttl * 1000 - EXPIRY_BUFFER_MS,
  };
  setConnectedFlag();
  resetRedirectAttempts(); // a fresh token clears the loop counter
  try {
    currentUser = await fetchUserInfo();
  } catch (e) {
    console.warn('userinfo fetch failed:', e);
  }
  onChangeCb?.({ user: currentUser, signedIn: true });
}

/* ------------------------------------------------------------------------ */
/* Sign-in / sign-out                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Interactive sign-in: top-level redirect to Google's account chooser. The page
 * navigates away, so the returned promise never resolves in this context — the
 * app returns authenticated to a fresh load handled by initAuth().
 */
export async function signIn() {
  if (!initialized) throw new Error('signIn: call initAuth first');
  resetRedirectAttempts(); // explicit user action: clean slate for the loop guard
  await beginAuth('select_account');
  return new Promise(() => {}); // navigation in flight; this page is leaving
}

/** Sign out: best-effort revoke, then clear local state. */
export async function signOut() {
  if (currentToken?.access_token) {
    try {
      await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(currentToken.access_token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch {
      /* best-effort; a failed revoke must not block local sign-out */
    }
  }
  clearConnectedFlag(); // explicit disconnect: don't silently reconnect next load
  reportSignedOut();
}

/* ------------------------------------------------------------------------ */
/* Token access (used by data layers)                                       */
/* ------------------------------------------------------------------------ */

/**
 * Returns a valid access token. If expired/absent and this device is connected,
 * silently re-acquires via a prompt=none top-level redirect.
 *
 * WARNING: THIS MAY NAVIGATE THE PAGE. Passive/background callers must gate on
 * isSignedIn() and skip when false; only explicit user intent should call this
 * when a redirect is acceptable. (See the caller contract in the header.)
 */
export async function withToken() {
  if (currentToken && Date.now() < currentToken.expires_at) {
    return currentToken.access_token;
  }
  if (isConnectedFlag()) {
    if (getRedirectAttempts() >= MAX_SILENT_REDIRECTS) {
      // Circuit breaker: repeated silent re-acquires this tab without a success.
      // Stop bouncing; require an explicit reconnect.
      clearConnectedFlag();
      reportSignedOut();
      throw new Error('withToken: silent re-acquire failed repeatedly');
    }
    bumpRedirectAttempts();
    await beginAuth('none');
    return new Promise(() => {}); // navigation in flight; this page is leaving
  }
  throw new Error('withToken: not signed in');
}

/* ------------------------------------------------------------------------ */
/* PKCE redirect initiation                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Build the PKCE authorization request and navigate to Google. `prompt` is
 * 'select_account' for interactive sign-in or 'none' for a silent re-acquire.
 */
async function beginAuth(prompt) {
  if (redirecting) return; // a redirect is already in flight this load
  redirecting = true;

  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(16));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  ssSet(SS_VERIFIER, verifier);
  ssSet(SS_STATE, state);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt,
    include_granted_scopes: 'true',
    // NOTE: no access_type=offline -> online access -> no refresh token issued.
  });

  try {
    window.location.assign(`${AUTH_ENDPOINT}?${params.toString()}`);
  } catch (e) {
    // Navigation blocked/failed: don't wedge auth, and let callers reject instead
    // of hanging on the never-resolving promise.
    redirecting = false;
    throw new Error('beginAuth: navigation failed', { cause: e });
  }
}

/* ------------------------------------------------------------------------ */
/* Internal helpers                                                         */
/* ------------------------------------------------------------------------ */

// Clear in-memory session but KEEP the connected flag (transient failure path).
function reportSignedOut() {
  currentToken = null;
  currentUser = null;
  onChangeCb?.({ user: null, signedIn: false });
}

// Clear in-memory session AND the connected flag (terminal / explicit path).
function failQuietly() {
  clearConnectedFlag();
  reportSignedOut();
}

async function fetchUserInfo() {
  const r = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${currentToken.access_token}` },
  });
  if (!r.ok) throw new Error(`userinfo: ${r.status}`);
  return r.json();
}

function scrubUrl() {
  // Strip ?code/?state/?error from the address bar without reloading.
  try {
    window.history.replaceState({}, document.title, REDIRECT_URI);
  } catch {
    /* ignore */
  }
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---- device-local connected flag + PKCE handshake storage --------------- */

function isConnectedFlag() {
  try { return localStorage.getItem(CONNECTED_FLAG) === '1'; } catch { return false; }
}
function setConnectedFlag() {
  try { localStorage.setItem(CONNECTED_FLAG, '1'); } catch { /* private mode, etc. */ }
}
function clearConnectedFlag() {
  try { localStorage.removeItem(CONNECTED_FLAG); } catch { /* ignore */ }
}

function ssGet(k) {
  try { return sessionStorage.getItem(k); } catch { return null; }
}
function ssSet(k, v) {
  try { sessionStorage.setItem(k, v); } catch { /* ignore */ }
}
function clearPkce() {
  try {
    sessionStorage.removeItem(SS_VERIFIER);
    sessionStorage.removeItem(SS_STATE);
  } catch {
    /* ignore */
  }
}

function getRedirectAttempts() {
  const n = parseInt(ssGet(SS_ATTEMPTS) || '0', 10);
  return Number.isFinite(n) ? n : 0;
}
function bumpRedirectAttempts() {
  ssSet(SS_ATTEMPTS, String(getRedirectAttempts() + 1));
}
function resetRedirectAttempts() {
  try { sessionStorage.removeItem(SS_ATTEMPTS); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------------ */
/* Read-only state accessors (API-compatible with the GIS version)          */
/* ------------------------------------------------------------------------ */

export function getUser() {
  return currentUser;
}

export function isSignedIn() {
  return !!currentToken && Date.now() < currentToken.expires_at;
}

/**
 * Was GIS-readiness in the old model; there is no GIS to load now, so Connect can
 * always proceed. Kept for caller compatibility (UI that disables Connect on
 * !isGisReady()).
 */
export function isGisReady() {
  return true;
}

export function getGrantedScopes() {
  // Access tokens are opaque; granted scopes aren't exposed. We assume all
  // requested scopes were granted and rely on per-API 403 handling if not.
  return SCOPES.split(' ');
}
