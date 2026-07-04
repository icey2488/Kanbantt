/**
 * spine-config tests — readKanbanttConfig migration + config-shape contract for
 * the remember-token opt-in (spec Auth v1).
 *
 * Run:  node --test src/lib/spine-config.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readKanbanttConfig } from './spine-config.js';

/**
 * Run `fn` with globalThis.localStorage pointing at a minimal shim that serves
 * `configObj` from the kanbantt_config key. Restores (or removes) localStorage
 * afterwards so tests are isolated.
 */
function withStorage(configObj, fn) {
  const prev = globalThis.localStorage;
  const store = {};
  if (configObj !== null) store['kanbantt_config'] = JSON.stringify(configObj);
  globalThis.localStorage = { getItem: (k) => store[k] ?? null };
  try {
    return fn();
  } finally {
    if (prev === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prev;
  }
}

/* ================================================================== */
/* Legacy migration (spec Auth v1)                                      */
/* ================================================================== */

test('legacy config (auth_token, no remember_token) → migrated to remember_token: true', () => {
  const cfg = withStorage(
    { mcp: { url: 'http://x/mcp', auth_token: 'tok' } },
    readKanbanttConfig,
  );
  assert.equal(cfg.mcp.remember_token, true, 'legacy flag should be migrated to true');
  assert.equal(cfg.mcp.auth_token, 'tok', 'token is preserved');
});

test('legacy config with auth_token and NO url → migration still fires (flag is about the token)', () => {
  const cfg = withStorage(
    { mcp: { auth_token: 'tok' } },
    readKanbanttConfig,
  );
  assert.equal(cfg.mcp.remember_token, true);
});

/* ================================================================== */
/* Explicit remember_token: true                                        */
/* ================================================================== */

test('remember_token: true with auth_token → both returned unchanged', () => {
  const cfg = withStorage(
    { mcp: { url: 'http://x/mcp', auth_token: 'tok', remember_token: true } },
    readKanbanttConfig,
  );
  assert.equal(cfg.mcp.remember_token, true);
  assert.equal(cfg.mcp.auth_token, 'tok');
});

/* ================================================================== */
/* Default / opt-out paths (spec §Configuration: auth_token present    */
/* ONLY if remember_token)                                             */
/* ================================================================== */

test('remember_token: false → no auth_token in returned config', () => {
  const cfg = withStorage(
    { mcp: { url: 'http://x/mcp', remember_token: false } },
    readKanbanttConfig,
  );
  assert.equal(cfg.mcp.remember_token, false);
  assert.equal(cfg.mcp.auth_token, undefined, 'auth_token should be absent');
});

test('no stored config → mcp defaults: no remember_token, no auth_token', () => {
  const cfg = withStorage(null, readKanbanttConfig);
  assert.equal(cfg.mcp.remember_token, undefined);
  assert.equal(cfg.mcp.auth_token, undefined);
});

/* ================================================================== */
/* connect-config shape contract (simulates handleSpineConnect logic)  */
/* ================================================================== */

/**
 * Build the config object that handleSpineConnect would write to localStorage.
 * This is the pure logic extracted from the App handler — tests here cover:
 *   - default connect (rememberToken = false): no auth_token in config
 *   - opt-in connect (rememberToken = true): auth_token present
 *   - unchecking: previously-remembered token is removed on save
 */
function buildSpineConnectConfig(currentCfg, url, token, rememberToken) {
  const trimmedUrl = (url || '').trim();
  const trimmedToken = (token || '').trim();
  const next = {
    ...currentCfg,
    data_source: currentCfg.data_source === 'local' ? 'auto' : (currentCfg.data_source || 'auto'),
    mcp: { ...(currentCfg.mcp || {}), url: trimmedUrl, remember_token: !!rememberToken },
  };
  if (rememberToken && trimmedToken) {
    next.mcp.auth_token = trimmedToken;
  } else {
    delete next.mcp.auth_token;
  }
  return next;
}

test('default connect (rememberToken: false) persists config WITHOUT auth_token', () => {
  const cfg = buildSpineConnectConfig(
    { data_source: 'auto', mcp: {} },
    'http://x/mcp', 'secret', false,
  );
  assert.equal(cfg.mcp.remember_token, false);
  assert.equal('auth_token' in cfg.mcp, false, 'auth_token must be absent for remember_token: false');
});

test('opt-in connect (rememberToken: true) persists config WITH auth_token', () => {
  const cfg = buildSpineConnectConfig(
    { data_source: 'auto', mcp: {} },
    'http://x/mcp', 'secret', true,
  );
  assert.equal(cfg.mcp.remember_token, true);
  assert.equal(cfg.mcp.auth_token, 'secret');
});

test('unchecking remember removes the persisted auth_token', () => {
  // Simulate: user had remember_token: true with a stored token, then unchecks.
  const prevCfg = { data_source: 'auto', mcp: { url: 'http://x/mcp', auth_token: 'old', remember_token: true } };
  const cfg = buildSpineConnectConfig(prevCfg, 'http://x/mcp', 'old', false /* unchecked */);
  assert.equal(cfg.mcp.remember_token, false);
  assert.equal('auth_token' in cfg.mcp, false, 'persisted token must be removed on uncheck');
});

test('empty token with rememberToken: true → no auth_token (blank field is not stored)', () => {
  const cfg = buildSpineConnectConfig(
    { data_source: 'auto', mcp: {} },
    'http://x/mcp', '', true,
  );
  assert.equal(cfg.mcp.remember_token, true);
  assert.equal('auth_token' in cfg.mcp, false, 'blank token is not stored even with opt-in');
});
