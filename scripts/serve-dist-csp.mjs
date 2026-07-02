#!/usr/bin/env node
/**
 * serve-dist-csp.mjs — dependency-free preview harness for browser CSP smoke-testing.
 *
 * Serves the built ./dist statically on http://localhost:4173 and replays the SAME
 * security headers the deployed site will send — because it parses them straight out
 * of dist/_headers at startup. dist/_headers is the ONE source of truth: edit the
 * policy there, rebuild, restart this server, and the browser sees the real thing.
 *
 * Why this exists: Cloudflare Pages applies _headers at the edge; `vite preview` does
 * not. Without this you cannot see the CSP actually take effect locally. Point a
 * browser at http://localhost:4173, open DevTools, and any CSP violation (a blocked
 * script/connect/style) shows up in the console exactly as it would in production.
 *
 * Notes:
 *   - Strict-Transport-Security is intentionally NOT sent over this http listener.
 *     Browsers ignore HSTS received over http anyway, and skipping it avoids a stray
 *     policy pinning localhost to https and breaking later http smoke tests.
 *   - connect-src in the policy allows http://localhost:* / http://127.0.0.1:*, so a
 *     real connect to a loopback MCP spine can be exercised from this page.
 *   - SPA fallback: unknown non-file paths serve index.html so client routes resolve.
 *
 * Run (we detach it separately — do NOT expect this to background itself):
 *   node scripts/serve-dist-csp.mjs
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, normalize, extname, sep } from 'node:path';

const PORT = 4173;
const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const HEADERS_FILE = join(ROOT, '_headers');
const INDEX = join(ROOT, 'index.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Parse the `/*` block out of dist/_headers into a plain { Header: value } object.
 * Skips comments/blank lines; collects the indented "Header: value" lines that
 * follow the `/*` path until the next non-indented line or EOF.
 */
async function loadHeaders() {
  let raw;
  try {
    raw = await readFile(HEADERS_FILE, 'utf8');
  } catch {
    console.error(`[serve-dist-csp] no dist/_headers found at ${HEADERS_FILE} — run "vite build" first.`);
    return {};
  }
  const headers = {};
  let inBlock = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed === '/*') inBlock = true;
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue; // tolerate blanks/comments inside
    // A new, non-indented token (another path pattern) ends the block.
    if (!/^\s/.test(line)) break;
    const m = line.match(/^\s+([A-Za-z0-9-]+):\s?(.*)$/);
    if (m) headers[m[1]] = m[2];
  }
  return headers;
}

// Resolve a URL path to a file inside ROOT, or null if it escapes the root.
function resolveInRoot(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const abs = join(ROOT, rel);
  const rootNoSlash = ROOT.replace(/[/\\]$/, '');
  if (abs !== rootNoSlash && !abs.startsWith(rootNoSlash + sep)) return null; // traversal guard
  return abs;
}

const POLICY = await loadHeaders();
if (POLICY['Content-Security-Policy']) {
  console.log('[serve-dist-csp] replaying headers from dist/_headers:');
  for (const k of Object.keys(POLICY)) {
    if (k === 'Strict-Transport-Security') continue;
    console.log(`  ${k}: ${POLICY[k]}`);
  }
}

function applyHeaders(res, contentType) {
  res.setHeader('Content-Type', contentType);
  for (const [k, v] of Object.entries(POLICY)) {
    if (k === 'Strict-Transport-Security') continue; // never over http (see header note)
    res.setHeader(k, v);
  }
}

async function serveFile(res, absPath) {
  const type = MIME[extname(absPath).toLowerCase()] || 'application/octet-stream';
  applyHeaders(res, type);
  res.statusCode = 200;
  createReadStream(absPath)
    .on('error', () => { res.statusCode = 500; res.end('read error'); })
    .pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const abs = resolveInRoot(req.url || '/');
    if (abs === null) { res.statusCode = 403; res.end('forbidden'); return; }

    let target = abs;
    let info = null;
    try { info = await stat(target); } catch { /* miss */ }

    if (info?.isDirectory()) {
      target = join(target, 'index.html');
      try { info = await stat(target); } catch { info = null; }
    }

    if (info?.isFile()) { await serveFile(res, target); return; }

    // SPA fallback: unknown path with no extension -> index.html.
    if (!extname(abs)) { await serveFile(res, INDEX); return; }

    res.statusCode = 404;
    applyHeaders(res, 'text/plain; charset=utf-8');
    res.end('not found');
  } catch (e) {
    res.statusCode = 500;
    res.end('server error');
  }
});

server.listen(PORT, () => {
  console.log(`[serve-dist-csp] serving ${ROOT} at http://localhost:${PORT}`);
  console.log('[serve-dist-csp] open DevTools -> Console to watch for CSP violations. Ctrl+C to stop.');
});
