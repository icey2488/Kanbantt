import { useState, useEffect, useContext, createContext, useMemo, useRef, useSyncExternalStore, lazy, Suspense } from 'react';
import {
  LayoutGrid,
  CalendarDays,
  GanttChartSquare,
  Grid2x2,
  Plus,
  X,
  LogOut,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Snowflake,
  Clock,
  Check,
  Search,
  ListChecks,
  AlertTriangle,
  Hash,
  Zap,
  Flag,
  ArrowDown,
  Settings,
  Cloud,
  RefreshCw,
  Palette,
} from 'lucide-react';
import { initAuth, signIn, signOut, isGisReady } from './lib/auth.js';
import { driveSync } from './lib/sync-instance.js';
import { store, bootError, subscribe, getSnapshot, readLegacyDump, STORAGE_KEY } from './lib/store-instance.js';
import { orderBetween, compareCards } from './lib/card-store.js';
import { readKanbanttConfig, hasMcpTarget } from './lib/spine-config.js';

/* global __APP_VERSION__, __GIT_COMMIT__ */
// Injected by Vite's define() as string literals (see vite.config.js). In dev the
// commit is "dev" -> "+dev"; a real build stamps the short hash (or "nogit").
const BUILD_STAMP = `Kanbantt · v${__APP_VERSION__}+${__GIT_COMMIT__}`;

/* ============================================================
   THEMES
   ============================================================ */
const THEMES = {
  dark: {
    name: 'Dark', isLight: false,
    bg: '#070b14', bgGrain: '#0a101c',
    surface: '#111827', surfaceHi: '#161f30', surfaceDrop: '#1e2a3f',
    border: '#1f2a3d', borderHi: '#2a3651',
    text: '#e4e9f2', textMuted: '#8b95a8', textDim: '#5a6478',
    ice: '#7dd3fc', iceDeep: '#0ea5e9',
    frost: '#a5b4fc', amber: '#fbbf24', coral: '#fb7185', mint: '#6ee7b7',
    eventText: '#a5b4fc',
    shadow: '0 8px 24px -8px rgba(0,0,0,0.5)',
    modalBackdrop: 'rgba(4, 6, 12, 0.7)',
  },
  light: {
    name: 'Light', isLight: true,
    bg: '#f5f5f4', bgGrain: '#fafaf9',
    surface: '#ffffff', surfaceHi: '#f9fafb', surfaceDrop: '#eef2f7',
    border: '#e5e7eb', borderHi: '#cbd5e1',
    // textDim darkened #94a3b8 -> #6b7687 so card date/footer/priority text hits
    // 4.60:1 on the #ffffff card (was 2.56:1). textMuted is 4.76:1 (body, unchanged);
    // textDim stays below it to keep body more prominent than metadata.
    text: '#0f172a', textMuted: '#64748b', textDim: '#6b7687',
    ice: '#0369a1', iceDeep: '#075985',
    frost: '#6d28d9', amber: '#b45309', coral: '#dc2626', mint: '#047857',
    eventText: '#6d28d9',
    shadow: '0 4px 16px -4px rgba(15, 23, 42, 0.1)',
    modalBackdrop: 'rgba(15, 23, 42, 0.4)',
  },
  mist: {
    name: 'Mist', isLight: true,
    bg: '#aab7c8', bgGrain: '#b4c0cf',
    surface: '#cdd5e0', surfaceHi: '#e0e5ec', surfaceDrop: '#b8c3d2',
    border: '#7a849a', borderHi: '#5b6679',
    text: '#1a1f2e', textMuted: '#3d4659', textDim: '#5b6679',
    ice: '#1e40af', iceDeep: '#1e3a8a',
    frost: '#5b21b6', amber: '#92400e', coral: '#991b1b', mint: '#166534',
    eventText: '#5b21b6',
    shadow: '0 6px 20px -6px rgba(26, 31, 46, 0.25)',
    modalBackdrop: 'rgba(26, 31, 46, 0.5)',
  },
};

const F = {
  display: '"Fraunces", "Iowan Old Style", Georgia, serif',
  body: '"Geist", -apple-system, BlinkMacSystemFont, sans-serif',
  mono: '"Geist Mono", "JetBrains Mono", ui-monospace, monospace',
};

const ThemeContext = createContext(THEMES.dark);
const useTheme = () => useContext(ThemeContext);

/* ============================================================
   CONSTANTS
   ============================================================ */

const COLUMN_ACCENTS = ['textDim', 'frost', 'ice', 'amber', 'mint', 'coral'];

const PRIORITY = {
  low: { label: 'Low', key: 'textDim' },
  med: { label: 'Med', key: 'frost' },
  high: { label: 'High', key: 'coral' },
};

const QUADRANT_DEFS = {
  avoid: { label: 'Avoid', tagline: 'high cost, low payoff', accentKey: 'coral', tintAlpha: '14', Icon: X, effort: 'high', impact: 'low' },
  plan: { label: 'Plan', tagline: 'strategic bets', accentKey: 'ice', tintAlpha: '0e', Icon: Flag, effort: 'high', impact: 'high' },
  deprioritize: { label: 'Deprioritize', tagline: 'parking lot', accentKey: 'textDim', tintAlpha: '1a', Icon: ArrowDown, effort: 'low', impact: 'low' },
  do: { label: 'Do', tagline: 'quick wins', accentKey: 'mint', tintAlpha: '14', Icon: Zap, effort: 'low', impact: 'high' },
};

const getImpact = (task) => task.impact ?? (task.priority === 'low' ? 'low' : 'high');
const getQuadrant = (task) => {
  if (task.effort === undefined) return 'unsorted';
  const impact = getImpact(task);
  if (impact === 'high' && task.effort === 'high') return 'plan';
  if (impact === 'high' && task.effort === 'low') return 'do';
  if (impact === 'low' && task.effort === 'high') return 'avoid';
  return 'deprioritize';
};

const TAG_PALETTE = {
  slate: '#64748b',
  blue: '#3b82f6',
  cyan: '#06b6d4',
  green: '#10b981',
  amber: '#f59e0b',
  orange: '#f97316',
  red: '#ef4444',
  pink: '#ec4899',
  purple: '#a855f7',
};
const TAG_COLOR_CYCLE = ['blue', 'green', 'red', 'purple', 'amber', 'cyan', 'pink', 'orange', 'slate'];
// Palette rows for the Settings tag picker: { key, hex } over the opaque
// TAG_PALETTE hues. Column accents build the same shape per-render from the
// theme (their hex is C[accentKey], so it can't be precomputed here).
const TAG_SWATCHES = Object.entries(TAG_PALETTE).map(([key, hex]) => ({ key, hex }));

// Opaque per-hue chips for EVERY theme. Translucent tints (`${hue}22`) make the
// text/background ratio undefined — it depends on whatever renders behind the
// chip. Instead each chip background is the hue composited at 13.3% (alpha 0x22,
// matching the old tint) over that theme's card surface, baked to an opaque hex.
// Chip text is the SAME hue with only its HSL lightness shifted — lightened on
// Dark (dark bg), darkened on Light/Mist (pale bg) — until it clears >=4.5:1
// against its own opaque background. Computed, not eyeballed; worst pair per
// theme: Dark slate 4.60:1, Light pink 4.60:1 (amber/"v1" 4.64:1), Mist orange
// 4.62:1. The tag hues themselves (TAG_PALETTE, used for swatches) are unchanged.
const CHIP_COLORS = {
  Dark: {
    slate: { bg: '#1c2434', text: '#7e8da2' },
    blue: { bg: '#172643', text: '#4d8df7' },
    cyan: { bg: '#102d3e', text: '#06b6d4' },
    green: { bg: '#112d33', text: '#10b981' },
    amber: { bg: '#2f2a23', text: '#f59e0b' },
    orange: { bg: '#302425', text: '#f97316' },
    red: { bg: '#2f1e2b', text: '#f15757' },
    pink: { bg: '#2e1e36', text: '#ed519e' },
    purple: { bg: '#252043', text: '#b36af8' },
  },
  Light: {
    slate: { bg: '#eaecf0', text: '#5b6a7f' },
    blue: { bg: '#e5eefe', text: '#0b60eb' },
    cyan: { bg: '#def5f9', text: '#04778b' },
    green: { bg: '#dff6ee', text: '#0b7b56' },
    amber: { bg: '#fef2de', text: '#986206' },
    orange: { bg: '#feece0', text: '#b34c05' },
    red: { bg: '#fde6e6', text: '#d01212' },
    pink: { bg: '#fce7f1', text: '#cb156f' },
    purple: { bg: '#f3e8fe', text: '#9128f5' },
  },
  Mist: {
    slate: { bg: '#bfc8d5', text: '#475263' },
    blue: { bg: '#bacae3', text: '#255199' },
    cyan: { bg: '#b2d1de', text: '#035d6c' },
    green: { bg: '#b4d1d3', text: '#086043' },
    amber: { bg: '#d2cec4', text: '#784d05' },
    orange: { bg: '#d3c8c5', text: '#893f0c' },
    red: { bg: '#d2c2cb', text: '#942a2a' },
    pink: { bg: '#d1c2d7', text: '#8e2b5c' },
    purple: { bg: '#c8c4e3', text: '#6c369e' },
  },
};

/* ============================================================
   HELPERS
   ============================================================ */
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const isOverdue = (task) => {
  return startOfDay(new Date(task.dueDate)) < startOfDay(new Date()) && task.status !== 'done';
};

/* ============================================================
   MOCK GOOGLE CALENDAR EVENTS
   ============================================================ */
function generateMockEvents() {
  const t = startOfDay(new Date());
  const events = [];
  for (let i = -14; i < 14; i++) {
    const d = addDays(t, i);
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) {
      events.push({ id: `e-standup-${i}`, title: 'Team standup', date: iso(d), time: '9:30' });
    }
  }
  const oneOffs = [
    { offset: -5, title: 'Dentist', time: '14:00' },
    { offset: -2, title: 'Lunch with M.', time: '12:30' },
    { offset: 1, title: 'Tax planning call', time: '15:00' },
    { offset: 3, title: 'Yoga class', time: '18:00' },
    { offset: 6, title: '1:1 with manager', time: '10:00' },
    { offset: 9, title: 'Quarterly review', time: '13:00' },
    { offset: 12, title: 'Friend visiting', time: 'all-day' },
    { offset: 14, title: 'Conference talk', time: '11:00' },
  ];
  oneOffs.forEach((e, idx) => {
    events.push({ id: `e-one-${idx}`, title: e.title, date: iso(addDays(t, e.offset)), time: e.time });
  });
  return events;
}
const MOCK_EVENTS = generateMockEvents();

/* ============================================================
   STORAGE
   ------------------------------------------------------------
   Board data (cards, tags, columns) lives entirely in card-store.js — the only
   legal path. The legacy board keys (kanbantt:tasks/columns/tags) are owned and
   migrated there; App never touches them. Only device-local keys remain here:
   the theme, and a one-time purge of the retired session key.
   ============================================================ */
// Retired: auth.js owns session state via in-memory tokens + silent refresh, so
// the session is never persisted. Kept only to purge the stale key on mount.
const K_SESSION = 'kanbantt:session:v1';
const K_THEME = 'kanbantt:theme:v1';
// Drive-sync enabled toggle — device-local config (its own key, NOT in the blob),
// same pattern as theme and the google-connected flag. Defaults on when signed in.
const K_SYNC = 'kanbantt:sync-enabled:v1';

const safeGet = async (key, fallback) => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
};
const safeSet = async (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
};
const safeDelete = async (key) => {
  try { localStorage.removeItem(key); } catch {}
};

/* ============================================================
   STORE ADAPTER — cards <-> the task shape the views already speak
   ============================================================ */
// Views read `task.status` (the column). Cards use `column_id`. Alias at the
// boundary so no visual component has to change.
const cardToTask = (card) => ({ ...card, status: card.column_id });

// Stable empty-tags reference for the live-spine board (spine Tasks carry no
// board tags); a fresh [] each render would needlessly bust the filter memo.
const NO_TAGS = [];
// Shown when a board edit is attempted against the read-only live-spine mirror.
const READONLY_MSG = 'Live spine view is read-only';

// Content fields the edit modal can change. `status` is excluded — a column
// change is a move(), not an update() (update never repositions).
const EDITABLE_FIELDS = ['title', 'description', 'priority', 'tags', 'checklist', 'startDate', 'dueDate'];

// Minimal, field-scoped patch: only the editable fields whose value actually
// changed between the current card and the edited draft. Never a whole card.
function diffPatch(current, draft) {
  const patch = {};
  for (const f of EDITABLE_FIELDS) {
    if (JSON.stringify(current?.[f]) !== JSON.stringify(draft?.[f])) patch[f] = draft[f];
  }
  return patch;
}

// Live cards in a column, sorted by the canonical order, optionally excluding a
// card (e.g. the one being dragged). Reads straight from the store snapshot.
function liveColumnCards(snapshot, columnId, excludeId) {
  return snapshot.cards
    .filter((c) => c.column_id === columnId && !c.deleted_at && c.id !== excludeId)
    .sort(compareCards);
}

/* ============================================================
   FONTS
   ============================================================ */
function useFonts() {
  useEffect(() => {
    if (document.getElementById('kanbantt-fonts')) return;
    const link = document.createElement('link');
    link.id = 'kanbantt-fonts';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,400&family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap';
    document.head.appendChild(link);
  }, []);
}

/* ============================================================
   MARKDOWN RENDERER (minimal: **bold** *italic* `code` [link](url) - lists)
   ============================================================ */
function renderInline(text, C) {
  const out = [];
  let i = 0;
  let buf = '';
  let key = 0;
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };

  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if ((m = rest.match(/^\*\*([^*]+)\*\*/))) {
      flush();
      out.push(<strong key={`b-${key++}`}>{m[1]}</strong>);
      i += m[0].length;
    } else if ((m = rest.match(/^`([^`]+)`/))) {
      flush();
      out.push(
        <code key={`c-${key++}`} style={{
          fontFamily: F.mono, fontSize: '0.88em',
          padding: '1px 5px', borderRadius: 3,
          background: C.surfaceHi, border: `1px solid ${C.border}`,
        }}>{m[1]}</code>
      );
      i += m[0].length;
    } else if ((m = rest.match(/^\[([^\]]+)\]\(([^)]+)\)/))) {
      flush();
      out.push(
        <a key={`a-${key++}`} href={m[2]} target="_blank" rel="noopener noreferrer"
           style={{ color: C.ice, textDecoration: 'underline' }}>{m[1]}</a>
      );
      i += m[0].length;
    } else if ((m = rest.match(/^\*([^*\n]+)\*/))) {
      flush();
      out.push(<em key={`i-${key++}`}>{m[1]}</em>);
      i += m[0].length;
    } else {
      buf += text[i];
      i++;
    }
  }
  flush();
  return out;
}

function Markdown({ text, dim = false }) {
  const C = useTheme();
  if (!text) return null;
  const lines = text.split('\n');
  const elements = [];
  let bulletBuf = [];
  const color = dim ? C.textMuted : C.text;

  const flushBullets = () => {
    if (bulletBuf.length) {
      elements.push(
        <ul key={`ul-${elements.length}`} style={{
          margin: '4px 0 6px',
          paddingLeft: 18,
          color,
        }}>
          {bulletBuf.map((line, i) => (
            <li key={i} style={{ marginBottom: 2, lineHeight: 1.5 }}>
              {renderInline(line, C)}
            </li>
          ))}
        </ul>
      );
      bulletBuf = [];
    }
  };

  lines.forEach((line, i) => {
    const m = line.match(/^[-*]\s+(.*)/);
    if (m) {
      bulletBuf.push(m[1]);
    } else if (line.trim() === '') {
      flushBullets();
      elements.push(<div key={`sp-${i}`} style={{ height: 4 }} />);
    } else {
      flushBullets();
      elements.push(
        <div key={`p-${i}`} style={{ margin: 0, lineHeight: 1.5, color }}>
          {renderInline(line, C)}
        </div>
      );
    }
  });
  flushBullets();
  return <>{elements}</>;
}

/* ============================================================
   TAG CHIP
   ============================================================ */
function TagChip({ tag, size = 'sm', active, onClick, dimmed }) {
  const C = useTheme();
  const isInteractive = !!onClick;
  const isSel = active !== false;

  const padding = size === 'sm' ? '2px 7px' : '5px 10px';
  const fontSize = size === 'sm' ? 10 : 11;

  // Every theme uses opaque per-hue chips so the text/background ratio is
  // deterministic and AA-compliant (see CHIP_COLORS). Border is the chip text
  // color at low alpha — a same-hue hairline that works on any chip bg.
  const cc = (CHIP_COLORS[C.name] || CHIP_COLORS.Dark);
  const chip = cc[tag.color] || cc.slate;
  const selBg = chip.bg;
  const selText = chip.text;
  const selBorder = `${chip.text}33`;

  return (
    <span
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding,
        fontSize,
        fontFamily: F.mono,
        letterSpacing: '0.04em',
        borderRadius: 4,
        cursor: isInteractive ? 'pointer' : 'default',
        background: isSel ? selBg : 'transparent',
        color: isSel ? selText : C.textDim,
        border: `1px solid ${isSel ? selBorder : C.border}`,
        opacity: dimmed ? 0.5 : 1,
        transition: 'all 120ms ease',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      {tag.name}
    </span>
  );
}

/* ============================================================
   THEME PICKER
   ============================================================ */
function ThemePicker({ theme, setTheme }) {
  const C = useTheme();
  const narrow = useNarrow();
  // Narrow: collapse the three-button control to a single icon that cycles
  // DARK -> LIGHT -> MIST, reusing the same setter. Outline left intact for
  // a visible keyboard focus ring; >=40px tap target.
  if (narrow) {
    const order = Object.keys(THEMES); // dark, light, mist
    const next = order[(order.indexOf(theme) + 1) % order.length];
    const cur = THEMES[theme] || THEMES.dark;
    return (
      <button
        onClick={() => setTheme(next)}
        title={`Theme: ${cur.name} — tap to switch`}
        aria-label={`Theme: ${cur.name}. Switch theme`}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          minWidth: 40, minHeight: 40, padding: 0,
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 8, cursor: 'pointer', color: C.text,
        }}>
        <Palette size={16} strokeWidth={1.75} />
      </button>
    );
  }
  return (
    <div style={{
      display: 'flex', gap: 2, background: C.surface,
      padding: 3, borderRadius: 8, border: `1px solid ${C.border}`,
    }}>
      {Object.entries(THEMES).map(([key, t]) => {
        const active = theme === key;
        return (
          <button key={key} onClick={() => setTheme(key)} title={t.name}
            style={{
              padding: '5px 9px',
              background: active ? C.surfaceHi : 'transparent',
              border: 'none', borderRadius: 5, cursor: 'pointer',
              fontFamily: F.mono, fontSize: 10, letterSpacing: '0.08em',
              color: active ? C.text : C.textMuted, textTransform: 'uppercase',
            }}>
            {t.name}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================
   GOOGLE CONNECT AFFORDANCE
   ============================================================ */
// Track narrow viewports so the header Connect control can collapse to an icon.
function useNarrow(maxWidth = 600) {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(`(max-width:${maxWidth}px)`).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(`(max-width:${maxWidth}px)`);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [maxWidth]);
  return narrow;
}

function GoogleG({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

// One control, two placements (header + Settings). Disabled with an explanatory
// title when GIS isn't ready (e.g. blocked by an ad-blocker / offline) so it is
// never a dead button.
function ConnectButton({ onConnect, gisStatus, hideLabel = false, full = false }) {
  const C = useTheme();
  // 'idle' and 'ready' are clickable; only a failed load or an in-flight attempt
  // disable the control. A failed load is never a dead button — it explains why.
  const disabled = gisStatus === 'failed' || gisStatus === 'loading';
  const title =
    gisStatus === 'failed'
      ? 'Google sign-in is unavailable — check your connection or disable your ad blocker'
      : gisStatus === 'loading'
        ? 'Loading Google sign-in…'
        : 'Connect your Google account';
  return (
    <button
      onClick={onConnect}
      disabled={disabled}
      title={title}
      aria-label="Connect Google"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        padding: full ? '12px 16px' : '7px 12px',
        width: full ? '100%' : 'auto',
        background: C.surface, color: disabled ? C.textDim : C.text,
        border: `1px solid ${C.border}`, borderRadius: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: F.body, fontSize: 13, fontWeight: 500,
        opacity: disabled ? 0.6 : 1, transition: 'all 120ms ease', whiteSpace: 'nowrap',
      }}
    >
      <GoogleG size={15} />
      {!hideLabel && <span>Connect Google</span>}
    </button>
  );
}

// Small monospace build stamp; click to copy. Shown in the Settings Account tab.
function BuildStamp() {
  const C = useTheme();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(BUILD_STAMP);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard blocked; no-op */ }
  };
  return (
    <div
      onClick={copy}
      title="Click to copy"
      style={{
        fontFamily: F.mono, fontSize: 10, color: C.textDim,
        cursor: 'pointer', userSelect: 'all', marginTop: 2,
      }}
    >
      {BUILD_STAMP}{copied ? '  ✓ copied' : ''}
    </div>
  );
}

/* ============================================================
   HEADER
   ============================================================ */
/* ============================================================
   DRIVE SYNC — status chip + collision dialog
   ============================================================ */

// Display config for each of the controller's 7 sync states. The chip is a pure
// view of controller state — never its own source of truth.
const SYNC_CHIP = {
  synced: { label: 'Synced', colorKey: 'mint', Icon: Cloud },
  syncing: { label: 'Syncing', colorKey: 'ice', Icon: RefreshCw },
  paused_reconnect: { label: 'Reconnect', colorKey: 'amber', Icon: AlertTriangle },
  paused_ratelimited: { label: 'Rate-limited', colorKey: 'amber', Icon: Clock },
  paused_quota: { label: 'Drive full', colorKey: 'coral', Icon: AlertTriangle },
  collision_pending: { label: 'Action needed', colorKey: 'coral', Icon: AlertTriangle },
  error: { label: 'Sync error', colorKey: 'coral', Icon: AlertTriangle },
};

// Header chip. Clicking syncs now (or reconnects on a 401); it's inert while a
// collision is pending (the blocking dialog drives that). Rendered only when
// signed in AND sync is enabled — signed out shows no chip at all.
function SyncChip({ status, onSyncNow, onReconnect }) {
  const C = useTheme();
  const narrow = useNarrow();
  const cfg = SYNC_CHIP[status] || SYNC_CHIP.synced;
  const tint = C[cfg.colorKey] || C.textMuted;
  const isReconnect = status === 'paused_reconnect';
  const isBlocked = status === 'collision_pending';
  const onClick = isBlocked ? undefined : isReconnect ? onReconnect : onSyncNow;
  return (
    <button onClick={onClick} disabled={isBlocked}
      aria-label={cfg.label}
      title={isReconnect ? 'Reconnect Google to resume sync' : isBlocked ? 'Resolve the sync conflict' : 'Sync now'}
      style={{
        display: 'flex', alignItems: 'center', gap: narrow ? 0 : 6, padding: '5px 9px',
        background: `${tint}1f`, border: `1px solid ${tint}55`, borderRadius: 8,
        color: C.text, cursor: isBlocked ? 'default' : 'pointer',
        fontFamily: F.mono, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
      <cfg.Icon size={12} strokeWidth={2} color={tint} />
      {!narrow && cfg.label}
    </button>
  );
}

// Live-spine (MCP) connection indicator. A pure view of the controller's state:
// MCP active → mint "MCP: <name>"; graceful fallback → amber "Local (MCP
// unavailable)"; clean local → dim. Rendered only when a spine target is
// configured, so a purely-local board shows no chip at all.
function SpineChip({ state }) {
  const C = useTheme();
  const narrow = useNarrow();
  if (!state) return null;
  const active = state.provider === 'mcp';
  const fallback = !!state.fallback;
  const tint = active ? C.mint : fallback ? C.amber : C.textDim;
  const Icon = active ? Cloud : fallback ? AlertTriangle : Cloud;
  return (
    <span title={state.error ? `${state.error.code}: ${state.error.message}` : state.indicator}
      style={{
        display: 'flex', alignItems: 'center', gap: narrow ? 0 : 6, padding: '5px 9px',
        background: `${tint}1f`, border: `1px solid ${tint}55`, borderRadius: 8,
        color: C.text, fontFamily: F.mono, fontSize: 10, letterSpacing: '0.06em',
        textTransform: 'uppercase', whiteSpace: 'nowrap',
      }}>
      <Icon size={12} strokeWidth={2} color={tint} />
      {!narrow && state.indicator}
    </span>
  );
}

// Blocking modal for the unrelated-histories case. Exactly three choices, all
// wired to the controller's resolveCollision — no auto-merge, no "merge" option.
// The controller already snapshots the pre-action local blob as a safety copy.
function CollisionDialog({ onResolve, busy }) {
  const C = useTheme();
  const choices = [
    { key: 'adopt_drive', label: 'Use the Drive copy', note: 'replace this device’s board with the one in Drive' },
    { key: 'upload_local', label: 'Upload this device', note: 'replace the Drive copy with this device’s board' },
    { key: 'disconnect', label: 'Disconnect sync', note: 'keep this board local and stop syncing' },
  ];
  return (
    <div style={{
      position: 'fixed', inset: 0, background: `${C.bg}cc`, backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 24,
    }}>
      <div style={{
        background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 14,
        width: '100%', maxWidth: 460, padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <AlertTriangle size={18} color={C.coral} strokeWidth={2} />
          <span style={{ fontFamily: F.display, fontStyle: 'italic', fontSize: 18, color: C.text }}>
            Unrelated boards detected
          </span>
        </div>
        <p style={{ fontFamily: F.body, fontSize: 13, color: C.textMuted, lineHeight: 1.6, margin: '0 0 18px' }}>
          This device and your Google Drive copy have unrelated histories — they were never
          synced from a shared point, so they can’t be merged automatically. Choose how to
          reconcile. Your current local board is kept as a safety copy before anything changes.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {choices.map((o) => (
            <button key={o.key} disabled={busy} onClick={() => onResolve(o.key)} style={{
              textAlign: 'left', padding: '12px 14px', background: C.surface,
              border: `1px solid ${C.border}`, borderRadius: 10, cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.6 : 1, transition: 'all 120ms ease',
            }}>
              <div style={{ fontFamily: F.body, fontSize: 13, color: C.text, fontWeight: 500 }}>{o.label}</div>
              <div style={{ fontFamily: F.mono, fontSize: 10, color: C.textMuted, marginTop: 2 }}>{o.note}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Header({ view, setView, user, onSignOut, onConnect, gisStatus, onNewTask, onOpenSettings, theme, setTheme, syncEnabled, syncStatus, onSyncNow, onReconnect, spineState }) {
  const C = useTheme();
  const narrow = useNarrow();
  const tabs = [
    { id: 'board', label: 'Board', Icon: LayoutGrid },
    { id: 'calendar', label: 'Calendar', Icon: CalendarDays },
    { id: 'gantt', label: 'Timeline', Icon: GanttChartSquare },
    { id: 'matrix', label: 'Matrix', Icon: Grid2x2 },
  ];

  return (
    <header style={{
      borderBottom: `1px solid ${C.border}`,
      // Keep vertical padding (18px) UNCHANGED on narrow so the header stays ~67px
      // tall; only the horizontal padding collapses (with safe-area insets).
      padding: narrow
        ? '18px max(16px, env(safe-area-inset-right)) 18px max(16px, env(safe-area-inset-left))'
        : '18px 28px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: C.bgGrain, position: 'sticky', top: 0, zIndex: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Snowflake size={18} color={C.ice} strokeWidth={1.5} />
          {!narrow && (
            <span style={{
              fontFamily: F.display, fontStyle: 'italic', fontWeight: 400,
              fontSize: 22, color: C.text, letterSpacing: '-0.02em',
            }}>Kanbantt</span>
          )}
        </div>
        {/* Events-synced badge removed with mock Calendar data; returns with
            real Google Calendar integration. */}
      </div>

      <nav style={{
        display: 'flex', gap: 4, background: C.surface,
        padding: 4, borderRadius: 10, border: `1px solid ${C.border}`,
      }}>
        {tabs.map(({ id, label, Icon }) => {
          const active = view === id;
          return (
            <button key={id} onClick={() => setView(id)} title={label} aria-label={label} style={{
              display: 'flex', alignItems: 'center', gap: narrow ? 0 : 8,
              // Vertical padding (8px) stays the same on narrow so the nav — the
              // header's tallest element — keeps its height. Only labels drop and
              // each tab gets a >=40px-wide tap target.
              padding: narrow ? '8px 0' : '8px 14px',
              ...(narrow ? { minWidth: 40, justifyContent: 'center' } : {}),
              background: active ? C.surfaceHi : 'transparent',
              color: active ? C.text : C.textMuted, border: 'none',
              borderRadius: 7, cursor: 'pointer', fontFamily: F.body,
              fontSize: 13, fontWeight: 500, transition: 'all 120ms ease',
            }}>
              <Icon size={14} strokeWidth={1.75} />
              {!narrow && label}
            </button>
          );
        })}
      </nav>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <SpineChip state={spineState} />
        {user && syncEnabled && (
          <SyncChip status={syncStatus} onSyncNow={onSyncNow} onReconnect={onReconnect} />
        )}
        <ThemePicker theme={theme} setTheme={setTheme} />
        <button onClick={onOpenSettings} style={{
          background: 'transparent', border: `1px solid ${C.border}`,
          borderRadius: 8, padding: 7, cursor: 'pointer',
          color: C.textMuted, display: 'flex', alignItems: 'center',
          transition: 'all 120ms ease',
        }} title="Settings">
          <Settings size={15} strokeWidth={1.5} />
        </button>
        <button onClick={onNewTask} title="New task" aria-label="New task" style={{
          display: 'flex', alignItems: 'center', gap: narrow ? 0 : 6,
          padding: '8px 14px', background: C.ice,
          color: C.isLight ? '#fff' : C.bg,
          border: 'none', borderRadius: 8, cursor: 'pointer',
          fontFamily: F.body, fontSize: 13, fontWeight: 600,
          // Collapse to a '+' icon button sized to the sibling header icon
          // buttons (the Settings gear is 31px: 15px icon + 7px padding + 1px
          // border) so the accent block doesn't tower over the row. 31px < the
          // 40px nav height, so the header height — and the top:67 sticky
          // FilterBar offset that depends on it — is unchanged.
          ...(narrow ? { padding: 0, minWidth: 31, minHeight: 31, justifyContent: 'center' } : {}),
        }}>
          <Plus size={14} strokeWidth={2.5} />
          {!narrow && 'New'}
        </button>
        {user ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: `linear-gradient(135deg, ${C.frost}, ${C.ice})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 600, color: '#fff', fontFamily: F.body,
            }}>{user.initials}</div>
            <button onClick={onSignOut} style={{
              background: 'transparent', border: 'none', color: C.textMuted,
              cursor: 'pointer', padding: 6, display: 'flex', alignItems: 'center',
            }} title="Sign out">
              <LogOut size={15} strokeWidth={1.5} />
            </button>
          </div>
        ) : (
          // Signed out: Google is optional. Collapses to an icon when narrow so
          // the header never overflows.
          <ConnectButton onConnect={onConnect} gisStatus={gisStatus} hideLabel={narrow} />
        )}
      </div>
    </header>
  );
}

/* ============================================================
   FILTER BAR
   ============================================================ */
function FilterBar({ tags, filters, setFilters }) {
  const C = useTheme();
  const narrow = useNarrow();
  const activeCount =
    (filters.search ? 1 : 0) +
    filters.tags.length +
    (filters.overdueOnly ? 1 : 0);

  const toggleTag = (tagId) => {
    setFilters((f) => ({
      ...f,
      tags: f.tags.includes(tagId) ? f.tags.filter((t) => t !== tagId) : [...f.tags, tagId],
    }));
  };

  return (
    <div style={{
      borderBottom: `1px solid ${C.border}`,
      // Keep vertical padding (12px) so the bar's ~53px height — baked into the
      // board minHeight offset — stays valid; only horizontal padding shrinks.
      padding: narrow ? '12px 16px' : '12px 28px',
      display: 'flex', alignItems: 'center', gap: 14,
      background: C.bg,
      position: 'sticky', top: 67, zIndex: 9,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 7, padding: '6px 10px',
        // Narrow: let search flex to fill and shrink instead of forcing 220px,
        // so the search + '#' + OVERDUE row fits at 390px.
        minWidth: narrow ? 0 : 220,
        ...(narrow ? { flex: 1 } : {}),
      }}>
        <Search size={13} strokeWidth={1.75} color={C.textDim} />
        <input
          type="text"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          placeholder={narrow ? 'Search…' : 'Search tasks, tags...'}
          style={{
            background: 'transparent', border: 'none', outline: 'none',
            color: C.text, fontSize: 13, fontFamily: F.body,
            width: '100%', padding: 0,
          }}
        />
        {filters.search && (
          <button onClick={() => setFilters((f) => ({ ...f, search: '' }))}
            style={{ background: 'transparent', border: 'none', color: C.textDim, cursor: 'pointer', padding: 0, display: 'flex' }}>
            <X size={12} strokeWidth={1.75} />
          </button>
        )}
      </div>

      <div style={{
        display: 'flex', gap: 5, flexWrap: 'nowrap', overflowX: 'auto',
        flex: 1, alignItems: 'center',
      }}>
        <Hash size={12} strokeWidth={1.75} color={C.textDim} style={{ flexShrink: 0 }} />
        {tags.map((tag) => (
          <TagChip
            key={tag.id}
            tag={tag}
            active={filters.tags.includes(tag.id)}
            dimmed={filters.tags.length > 0 && !filters.tags.includes(tag.id)}
            onClick={() => toggleTag(tag.id)}
          />
        ))}
      </div>

      <button
        onClick={() => setFilters((f) => ({ ...f, overdueOnly: !f.overdueOnly }))}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
          fontFamily: F.mono, fontSize: 10, letterSpacing: '0.08em',
          textTransform: 'uppercase',
          background: filters.overdueOnly ? `${C.coral}22` : 'transparent',
          border: `1px solid ${filters.overdueOnly ? `${C.coral}55` : C.border}`,
          color: filters.overdueOnly ? C.coral : C.textMuted,
          whiteSpace: 'nowrap',
        }}
      >
        <AlertTriangle size={11} strokeWidth={1.75} />
        Overdue
      </button>

      {activeCount > 0 && (
        <button
          onClick={() => setFilters({ search: '', tags: [], overdueOnly: false })}
          style={{
            padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
            fontFamily: F.mono, fontSize: 10, letterSpacing: '0.08em',
            textTransform: 'uppercase', background: 'transparent',
            border: `1px solid ${C.border}`, color: C.textMuted, whiteSpace: 'nowrap',
          }}
        >
          Clear · {activeCount}
        </button>
      )}
    </div>
  );
}

/* ============================================================
   TASK CARD
   ============================================================ */
function TaskCard({ task, tags, onClick, onDragStart, onDragOver, onDrop, onDragEnd, isDragging, dropIndicator }) {
  const C = useTheme();
  const due = startOfDay(new Date(task.dueDate));
  const now = startOfDay(new Date());
  const daysOut = Math.round((due - now) / 86400000);
  const overdue = daysOut < 0 && task.status !== 'done';

  let dueLabel = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (daysOut === 0) dueLabel = 'Today';
  else if (daysOut === 1) dueLabel = 'Tomorrow';
  else if (daysOut === -1) dueLabel = 'Yesterday';

  const priorityColor = C[PRIORITY[task.priority].key];
  const taskTags = (task.tags || []).map((id) => tags.find((t) => t.id === id)).filter(Boolean);
  const checklist = task.checklist || [];
  const checklistDone = checklist.filter((c) => c.done).length;
  const hasChecklist = checklist.length > 0;

  return (
    <div style={{ position: 'relative' }}>
      {dropIndicator && (
        <div style={{
          position: 'absolute', top: -6, left: 0, right: 0,
          height: 2, background: C.ice, borderRadius: 2,
          boxShadow: `0 0 8px ${C.ice}`,
        }} />
      )}
      <div
        draggable
        onDragStart={(e) => onDragStart(e, task.id)}
        onDragOver={(e) => onDragOver(e, task.id)}
        onDrop={(e) => onDrop(e, task.id)}
        onDragEnd={onDragEnd}
        onClick={() => onClick(task)}
        style={{
          background: C.surface,
          border: `${overdue ? '1.5px' : '1px'} solid ${overdue ? C.coral : C.border}`,
          borderRadius: 10, padding: 14, cursor: 'grab',
          transition: 'all 140ms ease',
          opacity: isDragging ? 0.35 : 1,
          boxShadow: overdue ? `0 0 0 1px ${C.coral}20, 0 4px 12px -4px ${C.coral}30` : 'none',
        }}
        onMouseEnter={(e) => {
          if (!isDragging && !overdue) e.currentTarget.style.borderColor = C.borderHi;
          if (!isDragging) e.currentTarget.style.transform = 'translateY(-1px)';
        }}
        onMouseLeave={(e) => {
          if (!overdue) e.currentTarget.style.borderColor = C.border;
          e.currentTarget.style.transform = 'translateY(0)';
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: priorityColor, marginTop: 7, flexShrink: 0,
          }} />
          <div style={{ fontSize: 14, fontWeight: 500, color: C.text, lineHeight: 1.4 }}>
            {task.title}
          </div>
        </div>
        {task.description && (
          <div style={{
            fontSize: 12, color: C.textMuted, lineHeight: 1.5,
            marginBottom: 10, marginLeft: 14,
            display: '-webkit-box', WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            <Markdown text={task.description} dim />
          </div>
        )}
        {taskTags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginLeft: 14, marginBottom: 8 }}>
            {taskTags.slice(0, 3).map((tag) => (
              <TagChip key={tag.id} tag={tag} size="sm" />
            ))}
            {taskTags.length > 3 && (
              <span style={{
                fontSize: 10, fontFamily: F.mono, color: C.textDim,
                padding: '2px 4px',
              }}>+{taskTags.length - 3}</span>
            )}
          </div>
        )}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginLeft: 14,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              fontFamily: F.mono, fontSize: 10.5,
              color: overdue ? C.coral : C.textDim,
              letterSpacing: '0.05em', textTransform: 'uppercase',
              fontWeight: overdue ? 600 : 400,
            }}>
              {overdue ? '◆ ' : ''}{dueLabel}
            </div>
            {hasChecklist && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 4,
                fontFamily: F.mono, fontSize: 10,
                color: checklistDone === checklist.length ? C.mint : C.textDim,
              }}>
                <ListChecks size={11} strokeWidth={1.75} />
                <span>{checklistDone}/{checklist.length}</span>
              </div>
            )}
          </div>
          <div style={{
            fontFamily: F.mono, fontSize: 10, color: C.textDim,
            letterSpacing: '0.05em',
          }}>{PRIORITY[task.priority].label}</div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   QUICK ADD
   ============================================================ */
function QuickAdd({ colId, onAdd }) {
  const C = useTheme();
  const [active, setActive] = useState(false);
  const [title, setTitle] = useState('');
  const inputRef = useRef(null);

  const submit = () => {
    const t = title.trim();
    if (t) onAdd(colId, t);
    setTitle('');
    setActive(false);
  };
  const cancel = () => {
    setTitle('');
    setActive(false);
  };

  if (!active) {
    return (
      <button
        onClick={() => setActive(true)}
        style={{
          width: '100%', background: 'transparent',
          border: `1px dashed ${C.border}`, borderRadius: 8,
          padding: '10px 12px', cursor: 'pointer',
          fontFamily: F.body, fontSize: 12, color: C.textDim,
          textAlign: 'left', display: 'flex',
          alignItems: 'center', gap: 6,
          transition: 'all 120ms ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = C.textMuted;
          e.currentTarget.style.borderColor = C.borderHi;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = C.textDim;
          e.currentTarget.style.borderColor = C.border;
        }}
      >
        <Plus size={12} strokeWidth={1.75} />
        Add card
      </button>
    );
  }

  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.ice}80`,
      borderRadius: 8, padding: 10,
      boxShadow: `0 0 0 3px ${C.ice}15`,
    }}>
      <input
        ref={inputRef}
        autoFocus
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') cancel();
        }}
        onBlur={() => {
          if (title.trim()) submit();
          else cancel();
        }}
        placeholder="Card title..."
        style={{
          width: '100%', background: 'transparent', border: 'none',
          outline: 'none', color: C.text, fontFamily: F.body,
          fontSize: 13, padding: 0,
        }}
      />
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border}`,
      }}>
        <span style={{
          fontFamily: F.mono, fontSize: 9, color: C.textDim,
          letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>↵ save · esc cancel</span>
      </div>
    </div>
  );
}

/* ============================================================
   BOARD VIEW
   ============================================================ */
function BoardView({ tasks, tags, columns, onTaskClick, onMove, onQuickAdd }) {
  const C = useTheme();
  const narrow = useNarrow();
  const [draggedId, setDraggedId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  // --- Mobile page-indicator pips (narrow only) ---
  // Track which column is centered in the narrow snap-scroll strip so the pip row
  // can highlight it and tapping a pip can jump to it. Desktop renders every column
  // in a grid, so none of this affects it.
  const scrollRef = useRef(null);
  const rafRef = useRef(0);
  const [activeCol, setActiveCol] = useState(0);
  const showPips = narrow && columns.length >= 2;

  // Column stride = first column's measured width + the 14px flex gap. Measured
  // (not recomputed from 85vw) so it survives orientation / safe-area changes.
  const colStride = () => {
    const first = scrollRef.current?.firstElementChild;
    return first ? first.offsetWidth + 14 : 0;
  };

  // Throttle scroll work with rAF; active index = scrollLeft / stride, clamped.
  const handleBoardScroll = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = scrollRef.current;
      const stride = colStride();
      if (!el || !stride) return;
      const idx = Math.max(0, Math.min(columns.length - 1, Math.round(el.scrollLeft / stride)));
      setActiveCol((prev) => (prev === idx ? prev : idx));
    });
  };

  const scrollToCol = (i) => {
    const el = scrollRef.current;
    const stride = colStride();
    if (!el || !stride) return;
    const reduce = typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ left: i * stride, behavior: reduce ? 'auto' : 'smooth' });
  };

  // Keep the active index in range when the column count shrinks (e.g. filtering),
  // and cancel any pending rAF on unmount.
  useEffect(() => {
    setActiveCol((prev) => Math.min(prev, Math.max(0, columns.length - 1)));
  }, [columns.length]);
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const handleDragStart = (e, taskId) => {
    setDraggedId(taskId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', taskId);
  };
  const handleDragOverCard = (e, taskId) => {
    e.preventDefault(); e.stopPropagation();
    if (taskId !== draggedId) setDropTarget({ type: 'card', id: taskId });
  };
  const handleDropOnCard = (e, taskId) => {
    e.preventDefault(); e.stopPropagation();
    if (draggedId && draggedId !== taskId) onMove(draggedId, { type: 'card', id: taskId });
    setDraggedId(null); setDropTarget(null);
  };
  const handleDragOverColumn = (e, colId) => {
    e.preventDefault();
    setDropTarget({ type: 'col', id: colId });
  };
  const handleDropOnColumn = (e, colId) => {
    e.preventDefault();
    if (draggedId) onMove(draggedId, { type: 'col', id: colId });
    setDraggedId(null); setDropTarget(null);
  };
  const handleDragEnd = () => {
    setDraggedId(null); setDropTarget(null);
  };

  return (
    <>
    <div ref={scrollRef} onScroll={narrow ? handleBoardScroll : undefined} style={narrow ? {
      // Narrow: horizontal snap-scroll strip; height grows naturally so only the
      // columns scroll sideways and the page still scrolls vertically.
      display: 'flex', flexWrap: 'nowrap', overflowX: 'auto', overflowY: 'visible',
      gap: 14, scrollSnapType: 'x mandatory', WebkitOverflowScrolling: 'touch',
      scrollPaddingLeft: 16, scrollPaddingRight: 16,
      paddingTop: 16,
      paddingLeft: 'max(16px, env(safe-area-inset-left))',
      paddingRight: 'max(16px, env(safe-area-inset-right))',
      // Extra bottom clearance (~40px pip-bar height) so the last card / QuickAdd
      // is not hidden behind the fixed pip row — only when the pips are shown.
      paddingBottom: showPips
        ? 'calc(56px + env(safe-area-inset-bottom))'
        : 'calc(16px + env(safe-area-inset-bottom))',
      minHeight: 'calc(100vh - 67px - 53px)',
    } : {
      padding: '24px 28px',
      display: 'grid', gridTemplateColumns: `repeat(${columns.length}, 1fr)`, gap: 18,
      minHeight: 'calc(100vh - 67px - 53px)',
    }}>
      {columns.map((col) => {
        const colTasks = tasks.filter((t) => t.status === col.id);
        const isDropCol = dropTarget?.type === 'col' && dropTarget.id === col.id;
        return (
          <div key={col.id}
            onDragOver={(e) => handleDragOverColumn(e, col.id)}
            onDrop={(e) => handleDropOnColumn(e, col.id)}
            style={{
              display: 'flex', flexDirection: 'column', gap: 12,
              padding: 6, margin: -6, borderRadius: 12,
              background: isDropCol ? C.surfaceDrop : 'transparent',
              transition: 'background 120ms ease',
              ...(narrow ? { flex: '0 0 85vw', maxWidth: '85vw', scrollSnapAlign: 'start' } : {}),
            }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              paddingBottom: 12, paddingLeft: 6, paddingRight: 6,
              borderBottom: `1px solid ${C.border}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: C[col.accentKey] }} />
                <span style={{
                  fontFamily: F.body, fontSize: 12, fontWeight: 500,
                  color: C.text, textTransform: 'uppercase', letterSpacing: '0.12em',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{col.label}</span>
              </div>
              <span style={{ fontFamily: F.mono, fontSize: 11, color: C.textDim, flexShrink: 0 }}>
                {colTasks.length.toString().padStart(2, '0')}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {colTasks.map((t) => (
                <TaskCard key={t.id} task={t} tags={tags} onClick={onTaskClick}
                  onDragStart={handleDragStart} onDragOver={handleDragOverCard}
                  onDrop={handleDropOnCard} onDragEnd={handleDragEnd}
                  isDragging={draggedId === t.id}
                  dropIndicator={dropTarget?.type === 'card' && dropTarget.id === t.id}
                />
              ))}
              {isDropCol && (
                <div style={{
                  height: 2,
                  background: C.ice,
                  borderRadius: 2,
                  boxShadow: `0 0 8px ${C.ice}`,
                }} />
              )}
              <QuickAdd colId={col.id} onAdd={onQuickAdd} />
            </div>
          </div>
        );
      })}
    </div>

    {/* Page-indicator pips — narrow only, ≥2 columns. Fixed at the viewport bottom
        (z:5: above board cards, below the header z:10 and modals z:100). One dot per
        column; the active dot tracks the snap-scroll position and is tappable to jump. */}
    {showPips && (
      <div style={{
        position: 'fixed', left: 0, right: 0,
        bottom: 'calc(12px + env(safe-area-inset-bottom))',
        display: 'flex', justifyContent: 'center',
        zIndex: 5, pointerEvents: 'none',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '0 6px', borderRadius: 999,
          // Faint pill + blur keeps the dots legible over cards; kept light.
          background: `${C.surface}b3`,
          backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          border: `1px solid ${C.border}`,
          boxShadow: C.shadow, pointerEvents: 'auto',
        }}>
          {columns.map((col, i) => {
            const active = i === activeCol;
            return (
              <button key={col.id} onClick={() => scrollToCol(i)}
                aria-label={`Go to ${col.label}`}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  padding: 0, margin: 0, width: 40, height: 40,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  WebkitTapHighlightColor: 'transparent',
                }}>
                <span style={{
                  width: 7, height: 7, borderRadius: 999,
                  background: active ? C.ice : C.textDim,
                  opacity: active ? 1 : 0.45,
                  transition: 'background 160ms ease, opacity 160ms ease',
                }} />
              </button>
            );
          })}
        </div>
      </div>
    )}
    </>
  );
}

/* ============================================================
   CALENDAR VIEW
   ============================================================ */
// Device-local calendar view preference — its own localStorage key, NOT board data
// (same pattern as theme). v0.2 layouts: month grid, week row, work-week (Mon-Fri) row.
const K_CAL_VIEW = 'kanbantt:calendar-view:v1';
const CAL_LAYOUTS = [
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'workweek', label: 'Work Week' },
];

// Shared day-cell chips — the SAME markup the month grid has always used, lifted into
// one place so the week / work-week day-columns reuse it verbatim (no parallel chip).
// `max` caps the list: month keeps its 3 + "+N more"; week/work-week pass Infinity to
// show the full day (the column is tall and has no expand affordance for "+N more").
function DayChips({ dayTasks, dayEvents, columns, onTaskClick, max = 3 }) {
  const C = useTheme();
  const combined = [
    ...dayTasks.map((t) => ({ kind: 'task', data: t })),
    ...dayEvents.map((e) => ({ kind: 'event', data: e })),
  ];
  const shown = combined.slice(0, max);
  const overflow = combined.length - shown.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {shown.map((item) => {
        if (item.kind === 'task') {
          const t = item.data;
          const col = columns.find((c) => c.id === t.status);
          const overdue = isOverdue(t);
          return (
            <div key={t.id} onClick={() => onTaskClick(t)} style={{
              fontSize: 11, color: C.text, background: C.surfaceHi,
              borderLeft: `2px solid ${overdue ? C.coral : C[col.accentKey]}`,
              padding: '3px 6px', borderRadius: 3, cursor: 'pointer',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{t.title}</div>
          );
        }
        const ev = item.data;
        return (
          <div key={ev.id} title={`${ev.time} · ${ev.title} (calendar)`} style={{
            fontSize: 11, color: C.eventText, background: 'transparent',
            border: `1px dashed ${C.eventText}50`,
            padding: '2px 6px', borderRadius: 3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            display: 'flex', alignItems: 'center', gap: 4, fontStyle: 'italic',
          }}>
            <Clock size={9} strokeWidth={2} />{ev.title}
          </div>
        );
      })}
      {overflow > 0 && (
        <div style={{ fontFamily: F.mono, fontSize: 10, color: C.textDim, paddingLeft: 6 }}>
          +{overflow} more
        </div>
      )}
    </div>
  );
}

function CalendarView({ tasks, events, columns, onTaskClick }) {
  const C = useTheme();
  const narrow = useNarrow();
  const [cursor, setCursor] = useState(new Date());
  // Narrow-only: the day whose task list renders below the compact grid. Defaults to today.
  const [selectedDay, setSelectedDay] = useState(() => startOfDay(new Date()));
  // Narrow-only month-jump picker (tap the month title): whether the popover is open and
  // which year its 12 month buttons display (reset to the cursor's year each time it opens).
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(() => new Date().getFullYear());
  // Device-local view preference (NOT board data): synchronous lazy read so the first
  // paint is the saved layout; persisted via safeSet, same as theme. Only the two new
  // layouts are honored — anything else (incl. absent) falls back to Month.
  const [layout, setLayout] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem(K_CAL_VIEW));
      return v === 'week' || v === 'workweek' ? v : 'month';
    } catch { return 'month'; }
  });
  useEffect(() => { safeSet(K_CAL_VIEW, layout); }, [layout]);

  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const startDay = monthStart.getDay();
  const daysInMonth = monthEnd.getDate();
  const totalCells = Math.ceil((startDay + daysInMonth) / 7) * 7;

  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startDay + 1;
    cells.push(dayNum < 1 || dayNum > daysInMonth ? null
      : new Date(cursor.getFullYear(), cursor.getMonth(), dayNum));
  }

  // Week / work-week buckets — Sunday-anchored to match the month grid's weekday order
  // (Sun-Sat); work-week is the Mon-Fri slice of that same week. Built as local-midnight
  // dates exactly like the month cells so iso()-based bucketing is the identical path.
  const weekStart = startOfDay(addDays(cursor, -cursor.getDay()));
  const weekDays = layout === 'workweek'
    ? Array.from({ length: 5 }, (_, i) => addDays(weekStart, i + 1))
    : Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const tasksForDay = (d) => d ? tasks.filter((t) => t.dueDate === iso(d)) : [];
  const eventsForDay = (d) => d ? events.filter((e) => e.date === iso(d)) : [];
  const isToday = (d) => d && iso(d) === iso(new Date());
  const isSelected = (d) => d && iso(d) === iso(selectedDay);

  const monthLabel = cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const fmtRange = (start, end) => {
    const md = { month: 'short', day: 'numeric' };
    const ymd = { month: 'short', day: 'numeric', year: 'numeric' };
    if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth())
      return `${start.toLocaleDateString('en-US', md)} – ${end.getDate()}, ${end.getFullYear()}`;
    if (start.getFullYear() === end.getFullYear())
      return `${start.toLocaleDateString('en-US', md)} – ${end.toLocaleDateString('en-US', md)}, ${end.getFullYear()}`;
    return `${start.toLocaleDateString('en-US', ymd)} – ${end.toLocaleDateString('en-US', ymd)}`;
  };
  const title = layout === 'month'
    ? monthLabel
    : fmtRange(weekDays[0], weekDays[weekDays.length - 1]);

  // prev/next: by one month in month view, by one week in week / work-week.
  const goPrev = () => setCursor(layout === 'month'
    ? new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1)
    : addDays(cursor, -7));
  const goNext = () => setCursor(layout === 'month'
    ? new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    : addDays(cursor, 7));

  const navBtn = {
    background: C.surface, border: `1px solid ${C.border}`, color: C.text,
    width: 32, height: 32, borderRadius: 7, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  // ── Narrow / mobile: a compact tappable month grid + the selected day's task list.
  // Always month-mode here (the persisted week/work-week layout is ignored); the desktop
  // branch below is left exactly as-is. ──
  if (narrow) {
    const selTasks = tasksForDay(selectedDay);
    const selLabel = selectedDay.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    // Step a whole month and pin the detail to the visible month: today when it lands
    // there, otherwise the 1st of the new month.
    const selectInMonth = (m) => {
      const now = new Date();
      const sameMonth = now.getFullYear() === m.getFullYear() && now.getMonth() === m.getMonth();
      setSelectedDay(sameMonth ? startOfDay(now) : startOfDay(m));
    };
    const stepMonth = (delta) => {
      const m = new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
      setCursor(m);
      selectInMonth(m);
    };
    const goToday = () => { const now = new Date(); setCursor(now); setSelectedDay(startOfDay(now)); };
    // Month-jump picker: open re-seeds the displayed year from the cursor; picking a month
    // jumps the calendar there and pins the detail day via the same rule as stepMonth.
    const openMonthPicker = () => { setPickerYear(cursor.getFullYear()); setMonthPickerOpen(true); };
    const jumpToMonth = (monthIndex) => {
      const m = new Date(pickerYear, monthIndex, 1);
      setCursor(m);
      selectInMonth(m);
      setMonthPickerOpen(false);
    };
    const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const legendItem = {
      display: 'flex', alignItems: 'center', gap: 6,
      fontFamily: F.mono, fontSize: 10, color: C.textMuted,
      letterSpacing: '0.06em', textTransform: 'uppercase',
    };
    const legendDot = (color) => ({ width: 8, height: 8, borderRadius: '50%', background: color });

    return (
      <div style={{ padding: 14 }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 12, marginBottom: 16,
        }}>
          <div style={{ position: 'relative' }}>
            <button onClick={openMonthPicker} aria-label="Jump to month" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'transparent', border: 'none', padding: 0, margin: 0,
              cursor: 'pointer', textAlign: 'left',
              fontFamily: F.display, fontStyle: 'italic', fontWeight: 400,
              fontSize: 22, color: C.text, letterSpacing: '-0.02em',
            }}>
              {monthLabel}
              <ChevronDown size={16} strokeWidth={1.5} style={{ marginTop: 3, flexShrink: 0 }} />
            </button>
            <div style={{ display: 'flex', gap: 14, marginTop: 6 }}>
              <div style={legendItem}><span style={legendDot(C.ice)} />Tasks</div>
              <div style={legendItem}><span style={legendDot(C.coral)} />Overdue</div>
            </div>
            {monthPickerOpen && (
              <>
                {/* Backdrop: catches outside taps and dims, matching the modal overlay treatment. */}
                <div onClick={() => setMonthPickerOpen(false)} style={{
                  position: 'fixed', inset: 0, background: C.modalBackdrop,
                  backdropFilter: 'blur(4px)', zIndex: 100,
                }} />
                {/* Card: drops just under the title (anchored to this relative wrapper). */}
                <div style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 8,
                  width: 280, maxWidth: '86vw', zIndex: 101,
                  background: C.surface, border: `1px solid ${C.borderHi}`,
                  borderRadius: 12, padding: 14, boxShadow: C.shadow,
                }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    marginBottom: 12,
                  }}>
                    <button onClick={() => setPickerYear((y) => y - 1)} style={navBtn} aria-label="Previous year">
                      <ChevronLeft size={16} strokeWidth={1.5} />
                    </button>
                    <div style={{
                      fontFamily: F.mono, fontSize: 15, fontWeight: 600,
                      color: C.text, letterSpacing: '0.04em',
                    }}>{pickerYear}</div>
                    <button onClick={() => setPickerYear((y) => y + 1)} style={navBtn} aria-label="Next year">
                      <ChevronRight size={16} strokeWidth={1.5} />
                    </button>
                  </div>
                  <div style={{
                    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6,
                  }}>
                    {MONTHS_SHORT.map((name, idx) => {
                      const current = idx === cursor.getMonth() && pickerYear === cursor.getFullYear();
                      return (
                        <button key={idx} onClick={() => jumpToMonth(idx)} style={{
                          height: 40, borderRadius: 8, cursor: 'pointer',
                          background: current ? `${C.ice}22` : C.surfaceHi,
                          border: current ? `1.5px solid ${C.ice}` : `1px solid ${C.border}`,
                          color: current ? C.text : C.textMuted,
                          fontFamily: F.mono, fontSize: 12, fontWeight: current ? 600 : 400,
                          letterSpacing: '0.02em',
                        }}>{name}</button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button onClick={() => stepMonth(-1)} style={navBtn}>
              <ChevronLeft size={16} strokeWidth={1.5} />
            </button>
            <button onClick={goToday} style={{
              ...navBtn, padding: '0 12px', width: 'auto', fontFamily: F.mono, fontSize: 11,
            }}>TODAY</button>
            <button onClick={() => stepMonth(1)} style={navBtn}>
              <ChevronRight size={16} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 1,
          background: C.border, border: `1px solid ${C.border}`,
          borderRadius: 10, overflow: 'hidden',
        }}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
            <div key={i} style={{
              background: C.bgGrain, padding: '6px 0', textAlign: 'center',
              fontFamily: F.mono, fontSize: 10, color: C.textMuted, textTransform: 'uppercase',
            }}>{d}</div>
          ))}
          {cells.map((d, i) => {
            const todayCell = isToday(d);
            const selectedCell = isSelected(d);
            const dayTasks = tasksForDay(d);
            const anyOverdue = dayTasks.some(isOverdue);
            return (
              <div key={i} onClick={d ? () => setSelectedDay(startOfDay(d)) : undefined} style={{
                background: selectedCell ? `${C.ice}22` : C.surface,
                minHeight: 48, padding: 4, opacity: d ? 1 : 0.3,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 3,
                cursor: d ? 'pointer' : 'default',
                boxShadow: selectedCell ? `inset 0 0 0 1.5px ${C.ice}` : 'none',
              }}>
                {d && (
                  <>
                    <div style={{
                      fontFamily: F.mono, fontSize: 12, lineHeight: 1.4,
                      color: todayCell ? (C.isLight ? '#fff' : C.bg) : C.textMuted,
                      background: todayCell ? C.ice : 'transparent',
                      borderRadius: 4, padding: todayCell ? '1px 5px' : '0',
                      fontWeight: todayCell ? 600 : 400,
                    }}>{d.getDate()}</div>
                    <div style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: dayTasks.length ? (anyOverdue ? C.coral : C.ice) : 'transparent',
                    }} />
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 18 }}>
          <h3 style={{
            fontFamily: F.display, fontStyle: 'italic', fontWeight: 400,
            fontSize: 17, margin: '0 0 10px', color: C.text, letterSpacing: '-0.01em',
          }}>{selLabel}</h3>
          {selTasks.length ? (
            <DayChips dayTasks={selTasks} dayEvents={[]} columns={columns}
              onTaskClick={onTaskClick} max={Infinity} />
          ) : (
            <div style={{ fontFamily: F.body, fontSize: 13, color: C.textDim }}>No tasks due</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 28 }}>
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12,
        justifyContent: 'space-between', marginBottom: 24,
      }}>
        <div>
          <h2 style={{
            fontFamily: F.display, fontStyle: 'italic', fontWeight: 400,
            fontSize: 28, margin: 0, color: C.text, letterSpacing: '-0.02em',
          }}>{title}</h2>
          <Legend />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{
            display: 'flex', gap: 4, background: C.surface,
            padding: 4, borderRadius: 10, border: `1px solid ${C.border}`,
          }}>
            {CAL_LAYOUTS.map(({ id, label }) => {
              const active = layout === id;
              return (
                <button key={id} onClick={() => setLayout(id)} style={{
                  padding: '6px 12px',
                  background: active ? C.surfaceHi : 'transparent',
                  color: active ? C.text : C.textMuted, border: 'none',
                  borderRadius: 7, cursor: 'pointer', fontFamily: F.body,
                  fontSize: 12, fontWeight: 500, transition: 'all 120ms ease',
                  whiteSpace: 'nowrap',
                }}>{label}</button>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={goPrev} style={navBtn}>
              <ChevronLeft size={16} strokeWidth={1.5} />
            </button>
            <button onClick={() => setCursor(new Date())} style={{
              ...navBtn, padding: '0 14px', width: 'auto', fontFamily: F.mono, fontSize: 11,
            }}>TODAY</button>
            <button onClick={goNext} style={navBtn}>
              <ChevronRight size={16} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </div>

      {layout === 'month' ? (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 1,
          background: C.border, border: `1px solid ${C.border}`,
          borderRadius: 10, overflow: 'hidden',
        }}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} style={{
              background: C.bgGrain, padding: '10px 12px',
              fontFamily: F.mono, fontSize: 10.5, letterSpacing: '0.1em',
              color: C.textMuted, textTransform: 'uppercase',
            }}>{d}</div>
          ))}
          {cells.map((d, i) => {
            const todayCell = isToday(d);
            return (
              <div key={i} style={{
                background: C.surface, minHeight: 118, padding: 8,
                position: 'relative', opacity: d ? 1 : 0.3,
              }}>
                {d && (
                  <>
                    <div style={{
                      fontFamily: F.mono, fontSize: 12,
                      color: todayCell ? (C.isLight ? '#fff' : C.bg) : C.textMuted,
                      background: todayCell ? C.ice : 'transparent',
                      borderRadius: 4, padding: todayCell ? '2px 6px' : '0',
                      display: 'inline-block', marginBottom: 6,
                      fontWeight: todayCell ? 600 : 400,
                    }}>{d.getDate()}</div>
                    <DayChips dayTasks={tasksForDay(d)} dayEvents={eventsForDay(d)}
                      columns={columns} onTaskClick={onTaskClick} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${weekDays.length}, minmax(0, 1fr))`, gap: 1,
          background: C.border, border: `1px solid ${C.border}`,
          borderRadius: 10, overflow: 'hidden',
        }}>
          {weekDays.map((d, i) => {
            const todayCell = isToday(d);
            return (
              <div key={i} style={{
                background: C.surface, minHeight: 520,
                display: 'flex', flexDirection: 'column',
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: C.bgGrain, padding: '10px 12px',
                  borderBottom: `1px solid ${C.border}`,
                }}>
                  <span style={{
                    fontFamily: F.mono, fontSize: 10.5, letterSpacing: '0.1em',
                    color: C.textMuted, textTransform: 'uppercase',
                  }}>{d.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                  <span style={{
                    fontFamily: F.mono, fontSize: 12,
                    color: todayCell ? (C.isLight ? '#fff' : C.bg) : C.textMuted,
                    background: todayCell ? C.ice : 'transparent',
                    borderRadius: 4, padding: todayCell ? '2px 6px' : '0',
                    fontWeight: todayCell ? 600 : 400,
                  }}>{d.getDate()}</span>
                </div>
                <div style={{ padding: 8 }}>
                  <DayChips dayTasks={tasksForDay(d)} dayEvents={eventsForDay(d)}
                    columns={columns} onTaskClick={onTaskClick} max={Infinity} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Legend() {
  const C = useTheme();
  const item = {
    display: 'flex', alignItems: 'center', gap: 6,
    fontFamily: F.mono, fontSize: 10, color: C.textMuted,
    letterSpacing: '0.06em', textTransform: 'uppercase',
  };
  return (
    <div style={{ display: 'flex', gap: 18, marginTop: 8 }}>
      <div style={item}>
        <div style={{ width: 10, height: 10, borderLeft: `2px solid ${C.ice}`, background: C.surfaceHi, borderRadius: 2 }} />
        Tasks
      </div>
      <div style={item}>
        <div style={{ width: 10, height: 10, border: `1px dashed ${C.eventText}80`, borderRadius: 2 }} />
        Calendar
      </div>
      <div style={item}>
        <div style={{ width: 10, height: 10, borderLeft: `2px solid ${C.coral}`, background: C.surfaceHi, borderRadius: 2 }} />
        Overdue
      </div>
    </div>
  );
}

/* ============================================================
   GANTT VIEW
   ============================================================ */
function GanttView({ tasks, events, columns, onTaskClick }) {
  const C = useTheme();
  const DAY_W = 36;
  const ROW_H = 44;
  const LABEL_W = 220;

  const [offset, setOffset] = useState(-7);
  const viewStart = addDays(new Date(), offset);
  viewStart.setHours(0, 0, 0, 0);
  const numDays = 42;
  const days = Array.from({ length: numDays }, (_, i) => addDays(viewStart, i));

  const sorted = [...tasks].sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  const todayIdx = Math.round((new Date().setHours(0, 0, 0, 0) - viewStart.getTime()) / 86400000);

  const eventByDay = {};
  events.forEach((e) => {
    const idx = Math.round((startOfDay(new Date(e.date)).getTime() - viewStart.getTime()) / 86400000);
    if (idx >= 0 && idx < numDays) eventByDay[idx] = (eventByDay[idx] || 0) + 1;
  });

  const navBtn = {
    background: C.surface, border: `1px solid ${C.border}`, color: C.text,
    width: 32, height: 32, borderRadius: 7, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  return (
    <div style={{ padding: 28 }}>
      <div style={{
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', marginBottom: 20,
      }}>
        <h2 style={{
          fontFamily: F.display, fontStyle: 'italic', fontWeight: 400,
          fontSize: 28, margin: 0, color: C.text, letterSpacing: '-0.02em',
        }}>Timeline</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => setOffset(offset - 14)} style={navBtn}>
            <ChevronLeft size={16} strokeWidth={1.5} />
          </button>
          <button onClick={() => setOffset(-7)} style={{
            ...navBtn, padding: '0 14px', width: 'auto', fontFamily: F.mono, fontSize: 11,
          }}>TODAY</button>
          <button onClick={() => setOffset(offset + 14)} style={navBtn}>
            <ChevronRight size={16} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <div style={{
        border: `1px solid ${C.border}`, borderRadius: 10,
        overflow: 'auto', background: C.surface,
      }}>
        <div style={{ minWidth: LABEL_W + numDays * DAY_W }}>
          <div style={{
            display: 'flex', borderBottom: `1px solid ${C.border}`,
            background: C.bgGrain, position: 'sticky', top: 0, zIndex: 2,
          }}>
            <div style={{
              width: LABEL_W, padding: '10px 14px',
              fontFamily: F.mono, fontSize: 10.5, color: C.textMuted,
              letterSpacing: '0.1em', textTransform: 'uppercase',
              borderRight: `1px solid ${C.border}`,
            }}>Task</div>
            <div style={{ display: 'flex', flex: 1 }}>
              {days.map((d, i) => {
                const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                const isFirst = d.getDate() === 1 || i === 0;
                const isTodayD = iso(d) === iso(new Date());
                const evCount = eventByDay[i] || 0;
                return (
                  <div key={i} style={{
                    width: DAY_W, padding: '6px 0 4px', textAlign: 'center',
                    fontFamily: F.mono, fontSize: 10,
                    color: isTodayD ? C.ice : isWeekend ? C.textDim : C.textMuted,
                    background: isTodayD ? `${C.ice}15` : 'transparent',
                    borderRight: `1px solid ${C.border}30`, position: 'relative',
                  }}>
                    {isFirst && (
                      <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 2 }}>
                        {d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}
                      </div>
                    )}
                    {d.getDate()}
                    {evCount > 0 && (
                      <div style={{
                        position: 'absolute', bottom: 1, left: '50%',
                        transform: 'translateX(-50%)', width: 4, height: 4,
                        borderRadius: '50%', background: C.eventText, opacity: 0.7,
                      }} title={`${evCount} calendar event${evCount > 1 ? 's' : ''}`} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ position: 'relative' }}>
            {todayIdx >= 0 && todayIdx < numDays && (
              <div style={{
                position: 'absolute',
                left: LABEL_W + todayIdx * DAY_W + DAY_W / 2,
                top: 0, bottom: 0, width: 1,
                background: C.ice, opacity: 0.4, zIndex: 1,
              }} />
            )}
            {sorted.map((t) => {
              const start = startOfDay(new Date(t.startDate));
              const end = startOfDay(new Date(t.dueDate));
              const startIdx = Math.round((start - viewStart.getTime()) / 86400000);
              const duration = Math.round((end - start) / 86400000) + 1;
              const visible = startIdx + duration > 0 && startIdx < numDays;
              const overdue = isOverdue(t);
              const col = columns.find((c) => c.id === t.status);
              const accent = overdue ? C.coral : C[col.accentKey];
              const barLeft = Math.max(startIdx, 0) * DAY_W;
              const clipL = startIdx < 0 ? -startIdx : 0;
              const clipR = Math.max(0, startIdx + duration - numDays);
              const barWidth = Math.max(8, (duration - clipL - clipR) * DAY_W - 4);

              return (
                <div key={t.id} style={{
                  display: 'flex', height: ROW_H,
                  borderBottom: `1px solid ${C.border}`,
                  alignItems: 'center', position: 'relative',
                }}>
                  <div style={{
                    width: LABEL_W, padding: '0 14px', fontSize: 13,
                    color: C.text, borderRight: `1px solid ${C.border}`,
                    height: '100%', display: 'flex', alignItems: 'center',
                    gap: 8, flexShrink: 0,
                  }}>
                    <div style={{
                      width: 4, height: 4, borderRadius: '50%',
                      background: C[PRIORITY[t.priority].key], flexShrink: 0,
                    }} />
                    <span style={{
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{t.title}</span>
                  </div>
                  <div style={{ flex: 1, height: '100%', position: 'relative' }}>
                    {visible && (
                      <div onClick={() => onTaskClick(t)} style={{
                        position: 'absolute', left: barLeft + 2,
                        top: '50%', transform: 'translateY(-50%)',
                        width: barWidth, height: 22,
                        background: `linear-gradient(90deg, ${accent}35, ${accent}20)`,
                        borderLeft: `3px solid ${accent}`, borderRadius: 4,
                        cursor: 'pointer', display: 'flex', alignItems: 'center',
                        paddingLeft: 8, fontFamily: F.mono, fontSize: 10,
                        color: accent, letterSpacing: '0.05em',
                        textTransform: 'uppercase', overflow: 'hidden',
                        whiteSpace: 'nowrap', transition: 'all 120ms ease',
                        fontWeight: overdue ? 600 : 400,
                      }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = `linear-gradient(90deg, ${accent}55, ${accent}35)`;
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = `linear-gradient(90deg, ${accent}35, ${accent}20)`;
                        }}
                      >
                        {overdue ? '◆ ' : ''}{duration}d
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   TASK MODAL
   ============================================================ */
function TaskModal({ task, tags, columns, onSave, onDelete, onClose, isNew, onCreateTag }) {
  const C = useTheme();
  const [draft, setDraft] = useState(task);
  const [newTagInput, setNewTagInput] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newChecklistText, setNewChecklistText] = useState('');
  const [notesPreview, setNotesPreview] = useState(false);

  const fieldLabel = {
    fontFamily: F.mono, fontSize: 10, color: C.textMuted,
    letterSpacing: '0.12em', textTransform: 'uppercase',
    marginBottom: 6, display: 'block',
  };
  const input = {
    width: '100%', background: C.bg, border: `1px solid ${C.border}`,
    borderRadius: 7, padding: '10px 12px', color: C.text,
    fontFamily: F.body, fontSize: 14, boxSizing: 'border-box', outline: 'none',
  };

  const toggleTag = (tagId) => {
    const has = (draft.tags || []).includes(tagId);
    setDraft({
      ...draft,
      tags: has ? draft.tags.filter((t) => t !== tagId) : [...(draft.tags || []), tagId],
    });
  };

  const submitNewTag = () => {
    const n = newTagName.trim();
    if (!n) { setNewTagInput(false); setNewTagName(''); return; }
    const color = TAG_COLOR_CYCLE[tags.length % TAG_COLOR_CYCLE.length];
    const tag = { id: uid('tag'), name: n.toLowerCase().replace(/\s+/g, '-'), color };
    onCreateTag(tag);
    setDraft({ ...draft, tags: [...(draft.tags || []), tag.id] });
    setNewTagName('');
    setNewTagInput(false);
  };

  const addChecklistItem = () => {
    const t = newChecklistText.trim();
    if (!t) return;
    const item = { id: uid('ck'), text: t, done: false };
    setDraft({ ...draft, checklist: [...(draft.checklist || []), item] });
    setNewChecklistText('');
  };

  const toggleChecklistItem = (id) => {
    setDraft({
      ...draft,
      checklist: draft.checklist.map((c) => c.id === id ? { ...c, done: !c.done } : c),
    });
  };

  const removeChecklistItem = (id) => {
    setDraft({ ...draft, checklist: draft.checklist.filter((c) => c.id !== id) });
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: C.modalBackdrop,
      backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 20, overflowY: 'auto',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.surface, border: `1px solid ${C.borderHi}`,
        borderRadius: 14, width: '100%', maxWidth: 520, padding: 28,
        boxShadow: C.shadow, maxHeight: 'calc(100vh - 40px)', overflowY: 'auto',
        margin: 'auto',
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: 24,
        }}>
          <div style={{
            fontFamily: F.mono, fontSize: 11, color: C.textMuted,
            letterSpacing: '0.15em', textTransform: 'uppercase',
          }}>{isNew ? 'New task' : 'Edit task'}</div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', color: C.textMuted,
            cursor: 'pointer', padding: 4,
          }}>
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div>
            <label style={fieldLabel}>Title</label>
            <input autoFocus type="text" value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={input} />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label style={fieldLabel}>Notes — markdown: **bold** *italic* `code` [link](url) - list</label>
              {draft.description && (
                <button onClick={() => setNotesPreview(!notesPreview)} style={{
                  background: 'transparent', border: 'none', color: C.textDim,
                  cursor: 'pointer', fontFamily: F.mono, fontSize: 9,
                  letterSpacing: '0.1em', textTransform: 'uppercase',
                  padding: 0, marginBottom: 6,
                }}>{notesPreview ? '✎ Edit' : '◉ Preview'}</button>
              )}
            </div>
            {notesPreview ? (
              <div style={{
                ...input, minHeight: 60, padding: '10px 12px',
                cursor: 'pointer', fontSize: 13,
              }} onClick={() => setNotesPreview(false)}>
                <Markdown text={draft.description} />
              </div>
            ) : (
              <textarea value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                style={{ ...input, minHeight: 60, resize: 'vertical', fontFamily: F.body, fontSize: 13 }} />
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={fieldLabel}>Start</label>
              <input type="date" value={draft.startDate}
                onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
                style={{ ...input, fontFamily: F.mono }} />
            </div>
            <div>
              <label style={fieldLabel}>Due</label>
              <input type="date" value={draft.dueDate}
                onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                style={{ ...input, fontFamily: F.mono }} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={fieldLabel}>Status</label>
              <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}
                style={{ ...input, cursor: 'pointer' }}>
                {columns.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label style={fieldLabel}>Priority</label>
              <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
                style={{ ...input, cursor: 'pointer' }}>
                {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={fieldLabel}>Effort</label>
              <select value={draft.effort || ''}
                onChange={(e) => setDraft({ ...draft, effort: e.target.value || undefined })}
                style={{ ...input, cursor: 'pointer' }}>
                <option value="">— unset</option>
                <option value="low">Low</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label style={fieldLabel}>Impact</label>
              <select value={draft.impact || ''}
                onChange={(e) => setDraft({ ...draft, impact: e.target.value || undefined })}
                style={{ ...input, cursor: 'pointer' }}>
                <option value="">— from priority</option>
                <option value="low">Low</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>

          <div>
            <label style={fieldLabel}>Tags</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
              {tags.map((tag) => (
                <TagChip key={tag.id} tag={tag} size="md"
                  active={(draft.tags || []).includes(tag.id)}
                  onClick={() => toggleTag(tag.id)} />
              ))}
              {newTagInput ? (
                <input autoFocus type="text" value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitNewTag();
                    if (e.key === 'Escape') { setNewTagInput(false); setNewTagName(''); }
                  }}
                  onBlur={submitNewTag}
                  placeholder="tag name"
                  style={{
                    background: C.bg, border: `1px solid ${C.ice}80`,
                    borderRadius: 4, padding: '4px 8px', color: C.text,
                    fontFamily: F.mono, fontSize: 11, outline: 'none', width: 110,
                  }} />
              ) : (
                <button onClick={() => setNewTagInput(true)} style={{
                  padding: '5px 10px', fontSize: 11, fontFamily: F.mono,
                  letterSpacing: '0.04em', borderRadius: 4, cursor: 'pointer',
                  background: 'transparent', color: C.textDim,
                  border: `1px dashed ${C.border}`, display: 'inline-flex',
                  alignItems: 'center', gap: 3,
                }}>
                  <Plus size={10} strokeWidth={2} />
                  new
                </button>
              )}
            </div>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label style={fieldLabel}>Checklist</label>
              {(draft.checklist || []).length > 0 && (
                <span style={{
                  fontFamily: F.mono, fontSize: 10, color: C.textDim,
                  letterSpacing: '0.08em',
                }}>
                  {draft.checklist.filter((c) => c.done).length}/{draft.checklist.length}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {(draft.checklist || []).map((item) => (
                <div key={item.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 8px', background: C.bg,
                  border: `1px solid ${C.border}`, borderRadius: 6,
                }}>
                  <button onClick={() => toggleChecklistItem(item.id)} style={{
                    width: 16, height: 16, borderRadius: 3,
                    border: `1.5px solid ${item.done ? C.mint : C.border}`,
                    background: item.done ? C.mint : 'transparent',
                    cursor: 'pointer', padding: 0, display: 'flex',
                    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}>
                    {item.done && <Check size={11} color={C.isLight ? '#fff' : C.bg} strokeWidth={3} />}
                  </button>
                  <span style={{
                    flex: 1, fontSize: 13, color: item.done ? C.textDim : C.text,
                    textDecoration: item.done ? 'line-through' : 'none',
                  }}>{item.text}</span>
                  <button onClick={() => removeChecklistItem(item.id)} style={{
                    background: 'transparent', border: 'none',
                    color: C.textDim, cursor: 'pointer', padding: 2,
                    display: 'flex',
                  }}>
                    <X size={12} strokeWidth={1.5} />
                  </button>
                </div>
              ))}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 8px', background: 'transparent',
                border: `1px dashed ${C.border}`, borderRadius: 6,
              }}>
                <div style={{
                  width: 16, height: 16, borderRadius: 3,
                  border: `1.5px solid ${C.border}`, flexShrink: 0,
                }} />
                <input type="text" value={newChecklistText}
                  onChange={(e) => setNewChecklistText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addChecklistItem(); }}
                  placeholder="Add item, press Enter"
                  style={{
                    flex: 1, background: 'transparent', border: 'none',
                    outline: 'none', color: C.text, fontFamily: F.body, fontSize: 13,
                  }} />
              </div>
            </div>
          </div>
        </div>

        <div style={{
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', marginTop: 24,
          paddingTop: 18, borderTop: `1px solid ${C.border}`,
        }}>
          {!isNew ? (
            <button onClick={() => onDelete(draft.id)} style={{
              background: 'transparent', border: `1px solid ${C.border}`,
              color: C.coral, padding: '9px 12px', borderRadius: 7,
              cursor: 'pointer', display: 'flex', alignItems: 'center',
              gap: 6, fontFamily: F.body, fontSize: 13,
            }}>
              <Trash2 size={14} strokeWidth={1.5} />
              Delete
            </button>
          ) : <div />}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{
              background: 'transparent', border: `1px solid ${C.border}`,
              color: C.textMuted, padding: '9px 16px', borderRadius: 7,
              cursor: 'pointer', fontFamily: F.body, fontSize: 13,
            }}>Cancel</button>
            <button onClick={() => onSave(draft)} style={{
              background: C.ice, border: 'none',
              color: C.isLight ? '#fff' : C.bg,
              padding: '9px 18px', borderRadius: 7, cursor: 'pointer',
              fontFamily: F.body, fontSize: 13, fontWeight: 600,
            }}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   MATRIX VIEW (2x2 effort/impact prioritization)
   ============================================================ */
function MatrixView({ tasks, tags, onTaskClick, onClassify }) {
  const C = useTheme();
  const [draggedId, setDraggedId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const groups = useMemo(() => {
    const g = { avoid: [], plan: [], deprioritize: [], do: [], unsorted: [] };
    tasks.forEach((t) => g[getQuadrant(t)].push(t));
    return g;
  }, [tasks]);

  const handleDragStart = (e, taskId) => {
    setDraggedId(taskId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, target) => {
    e.preventDefault();
    if (dropTarget !== target) setDropTarget(target);
  };

  const handleDrop = (e, target) => {
    e.preventDefault();
    if (!draggedId) return;
    if (target === 'unsorted') {
      onClassify(draggedId, { effort: undefined, impact: undefined });
    } else {
      const def = QUADRANT_DEFS[target];
      onClassify(draggedId, { effort: def.effort, impact: def.impact });
    }
    setDraggedId(null);
    setDropTarget(null);
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setDropTarget(null);
  };

  const renderCards = (cards) =>
    cards.map((t) => (
      <TaskCard
        key={t.id}
        task={t}
        tags={tags}
        onClick={onTaskClick}
        onDragStart={handleDragStart}
        onDragOver={() => {}}
        onDrop={() => {}}
        onDragEnd={handleDragEnd}
        isDragging={draggedId === t.id}
        dropIndicator={false}
      />
    ));

  const renderQuadrant = (type) => {
    const def = QUADRANT_DEFS[type];
    const accent = C[def.accentKey];
    const isDrop = dropTarget === type;
    const Icon = def.Icon;
    const cards = groups[type];
    return (
      <div
        onDragOver={(e) => handleDragOver(e, type)}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget)) return;
          if (dropTarget === type) setDropTarget(null);
        }}
        onDrop={(e) => handleDrop(e, type)}
        style={{
          background: isDrop ? `${accent}28` : `${accent}${def.tintAlpha}`,
          border: `1px solid ${isDrop ? accent : C.border}`,
          borderRadius: 12,
          padding: 16,
          transition: 'background 120ms ease, border-color 120ms ease',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          minHeight: 240,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <Icon size={14} color={accent} strokeWidth={1.75} style={{ alignSelf: 'center' }} />
          <span
            style={{
              fontFamily: F.mono,
              fontSize: 11,
              color: accent,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            {def.label}
          </span>
          <span
            style={{
              fontFamily: F.display,
              fontStyle: 'italic',
              fontSize: 12,
              color: C.textDim,
              fontWeight: 400,
            }}
          >
            {def.tagline}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: F.mono,
              fontSize: 10,
              color: C.textDim,
              letterSpacing: '0.05em',
            }}
          >
            {cards.length.toString().padStart(2, '0')}
          </span>
        </div>
        {cards.length > 0 ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
              gap: 10,
              alignContent: 'start',
            }}
          >
            {renderCards(cards)}
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px 0',
              fontFamily: F.display,
              fontStyle: 'italic',
              fontSize: 13,
              color: C.textDim,
              opacity: 0.7,
            }}
          >
            {type === 'avoid' ? 'nothing here, good' : '—'}
          </div>
        )}
      </div>
    );
  };

  const unsortedDrop = dropTarget === 'unsorted';

  return (
    <div style={{ padding: '24px 28px 40px' }}>
      <div style={{ marginBottom: 24 }}>
        <h2
          style={{
            fontFamily: F.display,
            fontStyle: 'italic',
            fontWeight: 400,
            fontSize: 28,
            margin: 0,
            color: C.text,
            letterSpacing: '-0.02em',
          }}
        >
          Matrix
        </h2>
        <div
          style={{
            fontFamily: F.mono,
            fontSize: 10,
            color: C.textMuted,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            marginTop: 6,
          }}
        >
          Effort × Impact
        </div>
      </div>

      {/* Axis-labeled 2x2 grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '32px 1fr',
          gridTemplateRows: '1fr 32px',
          gap: 10,
        }}
      >
        {/* Y-axis label (Effort) */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: F.mono,
            fontSize: 10,
            color: C.textMuted,
            letterSpacing: '0.25em',
            textTransform: 'uppercase',
          }}
        >
          <div style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            ↑ Effort
          </div>
        </div>

        {/* 2x2 quadrants — row 1: high effort, row 2: low effort; col 1: low impact, col 2: high impact */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gridTemplateRows: '1fr 1fr',
            gap: 12,
          }}
        >
          {renderQuadrant('avoid')}
          {renderQuadrant('plan')}
          {renderQuadrant('deprioritize')}
          {renderQuadrant('do')}
        </div>

        {/* corner spacer */}
        <div />

        {/* X-axis label (Impact) */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: F.mono,
            fontSize: 10,
            color: C.textMuted,
            letterSpacing: '0.25em',
            textTransform: 'uppercase',
          }}
        >
          Impact →
        </div>
      </div>

      {/* Unsorted tray */}
      <div
        onDragOver={(e) => handleDragOver(e, 'unsorted')}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget)) return;
          if (dropTarget === 'unsorted') setDropTarget(null);
        }}
        onDrop={(e) => handleDrop(e, 'unsorted')}
        style={{
          marginTop: 24,
          padding: 16,
          border: `1px dashed ${unsortedDrop ? C.ice : C.border}`,
          borderRadius: 12,
          background: unsortedDrop ? `${C.ice}14` : 'transparent',
          transition: 'all 120ms ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
          <span
            style={{
              fontFamily: F.mono,
              fontSize: 11,
              color: C.text,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Unsorted
          </span>
          <span
            style={{
              fontFamily: F.display,
              fontStyle: 'italic',
              fontSize: 12,
              color: C.textDim,
            }}
          >
            drag into a quadrant to classify
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: F.mono,
              fontSize: 10,
              color: C.textDim,
              letterSpacing: '0.05em',
            }}
          >
            {groups.unsorted.length.toString().padStart(2, '0')}
          </span>
        </div>
        {groups.unsorted.length > 0 ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
              gap: 10,
            }}
          >
            {renderCards(groups.unsorted)}
          </div>
        ) : (
          <div
            style={{
              padding: '16px 0',
              textAlign: 'center',
              fontFamily: F.display,
              fontStyle: 'italic',
              fontSize: 13,
              color: C.textDim,
              opacity: 0.7,
            }}
          >
            all classified
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   RELATIVE TIME (live-updating)
   ============================================================ */
function RelativeTime({ ts }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);
  if (!ts) return <>—</>;
  const delta = Math.max(0, now - ts);
  const sec = Math.floor(delta / 1000);
  if (sec < 5) return <>just now</>;
  if (sec < 60) return <>{sec}s ago</>;
  const min = Math.floor(sec / 60);
  if (min < 60) return <>{min}m ago</>;
  const hr = Math.floor(min / 60);
  if (hr < 24) return <>{hr}h ago</>;
  const d = Math.floor(hr / 24);
  return <>{d}d ago</>;
}

/* ============================================================
   SETTINGS MODAL (columns + tags management)
   ============================================================ */

// Shared color swatch + palette popover used by both the tag and column rows in
// Settings. The trigger shows the current color; clicking or Enter/Space opens a
// popover, each choice is itself a focusable button (Enter/Space selects), Escape
// closes and restores focus to the trigger. Selecting calls onPick(key) — the
// parent routes that through the store (tagUpdate / columnUpdate). No free-form hex.
//   swatches : [{ key, hex }]  — opaque hues to choose from
//   value    : currently selected key
//   shape    : 'round' (tag dots) | 'square' (column accents), matching the row
//   cols     : palette grid column count
// Every surface here is opaque: swatch/palette fills are solid hues and the
// popover sits on C.surfaceHi (the dropped `panel` token used to leave it
// transparent, which read as frosted over the modal).
function SwatchPicker({ swatches, value, onPick, C, shape = 'round', cols = 5, label = 'Color' }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const popRef = useRef(null);
  const radius = shape === 'round' ? '50%' : 5;
  const current = swatches.find((s) => s.key === value) || swatches[0];

  // Close when clicking outside the swatch + popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!popRef.current?.contains(e.target) && !triggerRef.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // On open, move focus into the palette (selected hue, else the first).
  useEffect(() => {
    if (!open) return;
    const target = popRef.current?.querySelector('[data-selected="true"]')
      || popRef.current?.querySelector('button');
    target?.focus();
  }, [open]);

  const closeAndRefocus = () => { setOpen(false); triggerRef.current?.focus(); };
  const select = (key) => { onPick(key); closeAndRefocus(); };

  return (
    <div style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
      <button ref={triggerRef} onClick={() => setOpen((o) => !o)}
        title="Set color" aria-haspopup="true" aria-expanded={open} style={{
          width: 18, height: 18, borderRadius: radius, padding: 0, display: 'block',
          background: current.hex, border: `1px solid ${C.border}`,
          cursor: 'pointer', transition: 'all 120ms ease',
        }} />
      {open && (
        <div ref={popRef} role="menu" aria-label={label}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); closeAndRefocus(); }
          }}
          style={{
            position: 'absolute', top: 26, left: 0, zIndex: 10,
            display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 6,
            padding: 8, background: C.surfaceHi, border: `1px solid ${C.border}`,
            borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
          }}>
          {swatches.map(({ key, hex }) => {
            const isSel = key === value;
            return (
              <button key={key} data-selected={isSel} onClick={() => select(key)}
                title={key} aria-label={key} role="menuitemradio" aria-checked={isSel}
                style={{
                  width: 20, height: 20, borderRadius: radius, padding: 0,
                  background: hex, cursor: 'pointer', outlineOffset: 2,
                  border: isSel ? `2px solid ${C.text}` : `1px solid ${C.border}`,
                }} />
            );
          })}
        </div>
      )}
    </div>
  );
}

function SettingsModal({
  columns, tags, tasks, user, onSignOut, onConnect, gisStatus, lastSync, onClose,
  syncEnabled, onToggleSync, syncStatus, onSyncNow,
  onAddColumn, onRenameColumn, onRecolorColumn, onReorderColumn, onDeleteColumn,
  onAddTag, onRenameTag, onRecolorTag, onDeleteTag,
}) {
  const C = useTheme();
  const [tab, setTab] = useState('columns');
  const [newColumnName, setNewColumnName] = useState('');
  const [newTagName, setNewTagName] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleAddColumn = () => {
    if (!newColumnName.trim()) return;
    onAddColumn(newColumnName);
    setNewColumnName('');
  };
  const handleAddTag = () => {
    if (!newTagName.trim()) return;
    onAddTag(newTagName);
    setNewTagName('');
  };

  const columnCardCount = (id) => tasks.filter((t) => t.status === id).length;
  const tagCardCount = (id) => tasks.filter((t) => (t.tags || []).includes(id)).length;

  const input = {
    flex: 1, padding: '7px 11px', background: C.bg,
    border: `1px solid ${C.border}`, borderRadius: 7,
    color: C.text, fontFamily: F.body, fontSize: 13,
    outline: 'none',
  };
  const iconBtn = (disabled) => ({
    background: 'transparent', border: 'none',
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? C.textDim : C.textMuted,
    padding: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 6, opacity: disabled ? 0.35 : 1,
    transition: 'all 120ms ease',
  });
  const addBtn = {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', background: C.ice,
    color: C.isLight ? '#fff' : C.bg,
    border: 'none', borderRadius: 7, cursor: 'pointer',
    fontFamily: F.body, fontSize: 13, fontWeight: 600,
  };
  const helperText = {
    fontFamily: F.mono, fontSize: 10, color: C.textDim,
    letterSpacing: '0.05em', lineHeight: 1.6, marginTop: 2,
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: `${C.bg}b3`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100, padding: 24, backdropFilter: 'blur(4px)',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.surfaceHi, border: `1px solid ${C.border}`,
        borderRadius: 14, width: '100%', maxWidth: 580,
        maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
      }}>
        {/* Header */}
        <div style={{
          padding: '18px 22px', borderBottom: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <h2 style={{
              fontFamily: F.display, fontStyle: 'italic', fontWeight: 400,
              fontSize: 22, color: C.text, margin: 0, letterSpacing: '-0.02em',
            }}>Settings</h2>
            <div style={{
              fontFamily: F.mono, fontSize: 10, letterSpacing: '0.18em',
              textTransform: 'uppercase', color: C.textMuted, marginTop: 4,
            }}>columns & tags</div>
          </div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: C.textMuted, padding: 6, display: 'flex', alignItems: 'center',
          }} title="Close (Esc)">
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex', gap: 2, padding: '10px 22px 0',
          borderBottom: `1px solid ${C.border}`,
        }}>
          {[
            { id: 'columns', label: 'Columns', count: columns.length },
            { id: 'tags', label: 'Tags', count: tags.length },
            { id: 'account', label: 'Account', count: null },
          ].map((t) => {
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: '9px 14px',
                color: active ? C.text : C.textMuted,
                fontFamily: F.body, fontSize: 13, fontWeight: 500,
                display: 'flex', alignItems: 'center', gap: 7,
                borderBottom: `2px solid ${active ? C.ice : 'transparent'}`,
                marginBottom: -1,
              }}>
                {t.label}
                {t.count !== null && (
                  <span style={{
                    fontFamily: F.mono, fontSize: 10,
                    color: active ? C.text : C.textDim,
                    background: active ? `${C.ice}26` : C.surface,
                    padding: '1px 6px', borderRadius: 4,
                  }}>{t.count}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div style={{
          padding: 22, overflowY: 'auto', flex: 1,
          display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          {tab === 'columns' && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {columns.map((col, idx) => {
                  const count = columnCardCount(col.id);
                  const isOnly = columns.length <= 1;
                  return (
                    <div key={col.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: 8, background: C.surface,
                      border: `1px solid ${C.border}`, borderRadius: 8,
                    }}>
                      <SwatchPicker shape="square" cols={3} label="Column color"
                        swatches={COLUMN_ACCENTS.map((key) => ({ key, hex: C[key] }))}
                        value={col.accentKey}
                        onPick={(key) => onRecolorColumn(col.id, key)} C={C} />
                      <input value={col.label}
                        onChange={(e) => onRenameColumn(col.id, e.target.value)}
                        style={{ ...input, padding: '6px 10px' }} />
                      <span style={{
                        fontFamily: F.mono, fontSize: 10, color: C.textDim,
                        minWidth: 50, textAlign: 'right',
                      }}>{count} {count === 1 ? 'card' : 'cards'}</span>
                      <button onClick={() => onReorderColumn(col.id, -1)}
                        disabled={idx === 0} style={iconBtn(idx === 0)} title="Move up">
                        <ChevronUp size={14} strokeWidth={1.75} />
                      </button>
                      <button onClick={() => onReorderColumn(col.id, 1)}
                        disabled={idx === columns.length - 1}
                        style={iconBtn(idx === columns.length - 1)} title="Move down">
                        <ChevronDown size={14} strokeWidth={1.75} />
                      </button>
                      <button onClick={() => onDeleteColumn(col.id)}
                        disabled={isOnly} style={iconBtn(isOnly)}
                        title={isOnly ? 'Need at least one column' :
                          count > 0 ? `Will move ${count} card${count === 1 ? '' : 's'} to the first remaining column` : 'Delete'}>
                        <Trash2 size={14} strokeWidth={1.75} />
                      </button>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <input value={newColumnName}
                  onChange={(e) => setNewColumnName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddColumn()}
                  placeholder="New column name…"
                  style={input} />
                <button onClick={handleAddColumn} style={addBtn}>
                  <Plus size={14} strokeWidth={2.5} /> Add
                </button>
              </div>

              <div style={helperText}>
                Deleting a column moves its cards to the first remaining column. Last column can't be deleted.
              </div>
            </>
          )}

          {tab === 'tags' && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {tags.map((tag) => {
                  const count = tagCardCount(tag.id);
                  return (
                    <div key={tag.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: 8, background: C.surface,
                      border: `1px solid ${C.border}`, borderRadius: 8,
                    }}>
                      <SwatchPicker shape="round" cols={5} label="Tag color"
                        swatches={TAG_SWATCHES} value={tag.color}
                        onPick={(c) => onRecolorTag(tag.id, c)} C={C} />
                      <input value={tag.name}
                        onChange={(e) => onRenameTag(tag.id, e.target.value)}
                        style={{ ...input, padding: '6px 10px' }} />
                      <span style={{
                        fontFamily: F.mono, fontSize: 10, color: C.textDim,
                        minWidth: 50, textAlign: 'right',
                      }}>{count} {count === 1 ? 'card' : 'cards'}</span>
                      <button onClick={() => onDeleteTag(tag.id)} style={iconBtn(false)}
                        title={count > 0 ? `Will remove from ${count} card${count === 1 ? '' : 's'}` : 'Delete'}>
                        <Trash2 size={14} strokeWidth={1.75} />
                      </button>
                    </div>
                  );
                })}
                {tags.length === 0 && (
                  <div style={{
                    padding: 18, textAlign: 'center',
                    fontFamily: F.display, fontStyle: 'italic',
                    fontSize: 13, color: C.textDim,
                  }}>no tags yet</div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <input value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                  placeholder="New tag name…"
                  style={input} />
                <button onClick={handleAddTag} style={addBtn}>
                  <Plus size={14} strokeWidth={2.5} /> Add
                </button>
              </div>

              <div style={helperText}>
                Deleting a tag removes it from all cards. Renames apply instantly.
              </div>
            </>
          )}

          {tab === 'account' && (user ? (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: 14, background: C.surface,
                border: `1px solid ${C.border}`, borderRadius: 10,
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '50%',
                  background: `linear-gradient(135deg, ${C.frost}, ${C.ice})`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 15, fontWeight: 600, color: '#fff', fontFamily: F.body,
                  flexShrink: 0,
                }}>{user?.initials || '?'}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: F.body, fontSize: 14, color: C.text, fontWeight: 500,
                  }}>{user?.name || 'Not signed in'}</div>
                  <div style={{
                    fontFamily: F.mono, fontSize: 11, color: C.textMuted,
                    marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{user?.email || '—'}</div>
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', background: `${C.mint}15`,
                  borderRadius: 6, border: `1px solid ${C.mint}30`,
                  flexShrink: 0,
                }}>
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: C.mint, boxShadow: `0 0 8px ${C.mint}`,
                  }} />
                  <span style={{
                    fontFamily: F.mono, fontSize: 10, letterSpacing: '0.08em',
                    color: C.text, textTransform: 'uppercase',
                  }}>Connected</span>
                </div>
              </div>

              <div>
                <div style={{
                  fontFamily: F.mono, fontSize: 10, letterSpacing: '0.18em',
                  textTransform: 'uppercase', color: C.textMuted,
                  marginBottom: 10,
                }}>Granted scopes</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {[
                    { name: 'Drive', scope: 'drive.file', note: 'read/write only files this app creates' },
                    { name: 'Calendar', scope: 'calendar.events.readonly', note: 'read events from your primary calendar' },
                    { name: 'Profile', scope: 'openid email profile', note: 'name + email for display' },
                  ].map((s) => (
                    <div key={s.scope} style={{
                      display: 'flex', alignItems: 'baseline', gap: 10,
                      padding: '10px 12px', background: C.surface,
                      border: `1px solid ${C.border}`, borderRadius: 8,
                    }}>
                      <Check size={12} color={C.mint} strokeWidth={2.5}
                        style={{ flexShrink: 0, alignSelf: 'center' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{
                            fontFamily: F.body, fontSize: 13, color: C.text, fontWeight: 500,
                          }}>{s.name}</span>
                          <span style={{
                            fontFamily: F.mono, fontSize: 10, color: C.textDim,
                          }}>{s.scope}</span>
                        </div>
                        <div style={{
                          fontFamily: F.mono, fontSize: 10, color: C.textMuted,
                          marginTop: 2, letterSpacing: '0.02em',
                        }}>{s.note}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div style={{
                  fontFamily: F.mono, fontSize: 10, letterSpacing: '0.18em',
                  textTransform: 'uppercase', color: C.textMuted,
                  marginBottom: 10,
                }}>Storage</div>
                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: 12,
                  padding: '10px 12px', background: C.surface,
                  border: `1px solid ${C.border}`, borderRadius: 8,
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: F.body, fontSize: 13, color: C.text }}>
                      This device
                    </div>
                    <div style={{
                      fontFamily: F.mono, fontSize: 10, color: C.textMuted, marginTop: 2,
                    }}>
                      saved in your browser’s local storage
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                      <span style={{ fontFamily: F.mono, fontSize: 10, color: C.textMuted }}>Drive sync</span>
                      <button onClick={() => onToggleSync(!syncEnabled)} role="switch" aria-checked={!!syncEnabled}
                        title={syncEnabled ? 'Disable Drive sync' : 'Enable Drive sync'} style={{
                          width: 34, height: 18, borderRadius: 9, padding: 0, flexShrink: 0,
                          border: `1px solid ${syncEnabled ? C.ice : C.border}`,
                          background: syncEnabled ? C.ice : C.surfaceHi,
                          position: 'relative', cursor: 'pointer', transition: 'all 120ms ease',
                        }}>
                        <span style={{
                          position: 'absolute', top: 1, left: syncEnabled ? 17 : 1,
                          width: 14, height: 14, borderRadius: '50%',
                          background: syncEnabled ? '#fff' : C.textMuted, transition: 'left 120ms ease',
                        }} />
                      </button>
                      <span style={{
                        fontFamily: F.mono, fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase',
                        color: syncEnabled ? (C[SYNC_CHIP[syncStatus]?.colorKey] || C.mint) : C.textDim,
                      }}>{syncEnabled ? (SYNC_CHIP[syncStatus]?.label || 'On') : 'Off'}</span>
                      {syncEnabled && syncStatus !== 'collision_pending' && (
                        <button onClick={onSyncNow} title="Sync now" style={{
                          marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5,
                          fontFamily: F.mono, fontSize: 10, color: C.ice, background: 'transparent',
                          border: `1px solid ${C.border}`, borderRadius: 6, padding: '3px 8px', cursor: 'pointer',
                        }}>
                          <RefreshCw size={11} strokeWidth={2} /> Sync now
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{
                    fontFamily: F.mono, fontSize: 10, color: C.textDim,
                    textAlign: 'right',
                  }}>
                    <RelativeTime ts={lastSync} />
                  </div>
                </div>
              </div>

              <div style={{
                padding: '12px 14px', background: `${C.coral}10`,
                border: `1px solid ${C.coral}30`, borderRadius: 8,
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontFamily: F.body, fontSize: 13, color: C.text, fontWeight: 500,
                  }}>Sign out</div>
                  <div style={{
                    fontFamily: F.mono, fontSize: 10, color: C.textMuted, marginTop: 2,
                  }}>Disconnect this device. Your board stays saved on this device.</div>
                </div>
                <button onClick={onSignOut} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 14px', background: 'transparent',
                  color: C.coral, border: `1px solid ${C.coral}66`,
                  borderRadius: 7, cursor: 'pointer',
                  fontFamily: F.body, fontSize: 12, fontWeight: 500,
                }}>
                  <LogOut size={13} strokeWidth={1.75} />
                  Sign out
                </button>
              </div>

              <div style={helperText}>
                To fully revoke access, visit your{' '}
                <span style={{ color: C.text }}>Google Account → Security → Third-party apps</span>{' '}
                and remove Kanbantt. Your board lives in this browser; once Drive
                sync ships, this will also remove the synced copy.
              </div>

              <BuildStamp />
            </>
          ) : (
            <>
              {/* Local-first: the board works without Google. Connecting is optional. */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: 14, background: C.surface,
                border: `1px solid ${C.border}`, borderRadius: 10,
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '50%',
                  background: C.surfaceHi, border: `1px solid ${C.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <Snowflake size={18} color={C.textDim} strokeWidth={1.5} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: F.body, fontSize: 14, color: C.text, fontWeight: 500 }}>
                    Not signed in
                  </div>
                  <div style={{ fontFamily: F.mono, fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                    Your board is saved locally on this device
                  </div>
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', background: C.surfaceHi,
                  borderRadius: 6, border: `1px solid ${C.border}`, flexShrink: 0,
                }}>
                  <span style={{
                    fontFamily: F.mono, fontSize: 10, letterSpacing: '0.08em',
                    color: C.textMuted, textTransform: 'uppercase',
                  }}>Local</span>
                </div>
              </div>

              <div>
                <ConnectButton onConnect={onConnect} gisStatus={gisStatus} full />
                {gisStatus === 'failed' && (
                  <div style={{ ...helperText, color: C.coral, marginTop: 8 }}>
                    Google sign-in didn’t load — likely an ad-blocker or no connection.
                    The board still works without it.
                  </div>
                )}
              </div>

              <div>
                <div style={{
                  fontFamily: F.mono, fontSize: 10, letterSpacing: '0.18em',
                  textTransform: 'uppercase', color: C.textMuted, marginBottom: 10,
                }}>Connecting Google enables</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {[
                    { name: 'Drive sync', note: 'back up and sync your board across devices' },
                    { name: 'Calendar overlay', note: 'see your Google Calendar events alongside due dates' },
                  ].map((f) => (
                    <div key={f.name} style={{
                      display: 'flex', alignItems: 'baseline', gap: 10,
                      padding: '10px 12px', background: C.surface,
                      border: `1px solid ${C.border}`, borderRadius: 8,
                    }}>
                      <Clock size={12} color={C.textDim} strokeWidth={2}
                        style={{ flexShrink: 0, alignSelf: 'center' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{ fontFamily: F.body, fontSize: 13, color: C.text, fontWeight: 500 }}>{f.name}</span>
                          <span style={{
                            fontFamily: F.mono, fontSize: 9, color: C.amber,
                            letterSpacing: '0.1em', textTransform: 'uppercase',
                          }}>Upcoming</span>
                        </div>
                        <div style={{ fontFamily: F.mono, fontSize: 10, color: C.textMuted, marginTop: 2 }}>{f.note}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={helperText}>
                The board works fully without Google — create, edit, drag, and
                organize cards offline, saved on this device. Connecting only adds
                sync and the calendar overlay (both upcoming); it’s never required.
              </div>

              <BuildStamp />
            </>
          ))}
        </div>
      </div>
    </div>
  );
}

// Disposable MCP spike, reachable at ?spike=1. Lazy so it (and the MCP SDK it
// pulls in) stays out of the normal app bundle. Remove with the spike/ dir.
const McpSpike = lazy(() => import('../spike/McpSpike.jsx'));

/* ============================================================
   BOOT ERROR STATE
   ============================================================ */
// Download the raw legacy keys so no data is stranded behind a boot failure.
function downloadLegacyBackup() {
  try {
    const blob = new Blob([JSON.stringify(readLegacyDump(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kanbantt-legacy-backup-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('legacy backup download failed', e);
  }
}

// Shown when migration or store load fails. Never a board, never a reset — the
// only action is to rescue the raw legacy data.
function BootError({ code, message }) {
  return (
    <div style={{
      minHeight: '100vh', background: '#070b14', color: '#e4e9f2', fontFamily: F.body,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div style={{ maxWidth: 520, width: '100%' }}>
        <div style={{
          fontFamily: F.mono, fontSize: 11, letterSpacing: '0.18em',
          textTransform: 'uppercase', color: '#fb7185', marginBottom: 14,
        }}>Board failed to load</div>
        <h1 style={{ fontFamily: F.display, fontStyle: 'italic', fontWeight: 400, fontSize: 34, margin: '0 0 16px' }}>
          We couldn’t open your board
        </h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: '#8b95a8', margin: '0 0 8px' }}>
          Error code: <code style={{ fontFamily: F.mono, color: '#e4e9f2' }}>{code}</code>
        </p>
        {message && (
          <p style={{ fontFamily: F.mono, fontSize: 12, color: '#5a6478', margin: '0 0 20px', wordBreak: 'break-word' }}>{message}</p>
        )}
        <p style={{ fontSize: 14, lineHeight: 1.6, color: '#8b95a8', margin: '0 0 20px' }}>
          Your existing data has not been changed. Download a raw backup of your
          legacy keys before doing anything else.
        </p>
        <button onClick={downloadLegacyBackup} style={{
          background: '#7dd3fc', color: '#070b14', border: 'none', borderRadius: 8,
          padding: '12px 18px', fontSize: 14, fontWeight: 600, fontFamily: F.body, cursor: 'pointer',
        }}>
          Download my data (JSON)
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   APP
   ============================================================ */
export default function App() {
  useFonts();
  const [theme, setTheme] = useState('dark');
  const [user, setUser] = useState(null);
  const [view, setView] = useState('board');
  const [editing, setEditing] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [otherTabChanged, setOtherTabChanged] = useState(false);
  const [notice, setNotice] = useState(null);
  const [filters, setFilters] = useState({ search: '', tags: [], overdueOnly: false });
  // 'idle' = GIS not loaded yet (fresh device, no traffic); 'loading' = connect
  // in flight; 'ready' = GIS up; 'failed' = GIS couldn't load (ad-blocker/offline).
  const [gisStatus, setGisStatus] = useState('idle');
  // Drive sync: device-local enable toggle + a mirror of the controller's status.
  // The controller is the source of truth; these only reflect it for the UI.
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [syncStatus, setSyncStatus] = useState(() => driveSync?.getStatus().status ?? 'synced');
  const [collisionBusy, setCollisionBusy] = useState(false);
  // Live spine (MCP) connection — the first-light demo. `spineModel` holds the
  // last polled { columns, cards, flags } while an MCP provider is active (else
  // null); `spineState` mirrors the controller's connection state for the chip.
  // Both stay null on a purely-local board, so nothing here is reached unless a
  // kanbantt_config MCP target is set.
  const [spineModel, setSpineModel] = useState(null);
  const [spineState, setSpineState] = useState(null);
  // MOCK_EVENTS no longer renders; the Calendar/Timeline overlay plumbing stays
  // wired to this empty list as an attachment point for real Google Calendar
  // integration (see MOCK_EVENTS above).
  const events = [];

  // Board data comes exclusively from the card store via useSyncExternalStore.
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const columns = snapshot.columns;
  const tags = snapshot.tags;
  // Cards -> task shape the views speak; live only, sorted by canonical order.
  const tasks = useMemo(
    () => snapshot.cards.filter((c) => !c.deleted_at).slice().sort(compareCards).map(cardToTask),
    [snapshot],
  );

  // Live-spine board source. While an MCP provider is active, the board renders
  // the polled spine model in place of the local store — a READ-ONLY mirror
  // (writes are gated below; the next poll is the source of truth). Spine Tasks
  // carry no board tags or dates, so map them to the view's task shape with
  // neutral display defaults (today's date keeps cards out of a false "overdue").
  const mcpActive = !!(spineState && spineState.provider === 'mcp' && spineModel);
  const spineTasks = useMemo(() => {
    if (!spineModel) return null;
    const today = iso(new Date());
    return spineModel.cards
      .filter((c) => !c.deleted_at)
      .map((c) => ({
        ...c,
        status: c.column_id, // same column_id→status alias cardToTask applies
        description: c.description || '',
        startDate: c.startDate || today,
        dueDate: c.dueDate || c.due || today, // spec Card uses `due`; local uses `dueDate`
        effort: c.effort,
        impact: c.impact,
        priority: c.priority || 'med',
        tags: c.tags || [],
        checklist: c.checklist || [],
      }));
  }, [spineModel]);
  const activeColumns = mcpActive ? spineModel.columns : columns;
  const activeTags = mcpActive ? NO_TAGS : tags;
  const baseTasks = mcpActive ? spineTasks : tasks;

  // Theme + sync toggle are device-local; load them on mount (and purge the
  // retired session key). Board data does NOT come from here — the store owns it.
  useEffect(() => {
    (async () => {
      await safeDelete(K_SESSION);
      const th = await safeGet(K_THEME, 'dark');
      if (th && THEMES[th]) setTheme(th);
      const se = await safeGet(K_SYNC, true);
      setSyncEnabled(se !== false); // default on; only an explicit `false` disables
    })();
  }, []);

  // Stamp the build into the tab title (Kanbantt · v{version}+{commit}).
  useEffect(() => { document.title = BUILD_STAMP; }, []);

  // Surface a sync time whenever the store changes (drives the Settings readout).
  useEffect(() => { if (snapshot.seq > 0) setLastSync(Date.now()); }, [snapshot]);

  // Cross-tab tripwire: another tab wrote the blob. Non-blocking notice only —
  // no rehydration logic (multi-tab sync is out of scope).
  useEffect(() => {
    const onStorage = (e) => { if (e.key === STORAGE_KEY) setOtherTabChanged(true); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    initAuth(import.meta.env.VITE_GOOGLE_CLIENT_ID, {
      onChange: ({ user, signedIn }) => {
        if (signedIn && user) {
          const label = user.name || user.email || 'You';
          setUser({
            name: user.name || user.email || 'Google user',
            email: user.email || '',
            initials: label.split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'G',
          });
        } else {
          setUser(null);
        }
      },
    })
      // Returning device loaded GIS for the silent re-acquire => 'ready'. Fresh
      // device loaded nothing => stays 'idle' (still clickable). GIS load failure
      // on a returning device => 'failed' (Connect renders disabled).
      .then(() => setGisStatus(isGisReady() ? 'ready' : 'idle'))
      .catch((e) => { console.error('initAuth failed:', e); setGisStatus('failed'); });
  }, []);

  // Theme is device-local; board data persists through the store, not here.
  useEffect(() => { safeSet(K_THEME, theme); }, [theme]);
  // Sync toggle is device-local config (its own key, never the blob).
  useEffect(() => { safeSet(K_SYNC, syncEnabled); }, [syncEnabled]);

  // Mirror the controller's status into React for the chip/Settings (read-only).
  // Initial value comes from the lazy useState init; we subscribe before the
  // controller can change status (start() runs in a later effect), so no update
  // is missed and we avoid a synchronous setState in the effect body.
  useEffect(() => driveSync ? driveSync.subscribeStatus(({ status }) => setSyncStatus(status)) : undefined, []);

  // Sync lifecycle. Signed in AND enabled => start the controller and wire the
  // focus read + the best-effort lifecycle flush (visibilitychange/pagehide,
  // keepalive, as the controller implements). Otherwise dispose: stop all I/O and
  // timers, leaving local data untouched. This runs in an effect (post-render), so
  // it NEVER gates or blocks the board, which already rendered from local-first.
  useEffect(() => {
    if (!driveSync) return undefined;
    if (user && syncEnabled) {
      driveSync.start();
      const onFocus = () => driveSync.onFocus();
      window.addEventListener('focus', onFocus);
      const removeFlush = driveSync.installLifecycleFlush();
      return () => { window.removeEventListener('focus', onFocus); removeFlush(); };
    }
    driveSync.dispose();
    return undefined;
  }, [user, syncEnabled]);

  // First-light demo: stand up the live spine connection from kanbantt_config.
  // Runs once on mount, AFTER the local-first board has already painted from the
  // store — so a missing or unreachable spine never blanks the board. The
  // controller auto-detects: reachable + valid caps → MCP provider + polling
  // (applyModel repaints the board every tick); otherwise it degrades to Local
  // and we keep showing local data. No spine target configured → no-op.
  useEffect(() => {
    const config = readKanbanttConfig();
    if (!hasMcpTarget(config)) return undefined;
    // Lazy-load the connection module (and the MCP SDK it pulls in) only when a
    // spine target is configured — keeps the SDK out of the default bundle.
    let conn = null;
    let unsub = () => {};
    let disposed = false;
    import('./lib/mcp-connection.js')
      .then(({ createMcpConnectionFromConfig }) => {
        if (disposed) return;
        conn = createMcpConnectionFromConfig({ config, applyModel: setSpineModel });
        unsub = conn.subscribe((st) => {
          setSpineState(st);
          if (st.provider !== 'mcp') setSpineModel(null); // degrade → revert to local
        });
        conn.connect();
      })
      .catch((e) => { console.error('MCP connection load failed:', e); });
    return () => { disposed = true; unsub(); if (conn) conn.disconnect(); };
  }, []);

  // Connect: loads GIS on demand (first Google traffic, inside the click), then
  // runs interactive sign-in. A GIS load failure flips the control to disabled;
  // a user-dismissed popup leaves it ready to retry.
  const handleConnect = async () => {
    setGisStatus('loading');
    try {
      await signIn();
      setGisStatus('ready');
    } catch (e) {
      console.error('Connect failed:', e);
      setGisStatus(isGisReady() ? 'ready' : 'failed');
    }
  };
  const handleSignOut = async () => {
    await signOut();
    setUser(null);
  };

  /* ---- Drive sync triggers + collision resolution ----------------------- */
  const handleSyncNow = () => driveSync?.syncNow();
  // 401 reconnect affordance: re-acquire a token interactively, then re-sync.
  const handleReconnect = async () => {
    await handleConnect();
    driveSync?.syncNow();
  };
  const handleResolveCollision = async (choice) => {
    if (!driveSync) return;
    setCollisionBusy(true);
    try {
      await driveSync.resolveCollision(choice);
      // Disconnect is also a local "sync off" — reflect it in the device toggle.
      if (choice === 'disconnect') setSyncEnabled(false);
    } finally {
      setCollisionBusy(false);
    }
  };

  const openNew = () => {
    const t = new Date();
    const defaultStatus = columns.find((c) => c.id === 'todo')?.id || columns[0]?.id || 'todo';
    setEditing({
      id: 'new', title: '', description: '', status: defaultStatus,
      startDate: iso(t), dueDate: iso(addDays(t, 3)),
      priority: 'med', tags: [], checklist: [],
    });
    setIsNew(true);
  };
  const openEdit = (task) => {
    setEditing(task);
    setIsNew(false);
  };
  /* ---- mutation plumbing ------------------------------------------------ */
  const surface = (msg) => setNotice(msg);
  const lastOrderOf = (columnId, excludeId) => {
    const inCol = liveColumnCards(getSnapshot(), columnId, excludeId);
    return inCol.length ? inCol[inCol.length - 1].order : null;
  };

  // Spec conflict protocol: try the op; on `conflict`, inspect meta.current —
  // a tombstone drops the change with a notice, otherwise reapply ONCE onto the
  // fresh version; a second conflict surfaces. Never recreate a card.
  const withConflict = (attempt) => {
    try { attempt(); return; }
    catch (e) {
      if (e?.code !== 'conflict') { console.error(e); surface('Something went wrong'); return; }
      if (e.meta?.current?.deleted_at) { surface('That card was deleted'); return; }
      try { attempt(); }
      catch (e2) {
        if (e2?.code === 'conflict') { surface('Edit conflicted — please try again'); return; }
        console.error(e2); surface('Something went wrong');
      }
    }
  };

  const saveTask = (task) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    if (!task.title.trim()) return;
    if (isNew) {
      const { id, status, ...rest } = task; // drop the 'new' placeholder id + status alias
      store.create({ ...rest, column_id: status });
    } else {
      withConflict(() => {
        const cur = store.get(task.id);
        if (!cur || cur.deleted_at) { surface('That card was deleted'); return; }
        // Content via update (minimal patch); column change via move.
        const patch = diffPatch(cur, task);
        let version = cur.version;
        if (Object.keys(patch).length) {
          version = store.update(task.id, patch, { expected_version: version }).version;
        }
        if (task.status && task.status !== cur.column_id) {
          const order = orderBetween(lastOrderOf(task.status, task.id), null);
          store.move(task.id, { column_id: task.status, order }, { expected_version: version });
        }
      });
    }
    setEditing(null);
  };

  const deleteTask = (id) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    withConflict(() => {
      const cur = store.get(id);
      if (!cur) return;
      if (cur.deleted_at) { surface('That card was deleted'); return; }
      store.delete(id, { expected_version: cur.version });
    });
    setEditing(null);
  };

  const quickAdd = (colId, title) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    const t = new Date();
    store.create({
      title, description: '', column_id: colId,
      startDate: iso(t), dueDate: iso(addDays(t, 3)),
      priority: 'med', tags: [], checklist: [],
    });
  };

  // Drag-and-drop. Mint the order from the drop neighbors (with null-neighbor
  // cases: empty column, drop-before-first, append-to-end) and move().
  const moveTask = (draggedId, target) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    withConflict(() => {
      const dragged = store.get(draggedId);
      if (!dragged || dragged.deleted_at) { surface('That card was deleted'); return; }
      const snap = getSnapshot();
      let columnId;
      let order;
      if (target.type === 'card') {
        const targetCard = snap.cards.find((c) => c.id === target.id && !c.deleted_at);
        if (!targetCard) return;
        columnId = targetCard.column_id;
        const colCards = liveColumnCards(snap, columnId, draggedId);
        const tIdx = colCards.findIndex((c) => c.id === target.id);
        const prev = tIdx > 0 ? colCards[tIdx - 1] : null; // insert before target
        order = orderBetween(prev ? prev.order : null, targetCard.order);
      } else {
        columnId = target.id;
        const colCards = liveColumnCards(snap, columnId, draggedId);
        const last = colCards.length ? colCards[colCards.length - 1] : null;
        order = orderBetween(last ? last.order : null, null); // append to end
      }
      store.move(draggedId, { column_id: columnId, order }, { expected_version: dragged.version });
    });
  };

  /* ---- board config (columns + tags) via the store --------------------- */
  // Every board-config mutation routes through a card-store method that owns the
  // integrity invariants (orphan-move on column delete, tag ref-strip on tag
  // delete). The app no longer computes replacement columns/tags arrays itself;
  // it only mints ids and picks the next accent/hue (UI palette concerns) before
  // handing the change to the store.
  const createTag = (tag) => store.tagCreate(tag);

  const addColumn = (label) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    const id = `col-${uid('').slice(2, 8)}`;
    const accentKey = COLUMN_ACCENTS[columns.length % COLUMN_ACCENTS.length];
    store.columnCreate({ id, label: trimmed, accentKey });
  };
  const renameColumn = (id, label) => store.columnUpdate(id, { label });
  const recolorColumn = (id, accentKey) => {
    // Explicit accent from the palette picker; fall back to cycling when omitted.
    let next = accentKey;
    if (!next || !COLUMN_ACCENTS.includes(next)) {
      const cur = columns.find((c) => c.id === id);
      const idx = COLUMN_ACCENTS.indexOf(cur?.accentKey);
      next = COLUMN_ACCENTS[(idx + 1) % COLUMN_ACCENTS.length];
    }
    store.columnUpdate(id, { accentKey: next });
  };
  const reorderColumn = (id, direction) => {
    const idx = columns.findIndex((c) => c.id === id);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= columns.length) return;
    store.columnReorder(id, target);
  };
  const deleteColumn = (id) => {
    // Guard mirrors the disabled delete control: the last column can't be deleted,
    // and we never call with a null destination. The store moves orphaned cards.
    if (columns.length <= 1) return;
    const fallback = columns.find((c) => c.id !== id).id;
    store.columnDelete(id, fallback);
  };

  const renameTag = (id, name) => store.tagUpdate(id, { name });
  const recolorTag = (id, color) => {
    // Explicit hue from the palette picker; fall back to cycling when omitted.
    let next = color;
    if (!next || !TAG_PALETTE[next]) {
      const cur = tags.find((t) => t.id === id);
      const idx = TAG_COLOR_CYCLE.indexOf(cur?.color);
      next = TAG_COLOR_CYCLE[(idx + 1) % TAG_COLOR_CYCLE.length];
    }
    store.tagUpdate(id, { color: next });
  };
  const deleteTag = (id) => store.tagDelete(id); // store strips refs (live + tombstoned)
  const addTag = (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = `tag-${uid('').slice(2, 8)}`;
    const color = TAG_COLOR_CYCLE[tags.length % TAG_COLOR_CYCLE.length];
    store.tagCreate({ id, name: trimmed, color });
  };

  const classifyTask = (taskId, update) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    withConflict(() => {
      const cur = store.get(taskId);
      if (!cur || cur.deleted_at) { surface('That card was deleted'); return; }
      const patch = {};
      if ('effort' in update) patch.effort = update.effort; // undefined => unset
      if ('impact' in update) patch.impact = update.impact;
      store.update(taskId, patch, { expected_version: cur.version });
    });
  };

  // Apply filters over the active board source (local store, or the live spine
  // model while MCP is active).
  const filteredTasks = useMemo(() => {
    return baseTasks.filter((t) => {
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const tagNames = (t.tags || [])
          .map((id) => activeTags.find((tag) => tag.id === id)?.name || '')
          .join(' ');
        const checklistText = (t.checklist || []).map((c) => c.text).join(' ');
        const hay = `${t.title} ${t.description || ''} ${tagNames} ${checklistText}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filters.tags.length) {
        if (!filters.tags.some((tagId) => (t.tags || []).includes(tagId))) return false;
      }
      if (filters.overdueOnly && !isOverdue(t)) return false;
      return true;
    });
  }, [baseTasks, activeTags, filters]);

  const C = THEMES[theme];

  // Spike escape hatch: ?spike=1 renders the throwaway MCP harness and nothing
  // else (bypasses auth too). Placed after all hooks to respect their rules.
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('spike') === '1') {
    return (
      <Suspense fallback={<div style={{ padding: 32, fontFamily: 'monospace', color: '#e4e9f2', background: '#070b14', minHeight: '100vh' }}>loading spike…</div>}>
        <McpSpike />
      </Suspense>
    );
  }

  // Migration / schema_unsupported failure: a visible error state with one
  // action (download legacy data). Never a blank or default board. Shown ahead
  // of auth because the failure is about local data, not the Google session.
  if (bootError) {
    return <BootError code={bootError.code} message={bootError.message} />;
  }

  // Local-first: the board renders for everyone. Google is an optional
  // connection surfaced in the header / Settings, not a gate. (?spike=1 and the
  // boot-error screen above still take precedence.)
  return (
    <ThemeContext.Provider value={C}>
      <div style={{
        minHeight: '100vh', background: C.bg,
        fontFamily: F.body, color: C.text,
        backgroundImage: `radial-gradient(circle at 20% 0%, ${C.surface}66 0%, transparent 50%)`,
      }}>
        {(otherTabChanged || notice) && (
          <div style={{
            position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
            zIndex: 200, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center',
          }}>
            {notice && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                background: C.surfaceHi, border: `1px solid ${C.coral}55`, borderRadius: 8,
                fontSize: 13, color: C.text, boxShadow: C.shadow,
              }}>
                {notice}
                <button onClick={() => setNotice(null)} style={{
                  background: 'transparent', border: 'none', color: C.textMuted, cursor: 'pointer', padding: 0, display: 'flex',
                }}><X size={14} strokeWidth={1.75} /></button>
              </div>
            )}
            {otherTabChanged && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                background: C.surfaceHi, border: `1px solid ${C.borderHi}`, borderRadius: 8,
                fontSize: 13, color: C.textMuted, boxShadow: C.shadow,
              }}>
                Board changed in another tab — reload to sync.
                <button onClick={() => setOtherTabChanged(false)} style={{
                  background: 'transparent', border: 'none', color: C.textMuted, cursor: 'pointer', padding: 0, display: 'flex',
                }}><X size={14} strokeWidth={1.75} /></button>
              </div>
            )}
          </div>
        )}
        <Header view={view} setView={setView} user={user}
          onSignOut={handleSignOut} onConnect={handleConnect} gisStatus={gisStatus}
          onNewTask={openNew} onOpenSettings={() => setShowSettings(true)}
          theme={theme} setTheme={setTheme}
          syncEnabled={syncEnabled} syncStatus={syncStatus}
          onSyncNow={handleSyncNow} onReconnect={handleReconnect}
          spineState={spineState} />
        <FilterBar tags={activeTags} filters={filters} setFilters={setFilters} />
        {view === 'board' && (
          <BoardView tasks={filteredTasks} tags={activeTags} columns={activeColumns}
            onTaskClick={openEdit} onMove={moveTask} onQuickAdd={quickAdd} />
        )}
        {view === 'calendar' && (
          <CalendarView tasks={filteredTasks} events={events} columns={activeColumns} onTaskClick={openEdit} />
        )}
        {view === 'gantt' && (
          <GanttView tasks={filteredTasks} events={events} columns={activeColumns} onTaskClick={openEdit} />
        )}
        {view === 'matrix' && (
          <MatrixView tasks={filteredTasks} tags={activeTags}
            onTaskClick={openEdit} onClassify={classifyTask} />
        )}
        {editing && (
          <TaskModal task={editing} tags={activeTags} columns={activeColumns} isNew={isNew}
            onSave={saveTask} onDelete={deleteTask}
            onClose={() => setEditing(null)} onCreateTag={createTag} />
        )}
        {showSettings && (
          <SettingsModal columns={columns} tags={tags} tasks={tasks}
            user={user} onSignOut={() => { setShowSettings(false); handleSignOut(); }}
            onConnect={() => { setShowSettings(false); handleConnect(); }} gisStatus={gisStatus}
            lastSync={lastSync}
            onClose={() => setShowSettings(false)}
            onAddColumn={addColumn} onRenameColumn={renameColumn}
            onRecolorColumn={recolorColumn} onReorderColumn={reorderColumn}
            onDeleteColumn={deleteColumn}
            onAddTag={addTag} onRenameTag={renameTag}
            onRecolorTag={recolorTag} onDeleteTag={deleteTag}
            syncEnabled={syncEnabled} onToggleSync={setSyncEnabled}
            syncStatus={syncStatus} onSyncNow={handleSyncNow} />
        )}
        {driveSync && syncStatus === 'collision_pending' && (
          <CollisionDialog onResolve={handleResolveCollision} busy={collisionBusy} />
        )}
      </div>
    </ThemeContext.Provider>
  );
}
