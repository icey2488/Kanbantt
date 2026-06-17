/**
 * Kanbantt — Google Identity Services integration.
 *
 * Pure client-side OAuth via GIS implicit token model. No backend, no token
 * persistence on disk, no PII relay. Tokens live in memory only and are
 * silently refreshed before expiry.
 *
 * Why GIS token client and not One Tap / id_token?
 *   We need an access_token to call Drive + Calendar APIs. One Tap returns an
 *   id_token which only identifies the user — useless for API authorization.
 *
 * Usage:
 *   import { initAuth, signIn, signOut, withToken, getUser, isSignedIn } from './auth.js';
 *
 *   await initAuth(import.meta.env.VITE_GOOGLE_CLIENT_ID, {
 *     onChange: (state) => setUserState(state),
 *   });
 *
 *   // From UI:
 *   await signIn();
 *
 *   // From any data layer:
 *   const token = await withToken();  // auto-refreshes if expired
 *   fetch(url, { headers: { Authorization: `Bearer ${token}` } });
 */

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'openid',
  'email',
  'profile',
].join(' ');

// Token expiry buffer — refresh this many ms before the actual expiry.
const EXPIRY_BUFFER_MS = 60_000;

let tokenClient = null;
let currentToken = null;   // { access_token, expires_at }
let currentUser = null;    // { sub, email, name, picture }
let onChangeCb = null;
let pendingTokenResolvers = []; // Resolved when next callback fires.
let initialized = false;
let clientId = null;          // stashed by initAuth for lazy GIS setup
let gisLoadPromise = null;    // memoized GIS script load (loaded on demand)

/* ------------------------------------------------------------------------ */
/* Setup                                                                    */
/* ------------------------------------------------------------------------ */

/** Load the GIS script tag if not already present. Resolves when ready. */
function loadGIS() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const existing = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('GIS script failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('GIS script failed to load'));
    document.head.appendChild(script);
  });
}

/**
 * Initialize auth. Call once at app boot, before signIn().
 *
 * @param {string} clientId - GCP OAuth 2.0 Web client ID
 * @param {object} opts
 * @param {(state: {user, signedIn}) => void} opts.onChange - Called on sign-in/out
 */
export async function initAuth(id, { onChange } = {}) {
  if (!id) throw new Error('initAuth: clientId is required');
  clientId = id;
  onChangeCb = onChange || null;
  initialized = true;

  // Local-first: do NOT touch Google on a fresh device. The GIS script and any
  // network traffic are deferred until either (a) this device previously
  // connected — then we silently re-acquire now — or (b) the user clicks
  // Connect (signIn). A fresh, never-connected device stays fully offline.
  if (isConnectedFlag()) {
    await ensureGis();        // returning device: load GIS now…
    maybeSilentReacquire();   // …and try once, silently, to restore the session
  }
}

/**
 * Lazily load the GIS script and create the token client. Memoized — safe to
 * call repeatedly (StrictMode, multiple connect attempts). Throws if the script
 * can't load (offline / ad-blocker), which callers translate to a disabled
 * Connect control.
 */
async function ensureGis() {
  if (tokenClient) return;
  if (!gisLoadPromise) gisLoadPromise = loadGIS();
  await gisLoadPromise;
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      // The single callback for both interactive and silent token requests.
      callback: handleTokenResponse,
      error_callback: handleTokenError,
    });
  }
}

/* ------------------------------------------------------------------------ */
/* Sign-in / sign-out                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Trigger interactive sign-in. Shows Google's account picker + consent screen.
 * Resolves with the user profile, or rejects on user dismissal / error.
 */
export async function signIn() {
  if (!initialized) throw new Error('signIn: call initAuth first');
  // Load GIS on demand — this is the first Google traffic for a fresh device,
  // and it happens inside the user's click gesture. If GIS can't load this
  // throws, and the caller renders the Connect control disabled.
  await ensureGis();
  return new Promise((resolve, reject) => {
    // Remember the explicit connection (device-local) so future loads can try a
    // silent re-acquire. Only an explicit, gesture-driven sign-in sets the flag.
    pendingTokenResolvers.push({
      resolve: (user) => { setConnectedFlag(); resolve(user); },
      reject,
    });
    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

/** Sign out: revoke the token with Google and clear local state. */
export async function signOut() {
  if (currentToken?.access_token) {
    await new Promise((resolve) => {
      window.google.accounts.oauth2.revoke(currentToken.access_token, () => resolve());
    });
  }
  currentToken = null;
  currentUser = null;
  clearConnectedFlag(); // explicit disconnect: don't silently reconnect next load
  onChangeCb?.({ user: null, signedIn: false });
}

/* ------------------------------------------------------------------------ */
/* Token access (used by data layers)                                       */
/* ------------------------------------------------------------------------ */

/**
 * Returns a valid access token, refreshing if expired.
 * All data-layer code should call this, never read currentToken directly.
 */
export async function withToken() {
  if (!currentToken) throw new Error('withToken: not signed in');
  if (Date.now() >= currentToken.expires_at) {
    await refreshSilently();
  }
  return currentToken.access_token;
}

/**
 * Silent token refresh — no UI shown. Works as long as the user hasn't revoked
 * consent in their Google account settings.
 */
function refreshSilently() {
  return new Promise((resolve, reject) => {
    pendingTokenResolvers.push({ resolve, reject });
    // Empty prompt = silent; Google reuses existing consent.
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

/* ------------------------------------------------------------------------ */
/* Device-local "previously connected" flag + silent re-acquisition         */
/* ------------------------------------------------------------------------ */

// Device-local config (NOT board data): a plain localStorage boolean, never the
// store blob. Set on explicit sign-in, cleared on explicit sign-out.
const CONNECTED_FLAG = 'kanbantt_google_connected';
const SILENT_TIMEOUT_MS = 8000;
let silentAttempted = false;

function isConnectedFlag() {
  try { return localStorage.getItem(CONNECTED_FLAG) === '1'; } catch { return false; }
}
function setConnectedFlag() {
  try { localStorage.setItem(CONNECTED_FLAG, '1'); } catch { /* private mode, etc. */ }
}
function clearConnectedFlag() {
  try { localStorage.removeItem(CONNECTED_FLAG); } catch { /* ignore */ }
}

/**
 * One-shot, module-scope silent re-acquisition. Runs at most once per page load
 * — the guard lives at module scope precisely because React 18 StrictMode
 * double-invokes component effects, and this must not.
 *
 * If this device previously connected, ask GIS for a token with NO prompt. EVERY
 * failure mode resolves to signed-out quietly: error_callback, a thrown
 * exception, GIS never loaded, or no callback at all (timeout). No popup, no
 * error UI, no retry, and no unhandled rejection reaching the console.
 */
function maybeSilentReacquire() {
  if (silentAttempted) return;
  silentAttempted = true;
  if (!isConnectedFlag() || !tokenClient) return; // never connected, or GIS down

  // This promise only ever resolves (never rejects), so nothing downstream can
  // surface an unhandled rejection.
  new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    // Catch BOTH outcomes of the shared GIS callback; reject is swallowed.
    pendingTokenResolvers.push({ resolve: finish, reject: finish });
    // "No callback at all" guard.
    setTimeout(finish, SILENT_TIMEOUT_MS);
    try {
      // prompt: 'none' => GIS renders no UI; if it can't comply it errors via
      // error_callback rather than opening a popup. No user gesture, no popup.
      tokenClient.requestAccessToken({ prompt: 'none' });
    } catch {
      finish(); // synchronous throw (e.g., GIS object vanished mid-flight)
    }
  });
}

/* ------------------------------------------------------------------------ */
/* Internal callbacks                                                       */
/* ------------------------------------------------------------------------ */

async function handleTokenResponse(resp) {
  if (resp.error) {
    handleTokenError(resp);
    return;
  }
  currentToken = {
    access_token: resp.access_token,
    expires_at: Date.now() + (resp.expires_in * 1000) - EXPIRY_BUFFER_MS,
  };
  // Fetch profile only if we don't have it yet (first sign-in).
  if (!currentUser) {
    try {
      currentUser = await fetchUserInfo();
    } catch (e) {
      console.warn('userinfo fetch failed:', e);
    }
    onChangeCb?.({ user: currentUser, signedIn: true });
  }
  flushPending('resolve', currentUser);
}

function handleTokenError(resp) {
  const err = new Error(resp.error || 'oauth_failed');
  err.detail = resp;
  flushPending('reject', err);
}

function flushPending(method, value) {
  const queue = pendingTokenResolvers;
  pendingTokenResolvers = [];
  queue.forEach((p) => p[method](value));
}

async function fetchUserInfo() {
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${currentToken.access_token}` },
  });
  if (!r.ok) throw new Error(`userinfo: ${r.status}`);
  return r.json();
}

/* ------------------------------------------------------------------------ */
/* Read-only state accessors                                                */
/* ------------------------------------------------------------------------ */

export function getUser() {
  return currentUser;
}

export function isSignedIn() {
  return !!currentToken && Date.now() < currentToken.expires_at;
}

/** Whether GIS has loaded and a token client exists (i.e. Connect can proceed). */
export function isGisReady() {
  return !!tokenClient;
}

export function getGrantedScopes() {
  // GIS doesn't expose granted scopes after consent; we assume all requested
  // scopes were granted (incremental consent isn't currently used here). If
  // you want defensive parsing, decode the access_token's scope claim — but
  // access tokens are opaque, so the practical check is to call the API and
  // handle 403 insufficient_scope responses.
  return SCOPES.split(' ');
}
