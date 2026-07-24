#!/usr/bin/env node
/**
 * App-shell render smoke check — headless-Chrome/CDP.
 *
 * Seeds a 6-column board straight into localStorage (bypassing Drive auth,
 * which the app doesn't require — see src/lib/store-instance.js) and asserts,
 * at each viewport:
 *   Board view (all three themes):
 *     (a) every column header's box, and every column's first-card box, sits
 *         fully inside the ACTUAL visual panel (#root — the bordered,
 *         backgrounded element the user sees as "the app surface"), not just
 *         "visible somewhere in the viewport"
 *     (b) every column header sits above its first card's box
 *     (c) the rightmost column is reachable — either it's already inside the
 *         panel/viewport bound, or there's a genuine working scrollbar to it
 *   All four views (board/calendar/gantt/matrix):
 *     (d) no unintended horizontal viewport overflow
 *     (e) no content rendering past the app background container's own box
 *
 * This bug class (header/first-card overlap, right-edge clipping, and later
 * the #root scaffold-width cap letting columns spill past the visual panel
 * while a viewport-relative check stayed green) had no assertion anywhere in
 * the suite before — this script is the standing regression guard for
 * app-shell/board grid/overflow CSS.
 *
 * Usage: node scripts/render-check.mjs --url http://localhost:5183
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const URL_TO_TEST = getArg('url', 'http://localhost:5183');
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
];

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.CHROME_PATH,
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(`No Chrome executable found. Tried: ${CHROME_CANDIDATES.join(', ')}`);
}

/* ------------------------------------------------------------------------ */
/* Seed data — 6 columns (matching COLUMN_ACCENTS in App.jsx), 1+ card each */
/* ------------------------------------------------------------------------ */

const COLUMNS = [
  { id: 'created', label: 'Created', accentKey: 'textDim' },
  { id: 'assigned', label: 'Assigned', accentKey: 'frost' },
  { id: 'doing', label: 'In Progress', accentKey: 'ice' },
  { id: 'review', label: 'Review', accentKey: 'amber' },
  { id: 'delivered', label: 'Delivered', accentKey: 'mint' },
  { id: 'failed', label: 'Failed', accentKey: 'coral' },
];

function rankFor(i) { return String.fromCharCode(97 + i); } // 'a','b','c'...

function seedBlob() {
  const now = '2026-07-24T12:00:00.000Z';
  const actor = { type: 'human', id: 'render-check' };
  const cards = [];
  COLUMNS.forEach((col, ci) => {
    // 2 cards per column; one title deliberately long/nowrap-hostile, matching
    // the operator repro (a wide chip/title blowing past a bare `1fr` track).
    for (let i = 0; i < 2; i++) {
      cards.push({
        id: `card-${col.id}-${i}`,
        column_id: col.id,
        order: rankFor(i),
        version: 1,
        deleted_at: null,
        created_at: now, updated_at: now,
        created_by: actor, updated_by: actor,
        seq: ci * 2 + i + 1,
        title: i === 0
          ? `${col.label} render-check card with a deliberately long nowrap title`
          : `${col.label} card ${i}`,
        priority: 'med',
        tags: [],
      });
    }
  });
  return {
    schema_version: 1,
    seq: cards.length,
    cards,
    tags: [],
    columns: COLUMNS.map((c, i) => ({ ...c, rank: rankFor(i) })),
    settings: {},
  };
}

const THEMES = ['dark', 'light', 'mist'];
const VIEWS = ['board', 'calendar', 'gantt', 'matrix'];

function seedScriptFor(view, theme) {
  return `
(() => {
  try {
    localStorage.setItem('kanbantt_data_v1', ${JSON.stringify(JSON.stringify(seedBlob()))});
    localStorage.setItem('kanbantt:view:v1', JSON.stringify(${JSON.stringify(view)}));
    localStorage.setItem('kanbantt:theme:v1', JSON.stringify(${JSON.stringify(theme)}));
  } catch (e) { console.error('seed failed', e); }
})();
`;
}

/* ------------------------------------------------------------------------ */
/* In-page assertion — returns a structured report, no throws               */
/* ------------------------------------------------------------------------ */

// Runs on every view (board included): computes doc-level horizontal-overflow
// and app-background-container metrics, WITHOUT judging them — measurement
// only, no failures.push here. Kept as a single source string so both
// ASSERTION_SRC (board) and BASIC_ASSERTION_SRC (the other three views)
// share the identical measurement.
const OVERFLOW_SNIPPET = `
  const scrollingEl = document.scrollingElement || document.documentElement;
  const docOverflow = { scrollWidth: scrollingEl.scrollWidth, clientWidth: scrollingEl.clientWidth };
  const bgDiv = panel ? panel.firstElementChild : null;
  let bgRect = null;
  if (bgDiv) {
    bgRect = rectOf(bgDiv.getBoundingClientRect());
  } else {
    failures.push('app background container (#root > firstElementChild) not found');
  }
`;

// Turns the OVERFLOW_SNIPPET measurements into a hard failure. Applied
// UNCONDITIONALLY only where there is no legitimate reason for the document
// to be wider than the viewport (Calendar/Timeline/Matrix, and BASIC_ASSERTION_SRC
// in general). The Board view deliberately excludes this: its grid comment
// (see the column-track definition in App.jsx) documents that once
// column-count * 220px exceeds the viewport, the grid intentionally overflows
// onto the WINDOW's native horizontal scrollbar rather than clipping — the
// board's own beforeScroll/afterScroll reachability check (further down in
// ASSERTION_SRC) already judges that case correctly (fails only if the last
// column is NOT reachable by scrolling), so re-flagging the same measurement
// here as an unconditional failure would flag documented, reachable-by-design
// behavior as a bug.
const ENFORCE_OVERFLOW_SNIPPET = `
  if (docOverflow.scrollWidth > docOverflow.clientWidth + EPS) {
    failures.push(\`unintended horizontal viewport overflow: document.scrollWidth=\${docOverflow.scrollWidth} > clientWidth=\${docOverflow.clientWidth}\`);
  }
  if (bgDiv) {
    const bgEscapes = bgRect.right > window.innerWidth + EPS || bgRect.left < -EPS || bgDiv.scrollWidth > bgDiv.clientWidth + EPS;
    if (bgEscapes) {
      failures.push(\`content escapes the app background container: bgRect.right=\${bgRect.right.toFixed(1)} innerWidth=\${window.innerWidth} bg.scrollWidth=\${bgDiv.scrollWidth} bg.clientWidth=\${bgDiv.clientWidth}\`);
    }
  }
`;

const ASSERTION_SRC = `
(() => {
  const EPS = 2; // px slack for scrollbar/rounding
  const LABELS = ${JSON.stringify(COLUMNS.map((c) => c.label))};

  function findLabelSpan(label) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim() === label) return node.parentElement;
    }
    return null;
  }

  function closestSticky(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (getComputedStyle(cur).position === 'sticky') return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // Only a box whose OWN computed overflow-x is auto/scroll is a real scroll
  // container — scrollWidth > clientWidth alone just means content overflows
  // its border box; if overflow-x is 'visible' that content simply paints past
  // the edge (no clip, and .scrollLeft on it is a silent no-op) and the real
  // scrollable surface is further up, ultimately the document/window itself.
  function findScrollAncestor(el) {
    let cur = el ? el.parentElement : null;
    while (cur && cur !== document.documentElement) {
      const cs = getComputedStyle(cur);
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && cur.scrollWidth > cur.clientWidth + EPS) {
        return cur;
      }
      cur = cur.parentElement;
    }
    const root = document.scrollingElement || document.documentElement;
    return root.scrollWidth > root.clientWidth + EPS ? root : null;
  }

  function rectOf(r) { return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }

  const failures = [];
  const columns = [];
  // The ACTUAL visual panel is #root itself: it's the element carrying the
  // bordered/backgrounded "app surface" look (border-inline + matching
  // background, see src/index.css), not some incidental DOM ancestor of the
  // column wrappers. A prior version of this script used
  // "column-header's-parent's-parent" as a stand-in for "the panel", which
  // just happened to be the grid container (no background/border of its own)
  // — that let cards render past the real visual panel edge while the check
  // stayed green, because it wasn't measuring against anything visible.
  const panel = document.getElementById('root');
  if (!panel) failures.push('visual panel (#root) not found');
  const panelRect = panel ? rectOf(panel.getBoundingClientRect()) : null;
  const panelScroll = panel ? { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth } : null;
  ${OVERFLOW_SNIPPET}

  for (const label of LABELS) {
    const span = findLabelSpan(label);
    if (!span) { failures.push(\`column header text not found: \${label}\`); continue; }
    const header = closestSticky(span);
    if (!header) { failures.push(\`no sticky ancestor found for header: \${label}\`); continue; }
    const cardsList = header.nextElementSibling;
    const firstCard = cardsList ? cardsList.firstElementChild : null;
    if (panel && !panel.contains(header)) failures.push(\`\${label}: header is not inside the visual panel (#root)\`);

    const headerRect = header.getBoundingClientRect();
    const cardRect = firstCard ? firstCard.getBoundingClientRect() : null;
    const headerAboveCard = cardRect ? (headerRect.bottom <= cardRect.top + EPS) : null;
    if (cardRect && !headerAboveCard) {
      failures.push(\`\${label}: header (bottom=\${headerRect.bottom.toFixed(1)}) overlaps/renders below first card (top=\${cardRect.top.toFixed(1)})\`);
    }

    // Containment against the real visual panel box — checked for EVERY
    // column, unconditionally (not gated on the panel's CSS overflow-x,
    // which is 'visible' by design: the board scrolls on the WINDOW, not a
    // clipping ancestor — see the grid container's own comment in App.jsx).
    // A column rendering past the panel's border/background is a visible bug
    // regardless of whether CSS happens to clip it.
    let insidePanel = null;
    if (panel && panelRect) {
      const rects = [headerRect, cardRect].filter(Boolean);
      insidePanel = rects.every((r) => r.left >= panelRect.left - EPS && r.right <= panelRect.right + EPS);
      if (!insidePanel) {
        failures.push(\`\${label}: box (header right=\${headerRect.right.toFixed(1)}\${cardRect ? \`, card right=\${cardRect.right.toFixed(1)}\` : ''}) sits outside the visual panel box (panel left=\${panelRect.left.toFixed(1)}, right=\${panelRect.right.toFixed(1)})\`);
      }
    }

    columns.push({ label, headerRect: rectOf(headerRect), cardRect: cardRect && rectOf(cardRect), headerAboveCard, insidePanel });
  }

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const last = columns[columns.length - 1];
  let beforeScroll = null, afterScroll = null, scrollContainerTag = null;

  if (last) {
    const rightBound = Math.min(viewport.width, panelRect ? panelRect.right : Infinity);
    beforeScroll = {
      headerRight: last.headerRect.right,
      fullyVisible: last.headerRect.right <= rightBound + EPS,
    };

    if (!beforeScroll.fullyVisible) {
      const lastSpan = findLabelSpan(last.label);
      const lastHeader = closestSticky(lastSpan);
      const scrollEl = findScrollAncestor(lastHeader);
      if (scrollEl) {
        scrollContainerTag = scrollEl.tagName + (scrollEl.className ? '.' + String(scrollEl.className).split(' ')[0] : '');
        scrollEl.scrollLeft = scrollEl.scrollWidth;
        const span2 = findLabelSpan(last.label);
        const header2 = closestSticky(span2);
        const cardsList2 = header2.nextElementSibling;
        const card2 = cardsList2 ? cardsList2.firstElementChild : null;
        const hRect = header2.getBoundingClientRect();
        const cRect = card2 ? card2.getBoundingClientRect() : null;
        afterScroll = {
          headerRight: hRect.right,
          headerFullyVisible: hRect.right <= viewport.width + EPS && hRect.left >= -EPS,
          cardRight: cRect ? cRect.right : null,
          cardFullyVisible: cRect ? (cRect.right <= viewport.width + EPS && cRect.left >= -EPS) : null,
        };
        if (!afterScroll.headerFullyVisible) failures.push(\`\${last.label}: header still off-screen after scrolling scrollLeft to max (scrollWidth=\${scrollEl.scrollWidth}, clientWidth=\${scrollEl.clientWidth})\`);
        if (cRect && !afterScroll.cardFullyVisible) failures.push(\`\${last.label}: first card still clipped after scrolling (right=\${cRect.right.toFixed(1)}, viewportWidth=\${viewport.width})\`);
      } else {
        failures.push(\`\${last.label}: header off-screen (right=\${last.headerRect.right.toFixed(1)}, viewportWidth=\${viewport.width}) and NO scrollable ancestor found to reach it\`);
      }
    }
  }

  return {
    viewport, panelRect, panelScroll, docOverflow, bgRect, columns, beforeScroll, afterScroll, scrollContainerTag,
    pass: failures.length === 0,
    failures,
  };
})();
`;

const BASIC_ASSERTION_SRC = `
(() => {
  const EPS = 2;
  function rectOf(r) { return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }
  const failures = [];
  const panel = document.getElementById('root');
  if (!panel) failures.push('visual panel (#root) not found');
  const panelRect = panel ? rectOf(panel.getBoundingClientRect()) : null;
  ${OVERFLOW_SNIPPET}
  ${ENFORCE_OVERFLOW_SNIPPET}
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  return { viewport, panelRect, docOverflow, bgRect, pass: failures.length === 0, failures };
})();
`;

/* ------------------------------------------------------------------------ */
/* Minimal CDP client over the browser endpoint (flattened sessions)        */
/* ------------------------------------------------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map(); // `${sessionId||''}:${method}` -> [resolve,...]
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const key = `${msg.sessionId || ''}:${msg.method}`;
        const waiters = this.eventListeners.get(key);
        if (waiters && waiters.length) waiters.shift()(msg.params);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  waitForEvent(method, sessionId, timeoutMs = 15000) {
    const key = `${sessionId || ''}:${method}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      const wrapped = (params) => { clearTimeout(timer); resolve(params); };
      const arr = this.eventListeners.get(key) || [];
      arr.push(wrapped);
      this.eventListeners.set(key, arr);
    });
  }
}

async function waitForDevToolsActivePort(userDataDir, timeoutMs = 15000) {
  const file = join(userDataDir, 'DevToolsActivePort');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) {
      const content = readFileSync(file, 'utf8').split('\n');
      const port = content[0].trim();
      const path = content[1] ? content[1].trim() : '';
      if (port) return { port, path };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('DevToolsActivePort never appeared');
}

// A fresh Chrome process per viewport, sized via --window-size at launch.
// CDP's Emulation.setDeviceMetricsOverride alone leaves the underlying
// headless render surface at whatever size the browser started with (it only
// patches window.innerWidth/innerHeight for script reads and media queries) —
// --window-size is what actually resizes the render surface CSS layout runs
// against, so a per-viewport process (rather than one process reused across
// viewports) is what makes the two runs genuinely independent.
async function runVariant(chromePath, vp, { view, theme, assertionSrc }) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'render-check-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${vp.width},${vp.height}`,
    '--no-first-run',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const { port, path } = await waitForDevToolsActivePort(userDataDir);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const cdp = new CDP(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: seedScriptFor(view, theme) }, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false,
    }, sessionId);

    const loadPromise = cdp.waitForEvent('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url: URL_TO_TEST }, sessionId);
    await loadPromise;
    // Let React mount + layout settle.
    await new Promise((r) => setTimeout(r, 500));

    const evalResult = await cdp.send('Runtime.evaluate', {
      expression: assertionSrc,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);

    if (evalResult.exceptionDetails) {
      throw new Error(`page assertion threw: ${JSON.stringify(evalResult.exceptionDetails)}`);
    }
    const report = evalResult.result.value;
    report.viewportLabel = `${vp.width}x${vp.height}`;
    report.view = view;
    report.theme = theme;
    return report;
  } finally {
    chrome.kill();
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

async function main() {
  const chromePath = findChrome();
  const results = [];
  let overallPass = true;

  // Board view: full containment/header assertion, across every viewport x
  // theme combo — this is what proves (a) column boxes stay inside the real
  // visual panel and (c) the panel's background spans all six columns under
  // every theme, not just the default.
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const report = await runVariant(chromePath, vp, { view: 'board', theme, assertionSrc: ASSERTION_SRC });
      results.push(report);
      if (!report.pass) overallPass = false;
    }
  }

  // Calendar / Timeline / Matrix: no six-column header structure to walk, so
  // just the shared overflow/escape assertion, at both viewports (dark theme
  // — theme doesn't affect layout width, only colors).
  for (const vp of VIEWPORTS) {
    for (const view of VIEWS.filter((v) => v !== 'board')) {
      const report = await runVariant(chromePath, vp, { view, theme: 'dark', assertionSrc: BASIC_ASSERTION_SRC });
      results.push(report);
      if (!report.pass) overallPass = false;
    }
  }

  for (const r of results) {
    console.log(`\n=== ${r.view}/${r.theme} @ ${r.viewportLabel} — ${r.pass ? 'PASS' : 'FAIL'} ===`);
    if (r.columns) {
      for (const col of r.columns) {
        const status = col.headerAboveCard === false || col.insidePanel === false ? 'FAIL' : 'ok  ';
        console.log(`  ${status} ${col.label}: header.bottom=${col.headerRect.bottom.toFixed(1)} firstCard.top=${col.cardRect ? col.cardRect.top.toFixed(1) : 'n/a'} insidePanel=${col.insidePanel}`);
      }
    }
    if (r.panelRect) {
      console.log(`  panelRect left=${r.panelRect.left.toFixed(1)} right=${r.panelRect.right.toFixed(1)}${r.panelScroll ? ` panel.scrollWidth=${r.panelScroll.scrollWidth} panel.clientWidth=${r.panelScroll.clientWidth}` : ''}`);
    }
    if (r.docOverflow) {
      console.log(`  doc.scrollWidth=${r.docOverflow.scrollWidth} doc.clientWidth=${r.docOverflow.clientWidth}`);
    }
    if (r.beforeScroll) {
      console.log(`  rightmost header right=${r.beforeScroll.headerRight.toFixed(1)} viewportWidth=${r.viewport.width} fullyVisibleAtRest=${r.beforeScroll.fullyVisible}`);
    }
    if (r.afterScroll) {
      console.log(`  after scroll (${r.scrollContainerTag}): headerFullyVisible=${r.afterScroll.headerFullyVisible} cardFullyVisible=${r.afterScroll.cardFullyVisible}`);
    }
    if (r.failures.length) {
      console.log('  Failures:');
      for (const f of r.failures) console.log(`    - ${f}`);
    }
  }
  console.log(`\nOVERALL: ${overallPass ? 'PASS' : 'FAIL'}`);
  process.exit(overallPass ? 0 : 1);
}

main().catch((err) => {
  console.error('render-check crashed:', err);
  process.exit(2);
});
