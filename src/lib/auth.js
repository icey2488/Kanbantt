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
 *   await initAuth(import.meta.env.PUBLIC_GOOGLE_CLIENT_ID, {
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
export async function initAuth(clientId, { onChange } = {}) {
  if (!clientId) throw new Error('initAuth: clientId is required');
  await loadGIS();
  onChangeCb = onChange || null;

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    // The single callback for both interactive and silent token requests.
    callback: handleTokenResponse,
    error_callback: handleTokenError,
  });
  initialized = true;
}

/* ------------------------------------------------------------------------ */
/* Sign-in / sign-out                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Trigger interactive sign-in. Shows Google's account picker + consent screen.
 * Resolves with the user profile, or rejects on user dismissal / error.
 */
export function signIn() {
  if (!initialized) return Promise.reject(new Error('signIn: call initAuth first'));
  return new Promise((resolve, reject) => {
    pendingTokenResolvers.push({ resolve, reject });
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

export function getGrantedScopes() {
  // GIS doesn't expose granted scopes after consent; we assume all requested
  // scopes were granted (incremental consent isn't currently used here). If
  // you want defensive parsing, decode the access_token's scope claim — but
  // access tokens are opaque, so the practical check is to call the API and
  // handle 403 insufficient_scope responses.
  return SCOPES.split(' ');
}
