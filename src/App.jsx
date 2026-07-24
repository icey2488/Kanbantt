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
  Archive,
  ArchiveRestore,
  Cpu,
} from 'lucide-react';
import { initAuth, signIn, signOut, isGisReady } from './lib/auth.js';
import { driveSync } from './lib/sync-instance.js';
import { store, bootError, subscribe, getSnapshot, readLegacyDump, STORAGE_KEY } from './lib/store-instance.js';
import { orderBetween, compareCards } from './lib/card-store.js';
import { readKanbanttConfig, hasMcpTarget } from './lib/spine-config.js';
import { snapBackCards, failureTruth } from './lib/spine-snapback.js';
import { createdAtLabel, isOverdue } from './lib/date-chip.js';
import { readProvenance } from './lib/provenance.js';
import { formatModelLabel, provenanceChipTreatment } from './lib/model-label.js';

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
    // Matrix quadrant fills (light only): the shared QUADRANT_DEFS.tintAlpha values
    // read as near-white on this theme's near-white bg — too faint to separate the
    // four quadrants from the page or each other. Bumped here (not in QUADRANT_DEFS,
    // which stays the dark-theme default) so hue semantics are untouched.
    quadrantTintAlpha: { avoid: '30', plan: '28', deprioritize: '38', do: '30' },
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
    // Matrix quadrant fills (mist only): see light theme's quadrantTintAlpha note —
    // same faintness against mist's mid-gray bg, bumped a bit further since the
    // page itself is more saturated than light's near-white.
    quadrantTintAlpha: { avoid: '3d', plan: '33', deprioritize: '47', do: '3d' },
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
// 3x3-aware effort x impact -> quadrant. Effort's gate is STRICT (only 'low' counts
// as cheap enough for a quick win); impact's gate is LENIENT ('med' already counts as
// worth doing). So low-effort/med-impact reads as 'do' (cheap enough to just ship),
// while med-effort/high-impact reads as 'plan' (valuable but no longer a quick win).
const EFFORT_IMPACT_QUADRANT = {
  low: { low: 'deprioritize', med: 'do', high: 'do' },
  med: { low: 'avoid', med: 'plan', high: 'plan' },
  high: { low: 'avoid', med: 'plan', high: 'plan' },
};
const getQuadrant = (task) => {
  // Spec: effort/impact are `low | med | high | null`; a live spine card carries
  // explicit null (not an absent key) when unclassified — treat null and undefined
  // as the same "not yet classified" state.
  if (task.effort == null) return 'unsorted';
  const impact = getImpact(task);
  return EFFORT_IMPACT_QUADRANT[task.effort][impact];
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
// Top-level view tab (Board/Calendar/Timeline/Matrix): same pattern as Calendar's
// K_CAL_VIEW and Timeline's K_TIMELINE_VIEW sub-mode persistence.
const K_VIEW = 'kanbantt:view:v1';

const safeGet = async (key, fallback) => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
};
const safeSet = async (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* swallow */ }
};
const safeDelete = async (key) => {
  try { localStorage.removeItem(key); } catch { /* swallow */ }
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
// MCP active → mint "MCP: <name>"; reconnecting (mid-session or initial-load) →
// amber with "retry now" affordance; graceful fallback → amber "Local (MCP
// unavailable)"; server-reachable (pending local-edit switch) → amber "switch?";
// clean local → dim. Rendered only when a spine target is configured.
function SpineChip({ state, onRetryNow }) {
  const C = useTheme();
  const narrow = useNarrow();
  if (!state) return null;
  const active = state.provider === 'mcp';
  const reconnecting = !!state.reconnecting;
  const serverReachable = !!state.serverReachable;
  const fallback = !!state.fallback;
  const isAuthRejected = fallback && !!(state.error && state.error.code === 'auth');
  // Amber when: mid-session reconnecting, initial-load retrying, server-reachable prompt
  // Coral when: auth rejected (credential failure — distinct from unreachable)
  const isAmber = !isAuthRejected && ((active && reconnecting) || (!active && (fallback || serverReachable)));
  const tint = active && !reconnecting ? C.mint : isAuthRejected ? C.coral : isAmber ? C.amber : C.textDim;
  const Icon = reconnecting ? RefreshCw : active ? Cloud : (fallback || serverReachable) ? AlertTriangle : Cloud;
  // "retry now" appears during any retry-loop state (mid-session reconnecting, initial-load
  // retrying, or auth-rejected — auth-rejected retry is explicit-only, never auto).
  const canRetry = (reconnecting || (fallback && !serverReachable)) && onRetryNow;
  const chipTitle = isAuthRejected
    ? 'Spine rejected the token. Re-enter it in Connection settings.'
    : state.error ? `${state.error.code}: ${state.error.message}` : state.indicator;
  return (
    <span title={chipTitle}
      style={{
        display: 'flex', alignItems: 'center', gap: narrow ? 0 : 6, padding: '5px 9px',
        background: `${tint}1f`, border: `1px solid ${tint}55`, borderRadius: 8,
        color: C.text, fontFamily: F.mono, fontSize: 10, letterSpacing: '0.06em',
        textTransform: 'uppercase', whiteSpace: 'nowrap',
      }}>
      <Icon size={12} strokeWidth={2} color={tint} style={reconnecting ? { animation: 'spin 1.5s linear infinite' } : undefined} />
      {!narrow && state.indicator}
      {canRetry && (
        <button onClick={(e) => { e.stopPropagation(); onRetryNow(); }}
          style={{
            background: 'transparent', border: `1px solid ${tint}88`, borderRadius: 4,
            color: tint, padding: '1px 6px', cursor: 'pointer', fontFamily: 'inherit',
            fontSize: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit', marginLeft: 4,
          }}>retry</button>
      )}
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

function Header({ view, setView, user, onSignOut, onConnect, gisStatus, onNewTask, onOpenSettings, theme, setTheme, syncEnabled, syncStatus, onSyncNow, onReconnect, spineState, onSpineRetry, canCreate }) {
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
        <SpineChip state={spineState} onRetryNow={onSpineRetry} />
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
        {/* New task (the full modal create) — shown only in local mode (canCreate).
            Hidden on ANY live spine: a read-only mirror can't write, and on a
            writable spine board creates are the title-only QUICK-ADD on the intake
            column (human intake — see createTaskMcp), not this richer modal. */}
        {canCreate && (
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
        )}
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
function FilterBar({ tags, filters, setFilters, showArchived, onToggleShowArchived }) {
  const C = useTheme();
  const narrow = useNarrow();
  // Narrow folds the inline tag chips into a single button + popover (see below);
  // this drives that popover's open state. Desktop never reads it.
  const [tagPopupOpen, setTagPopupOpen] = useState(false);
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
  const clearTags = () => setFilters((f) => ({ ...f, tags: [] }));
  const hasTags = filters.tags.length > 0;

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

      {narrow ? (
        /* Narrow: the inline chips overflow and don't scroll cleanly on a phone,
           so collapse them into a single Tags button. The old '#' (Hash) label
           folds into this button's icon. An accent state + count badge keep the
           applied filter visible at a glance while the chips are hidden. */
        <>
          <button
            onClick={() => setTagPopupOpen((o) => !o)}
            aria-label="Filter by tag"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
              fontFamily: F.mono, fontSize: 10, letterSpacing: '0.08em',
              textTransform: 'uppercase',
              background: hasTags ? `${C.ice}22` : 'transparent',
              border: `1px solid ${hasTags ? `${C.ice}55` : C.border}`,
              color: hasTags ? C.ice : C.textMuted,
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            <Hash size={11} strokeWidth={1.75} />
            Tags
            {hasTags && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minWidth: 15, height: 15, padding: '0 4px', borderRadius: 999,
                background: C.ice, color: C.bg,
                fontFamily: F.mono, fontSize: 9, fontWeight: 700, lineHeight: 1,
              }}>{filters.tags.length}</span>
            )}
          </button>
          {tagPopupOpen && (
            <>
              {/* Backdrop: catches outside taps and dims, mirroring the month picker. */}
              <div onClick={() => setTagPopupOpen(false)} style={{
                position: 'fixed', inset: 0, background: C.modalBackdrop,
                backdropFilter: 'blur(4px)', zIndex: 100,
              }} />
              {/* Card: centered sheet. The trigger sits right-of-center in a tight
                  row, so a dropdown anchored to it would clip off-screen on a phone;
                  a centered fixed card stays fully on-screen at any width. */}
              <div style={{
                position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                width: 'min(320px, calc(100vw - 32px))', maxHeight: '70vh', overflowY: 'auto',
                zIndex: 101, background: C.surface, border: `1px solid ${C.borderHi}`,
                borderRadius: 12, padding: 16, boxShadow: C.shadow,
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginBottom: 14,
                }}>
                  <span style={{
                    fontFamily: F.mono, fontSize: 11, letterSpacing: '0.08em',
                    textTransform: 'uppercase', color: C.textMuted,
                  }}>Filter by tag</span>
                  {hasTags && (
                    <button onClick={clearTags} style={{
                      background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                      fontFamily: F.mono, fontSize: 10, letterSpacing: '0.08em',
                      textTransform: 'uppercase', color: C.ice,
                    }}>Clear</button>
                  )}
                </div>
                {tags.length === 0 ? (
                  <div style={{ fontFamily: F.body, fontSize: 13, color: C.textDim, padding: '6px 0' }}>
                    No tags yet.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {tags.map((tag) => (
                      <TagChip
                        key={tag.id}
                        tag={tag}
                        size="md"
                        active={filters.tags.includes(tag.id)}
                        onClick={() => toggleTag(tag.id)}
                      />
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button onClick={() => setTagPopupOpen(false)} style={{
                    padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
                    fontFamily: F.mono, fontSize: 11, letterSpacing: '0.06em',
                    textTransform: 'uppercase', background: C.surfaceHi,
                    border: `1px solid ${C.border}`, color: C.text,
                  }}>Done</button>
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        <div style={{
          display: 'flex', gap: 5, flexWrap: 'nowrap', overflowX: 'auto',
          flex: 1, alignItems: 'center',
          // Same rationale as Timeline's day-grid pane: with enough tags this row's
          // nowrap chips can need more width than the bar has, and overflowX:auto
          // is what makes that scroll internally instead of widening the page.
          // contain:inline-size keeps that intrinsic width from counting toward
          // #root's min-width:max-content (src/index.css).
          contain: 'inline-size',
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
      )}

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

      {/* Show Archived (spec v0.4.0): a VIEW MODE toggle, not a filter — it admits
          archived cards into the shared filteredTasks pipeline (one seam, all views).
          Rendered only when the parent wires it (an MCP board; local cards carry no
          archived_at), default OFF. Deliberately not counted in activeCount / not
          reset by Clear: clearing filters shouldn't silently flip a visibility mode. */}
      {onToggleShowArchived && (
        <button
          onClick={onToggleShowArchived}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
            fontFamily: F.mono, fontSize: 10, letterSpacing: '0.08em',
            textTransform: 'uppercase',
            background: showArchived ? `${C.ice}22` : 'transparent',
            border: `1px solid ${showArchived ? `${C.ice}55` : C.border}`,
            color: showArchived ? C.ice : C.textMuted,
            whiteSpace: 'nowrap',
          }}
        >
          <Archive size={11} strokeWidth={1.75} />
          Archived
        </button>
      )}

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
function TaskCard({ task, tags, onClick, onDragStart, onDragOver, onDrop, onDragEnd, isDragging, dropIndicator, onMoveRequest, readOnly, allTasks }) {
  const C = useTheme();
  const hasDue = task.dueDate != null;
  const due = hasDue ? startOfDay(new Date(task.dueDate)) : null;
  const now = startOfDay(new Date());
  const daysOut = hasDue ? Math.round((due - now) / 86400000) : null;
  const overdue = hasDue && daysOut < 0 && task.status !== 'done';

  let dueLabel = null;
  if (hasDue) {
    dueLabel = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (daysOut === 0) dueLabel = 'Today';
    else if (daysOut === 1) dueLabel = 'Tomorrow';
    else if (daysOut === -1) dueLabel = 'Yesterday';
  }
  const createdLabel = task.created_at ? createdAtLabel(task.created_at) : null;
  // Dispatch provenance (spec v0.7.0): a QUIET model+effort chip rendered ONLY when the
  // card carries it (agent mints). Human/local cards → null → no chip (never an empty
  // pill, never "unknown"). Lives inside created_by, so it can't collide with the card's
  // own effort/impact Matrix axes. Read-only — the mint stamp is immutable.
  const provenance = readProvenance(task.created_by);
  // Vendor-keyed chip color (design: orange = this stack minted it, slate = a
  // foreign/unrecognized MCP caller did — see CHIP_COLORS and provenanceChipTreatment).
  // Both tokens are opaque per-theme hues already computed to clear 4.5:1 against
  // C.surface (see the CHIP_COLORS block comment); effort-only provenance (no model
  // to key a vendor off of) keeps the prior neutral C.textDim treatment unchanged.
  const cc = CHIP_COLORS[C.name] || CHIP_COLORS.Dark;
  const provenanceTreatment = provenance ? provenanceChipTreatment(provenance.model) : null;
  const provenanceColor = provenanceTreatment === 'anthropic' ? cc.orange.text
    : provenanceTreatment === 'foreign' ? cc.slate.text
    : C.textDim;

  const priorityColor = C[PRIORITY[task.priority].key];
  const taskTags = (task.tags || []).map((id) => tags.find((t) => t.id === id)).filter(Boolean);
  const checklist = task.checklist || [];
  const checklistDone = checklist.filter((c) => c.done).length;
  const hasChecklist = checklist.length > 0;
  // Matrix quadrant symbol (display-only) — a plain icon+label pair, deliberately
  // NOT a pill/badge like the escalation marker above, so it never competes with
  // that reserved styling. Omitted entirely while unclassified (no effort set).
  const quadrant = getQuadrant(task);
  const qDef = quadrant === 'unsorted' ? null : QUADRANT_DEFS[quadrant];
  // E1/E2: a per-card escalation badge from card_list. Gated PURELY on the badge
  // data — NOT featureFlags.escalations (display is decoupled from the list/resolve
  // tools). Three states drive the pill: 'unresolved' → amber "Escalated" (needs a
  // human); 'denied' → RED "Denied" (the ghost-worker kill-signal); approved → no
  // badge at all (the card carries none). Display only here; the modal acts on it.
  const badge = task.badge && task.badge.kind === 'escalation' ? task.badge : null;
  const escalated = !!badge;
  const denied = !!badge && badge.status === 'denied';

  // depends_on badge: "waiting on N" with tooltip listing dep titles.
  const deps = task.depends_on || [];
  const depInfos = deps.map((id) => {
    const dep = (allTasks || []).find((t) => t.id === id);
    return { id, dep };
  });

  // Long-press → move (narrow board ONLY). These Pointer Event handlers attach only
  // when BoardView passes onMoveRequest; Matrix and desktop omit it, so nothing is
  // wired and tap/drag behave exactly as before. We never call preventDefault on
  // move, so native horizontal-snap + vertical scrolling are untouched — we only
  // watch displacement and bail if the finger is really scrolling.
  const pressTimer = useRef(null);
  const pressStart = useRef(null);
  const clearPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
  };
  useEffect(() => () => clearPress(), []); // cancel a pending timer on unmount
  const handlePointerDown = (e) => {
    pressStart.current = { x: e.clientX, y: e.clientY };
    clearPress();
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(10);
      // Swallow the single click the browser synthesizes from this same press so it
      // neither re-opens the edit modal (click on the card) nor lands on the picker
      // that's about to mount (click hit-tested onto the overlay). Capture-phase +
      // once fires before React's handlers; the timeout removes it if, on some
      // browser, no click is synthesized at all.
      if (typeof document !== 'undefined') {
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        document.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 500);
      }
      onMoveRequest(task);
    }, 450);
  };
  const handlePointerMove = (e) => {
    if (!pressTimer.current || !pressStart.current) return;
    // Past the slop → it's a scroll, not a press. Cancel; let the browser scroll.
    if (Math.abs(e.clientX - pressStart.current.x) > 10 ||
        Math.abs(e.clientY - pressStart.current.y) > 10) clearPress();
  };
  const pressHandlers = (onMoveRequest && !readOnly) ? {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: clearPress,
    onPointerCancel: clearPress,
  } : null;

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
        // Read-only mirror: kill native drag at the ATTRIBUTE level — a dragstart
        // fires off draggable="true" regardless of whether any drop target exists,
        // so leaving it on would still kick the drag machinery (ghost/throw) on a
        // card-whitespace drag or a rubber-banded text selection. Handlers are also
        // no-op'd as belt-and-suspenders. onClick stays (opens the read-only viewer).
        draggable={!readOnly}
        {...pressHandlers}
        onDragStart={readOnly ? undefined : (e) => onDragStart(e, task.id)}
        onDragOver={readOnly ? undefined : (e) => onDragOver(e, task.id)}
        onDrop={readOnly ? undefined : (e) => onDrop(e, task.id)}
        onDragEnd={readOnly ? undefined : onDragEnd}
        onClick={() => onClick(task)}
        style={{
          background: C.surface,
          border: `${overdue ? '1.5px' : '1px'} solid ${overdue ? C.coral : C.border}`,
          borderRadius: 10, padding: '10px 12px', cursor: readOnly ? 'pointer' : 'grab',
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
        <div style={{ marginBottom: 6 }}>
          {escalated && (
            // Escalation badge (display-only). Unresolved → amber "Escalated" (an
            // active block that needs a human); denied → RED "Denied" (theme coral,
            // the immediately-visible ghost-worker kill-signal). AlertTriangle pill —
            // deliberately NOT the `◆` diamond used for overdue/tier, so it never
            // reads as a tier marker. Its own row above the title, left-aligned, so
            // the title can use the full card width below it.
            <span
              title={denied
                ? `Denied — ${badge.reason || 'control change rejected'}`
                : `Escalation — ${badge.reason || 'needs human review'}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                marginBottom: 6,
                padding: '2px 6px', borderRadius: 5,
                background: `${denied ? C.coral : C.amber}1f`,
                border: `1px solid ${denied ? C.coral : C.amber}66`,
                color: denied ? C.coral : C.amber, fontFamily: F.mono, fontSize: 9, fontWeight: 700,
                letterSpacing: '0.08em', textTransform: 'uppercase',
              }}
            >
              <AlertTriangle size={10} strokeWidth={2.25} />
              {denied ? 'Denied' : 'Escalated'}
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: priorityColor, marginTop: 7, flexShrink: 0,
            }} />
            <div style={{
              fontSize: 14, fontWeight: 500, color: C.text, lineHeight: 1.4,
              textAlign: 'left', display: '-webkit-box', WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>
              {task.title}
            </div>
          </div>
        </div>
        {task.description && (
          <div style={{
            fontSize: 12, color: C.textMuted, lineHeight: 1.5,
            marginBottom: 8, marginLeft: 14,
            display: '-webkit-box', WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            <Markdown text={task.description} dim />
          </div>
        )}
        {taskTags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginLeft: 14, marginBottom: 6 }}>
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
            {hasDue && (
              <div style={{
                fontFamily: F.mono, fontSize: 10.5,
                color: overdue ? C.coral : C.textDim,
                letterSpacing: '0.05em', textTransform: 'uppercase',
                fontWeight: overdue ? 600 : 400, whiteSpace: 'nowrap',
              }}>
                {overdue ? '◆ ' : ''}{dueLabel}
              </div>
            )}
            {createdLabel && (
              // whiteSpace: nowrap matters here — "TODAY HH:MM" has a space, and a
              // flex item's automatic min-width is its min-content size, which for
              // wrappable text is the widest WORD, not the full string. In a narrow
              // column that let the row shrink this item down to one word per line
              // ("TODAY" / "03:12"). nowrap fixes the min-content size at the full
              // label so the row clips or crowds instead of ever breaking it in two.
              <div style={{
                fontFamily: F.mono, fontSize: 10.5,
                color: C.ice, letterSpacing: '0.05em', textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}>
                {createdLabel}
              </div>
            )}
            {provenance && (
              // Dispatch-provenance chip: icon + short label, flat (no border/pill/
              // background — that bordered-pill look was the layout bug, not a style to
              // preserve), same as the checklist/depends-on chips below. Its COLOR is
              // now vendor-keyed (provenanceColor, above) rather than flat textDim: this
              // stack's own Anthropic mints read as orange, any other MCP caller's model
              // string reads as slate — a glance tells you which stack minted the card.
              // Model is the primary face signal; effort only appears here as a fallback
              // when a mint carries no model, so a present-but-content-light provenance
              // still renders SOMETHING rather than an empty chip. Full model/effort/
              // actor/job_id ride the tooltip and the read-only dialog block.
              <div
                title={[
                  provenance.actor && `minted by ${provenance.actor}`,
                  provenance.model && `model ${provenance.model}`,
                  provenance.effort && `effort ${provenance.effort}`,
                  provenance.job_id && `job ${provenance.job_id}`,
                ].filter(Boolean).join(' · ')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  fontFamily: F.mono, fontSize: 10, color: provenanceColor,
                  letterSpacing: '0.04em', whiteSpace: 'nowrap',
                  maxWidth: 96, overflow: 'hidden',
                }}>
                <Cpu size={10} strokeWidth={1.75} style={{ flexShrink: 0, opacity: 0.75 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {formatModelLabel(provenance.model)
                    || (provenance.effort ? provenance.effort.charAt(0).toUpperCase() + provenance.effort.slice(1) : '')}
                </span>
              </div>
            )}
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
            {depInfos.length > 0 && (
              <div
                title={depInfos.map(({ id, dep }) =>
                  dep
                    ? (dep.status === 'done' || dep.status === 'delivered' ? `✓ ${dep.title}` : dep.title)
                    : `? ${id}`
                ).join('\n')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 3,
                  fontFamily: F.mono, fontSize: 10, color: C.textDim,
                  letterSpacing: '0.04em',
                }}>
                <span style={{ opacity: 0.7 }}>⏳</span>
                <span>waiting on {depInfos.length}</span>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {qDef && (
              <div title={`${qDef.label} — ${qDef.tagline}`} style={{
                display: 'flex', alignItems: 'center', gap: 3,
                fontFamily: F.mono, fontSize: 10, color: C[qDef.accentKey],
                letterSpacing: '0.05em',
              }}>
                <qDef.Icon size={10} strokeWidth={2} />
              </div>
            )}
            <div style={{
              fontFamily: F.mono, fontSize: 10, color: C.textDim,
              letterSpacing: '0.05em',
            }}>{PRIORITY[task.priority].label}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   QUICK ADD
   ============================================================ */
function QuickAdd({ colId, onAdd, projects }) {
  const C = useTheme();
  const [active, setActive] = useState(false);
  const [title, setTitle] = useState('');
  // Project targeting (MCP mode, spec v0.6.0 §Projects): when the spine enumerates
  // live projects the create MUST land in one — a single project auto-targets, and
  // multiple get the footer picker. Local mode passes no `projects`, so the third
  // onAdd argument stays undefined (the wire key is then omitted, never sent null).
  const targeted = Array.isArray(projects) && projects.length > 0;
  const [projectId, setProjectId] = useState(null);
  const inputRef = useRef(null);
  const boxRef = useRef(null);

  const submit = () => {
    const t = title.trim();
    if (t) onAdd(colId, t, targeted ? (projectId ?? projects[0].id) : undefined);
    setTitle('');
    setActive(false);
  };
  const cancel = () => {
    setTitle('');
    setActive(false);
  };
  // Submit-on-blur, but only when focus actually LEAVES the widget — clicking the
  // project picker moves focus within it and must not fire the half-typed create.
  const blurGuard = (e) => {
    if (e.relatedTarget && boxRef.current && boxRef.current.contains(e.relatedTarget)) return;
    if (title.trim()) submit();
    else cancel();
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
    }} ref={boxRef}>
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
        onBlur={blurGuard}
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
        {targeted && projects.length > 1 && (
          <select
            value={projectId ?? projects[0].id}
            onChange={(e) => { setProjectId(e.target.value); if (inputRef.current) inputRef.current.focus(); }}
            onBlur={blurGuard}
            title="Target project"
            style={{
              background: C.surfaceHi, color: C.textMuted, border: `1px solid ${C.border}`,
              borderRadius: 4, fontFamily: F.mono, fontSize: 9, padding: '1px 2px',
              maxWidth: 120, cursor: 'pointer',
            }}
          >
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   BOARD VIEW
   ============================================================ */
function BoardView({ tasks, tags, columns, onTaskClick, onMove, onQuickAdd, readOnly, canCreate, quickAddColumnId, quickAddProjects, sweep, allTasks }) {
  const C = useTheme();
  const narrow = useNarrow();
  const [draggedId, setDraggedId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  // Long-press → column-picker move (narrow only). `moveTask` holds the card whose
  // picker is open; selecting a column calls onMove({type:'col'}) — the SAME
  // store.move the edit-modal Status <select> triggers (append to end of target
  // column) — so we don't reinvent any move logic. Desktop never sets this (the
  // long-press handler is only wired on narrow), so its native drag is untouched.
  const [moveTask, setMoveTask] = useState(null);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    if (readOnly) return;
    e.preventDefault();
    setDropTarget({ type: 'col', id: colId });
  };
  const handleDropOnColumn = (e, colId) => {
    if (readOnly) return;
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
      display: 'grid',
      // Explicit minmax (not bare `1fr`, which the grid spec expands to
      // `minmax(auto, 1fr)`) — auto's minimum is the track's max-content, so a
      // card's nowrap metadata chips could blow the track past its 1fr share and
      // push later columns (e.g. FAILED) past the panel's right edge with no
      // scrollbar. minmax(220px, 1fr) fixes the floor explicitly, so once column
      // count * 220px exceeds the viewport the grid overflows its box instead —
      // covers a future 7th column too. NOT paired with overflowX here: any
      // overflow value on this element (or an ancestor of it) other than
      // `visible` becomes the containing scrollport for the column headers'
      // `position: sticky` below, which stick relative to the WINDOW by design
      // (see the header's own comment) — that scrollport hijack is what pushed
      // headers below their first card. Leaving overflow visible lets the
      // overflow fall through to the window's native horizontal scrollbar,
      // which any ancestor already permits (no overflow:hidden between here
      // and <body>) and never touches sticky positioning.
      gridTemplateColumns: `repeat(${columns.length}, minmax(220px, 1fr))`,
      gap: 18,
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
            {/* Sticky column header: the board scrolls on the WINDOW (App root only
                sets min-height; the grid/columns have no overflow), and Header (top:0,
                ~67px) + FilterBar (top:67, ~53px) are window-sticky above it — so the
                header pins at top:120, flush under the FilterBar, while its cards scroll
                underneath. Solid C.bg (the board's own background, same token the
                FilterBar uses, so the two blend when pinned) masks the scrolling cards;
                z-index lifts it over the position:relative TaskCards, which as later DOM
                siblings would otherwise paint on top. */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              paddingBottom: 12, paddingLeft: 6, paddingRight: 6,
              borderBottom: `1px solid ${C.border}`,
              position: 'sticky', top: 120, zIndex: 2, background: C.bg,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: C[col.accentKey] }} />
                <span style={{
                  fontFamily: F.body, fontSize: 12, fontWeight: 500,
                  color: C.text, textTransform: 'uppercase', letterSpacing: '0.12em',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{col.label}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {/* Bulk sweep "Archive all delivered" — renders ONLY in the sweep's
                    target column (the spine's delivered state) when eligible cards
                    are visible. The handler + eligibility live in the parent; this
                    is a dumb affordance gated on `sweep` (capability-derived). */}
                {sweep && col.id === sweep.columnId && sweep.count > 0 && (
                  <button onClick={sweep.onSweep} disabled={sweep.busy}
                    title={`Archive all ${sweep.count} delivered card${sweep.count === 1 ? '' : 's'}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      padding: '3px 8px', borderRadius: 5,
                      cursor: sweep.busy ? 'default' : 'pointer',
                      fontFamily: F.mono, fontSize: 9, letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      background: 'transparent', border: `1px solid ${C.border}`,
                      color: C.textMuted, whiteSpace: 'nowrap',
                      opacity: sweep.busy ? 0.5 : 1,
                    }}>
                    <Archive size={10} strokeWidth={1.75} />
                    {sweep.busy ? 'Archiving…' : 'Archive all'}
                  </button>
                )}
                <span style={{ fontFamily: F.mono, fontSize: 11, color: C.textDim }}>
                  {colTasks.length.toString().padStart(2, '0')}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {colTasks.map((t) => (
                <TaskCard key={t.id} task={t} tags={tags} onClick={onTaskClick}
                  onDragStart={handleDragStart} onDragOver={handleDragOverCard}
                  onDrop={handleDropOnCard} onDragEnd={handleDragEnd}
                  isDragging={draggedId === t.id}
                  dropIndicator={dropTarget?.type === 'card' && dropTarget.id === t.id}
                  onMoveRequest={(narrow && !readOnly) ? setMoveTask : undefined}
                  readOnly={readOnly}
                  allTasks={allTasks}
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
              {/* Quick-add is a create. Local mode: every column. On a writable
                  spine it is HUMAN INTAKE — pinned to the intake column alone
                  (quickAddColumnId, the first served column: 'created' on the
                  Claunker spine) so a board create can never enter mid-ladder,
                  and carrying the project targeting the picker resolved. Distinct
                  from the readOnly drag gate above. */}
              {canCreate && (quickAddColumnId == null || col.id === quickAddColumnId) && (
                <QuickAdd colId={col.id} onAdd={onQuickAdd} projects={quickAddProjects} />
              )}
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

    {/* Column picker — narrow only. Long-pressing a board card opens this; it mirrors
        the month/tag picker shell (backdrop + centered sheet, modal-tier z-index,
        outside-tap + Done to dismiss). Tapping a different column calls onMove — the
        same store.move the edit-modal Status <select> uses. */}
    {narrow && !readOnly && moveTask && (
      <>
        <div onClick={() => setMoveTask(null)} style={{
          position: 'fixed', inset: 0, background: C.modalBackdrop,
          backdropFilter: 'blur(4px)', zIndex: 100,
        }} />
        <div style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: 'min(340px, calc(100vw - 32px))', maxHeight: '70vh', overflowY: 'auto',
          zIndex: 101, background: C.surface, border: `1px solid ${C.borderHi}`,
          borderRadius: 12, padding: 16, boxShadow: C.shadow,
        }}>
          <div style={{ marginBottom: 14 }}>
            <span style={{
              fontFamily: F.mono, fontSize: 11, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: C.textMuted,
            }}>Move to…</span>
            <div style={{
              fontFamily: F.body, fontSize: 14, fontWeight: 500, color: C.text,
              marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>“{moveTask.title}”</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {columns.map((col) => {
              const current = col.id === moveTask.status;
              return (
                <button key={col.id}
                  onClick={() => {
                    if (!current) onMove(moveTask.id, { type: 'col', id: col.id });
                    setMoveTask(null);
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                    padding: '12px 14px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                    background: current ? `${C[col.accentKey]}1a` : C.surfaceHi,
                    border: current ? `1.5px solid ${C[col.accentKey]}` : `1px solid ${C.border}`,
                    color: C.text,
                  }}>
                  <span style={{
                    width: 9, height: 9, borderRadius: 2, flexShrink: 0,
                    background: C[col.accentKey],
                  }} />
                  <span style={{
                    flex: 1, fontFamily: F.body, fontSize: 14, fontWeight: 500,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{col.label}</span>
                  {current && <Check size={15} color={C[col.accentKey]} strokeWidth={2.5} />}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <button onClick={() => setMoveTask(null)} style={{
              padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
              fontFamily: F.mono, fontSize: 11, letterSpacing: '0.06em',
              textTransform: 'uppercase', background: C.surfaceHi,
              border: `1px solid ${C.border}`, color: C.text,
            }}>Done</button>
          </div>
        </div>
      </>
    )}
    </>
  );
}

/* ============================================================
   CALENDAR VIEW
   ============================================================ */
// Device-local calendar view preference — its own localStorage key, NOT board data
// (same pattern as theme). v0.3 layouts: month grid, week row, work-week (Mon-Fri) row,
// single-day column.
const K_CAL_VIEW = 'kanbantt:calendar-view:v1';
const CAL_LAYOUTS = [
  { id: 'month', label: 'Month' },
  { id: 'week', label: 'Week' },
  { id: 'workweek', label: 'Work Week' },
  { id: 'day', label: 'Day' },
];

// Shared day-cell chips — the SAME markup the month grid has always used, lifted into
// one place so the week / work-week day-columns reuse it verbatim (no parallel chip).
// `max` caps the list: month keeps its 3 + "+N more"; week/work-week pass Infinity to
// show the full day (the column is tall and has no expand affordance for "+N more").
// `detailed` (Day view only): a roomier task row — priority dot + tag chips below the
// title — since Day's single column has far more space per task than week/work-week.
function DayChips({ dayTasks, dayEvents, columns, onTaskClick, max = 3, tags = [], detailed = false }) {
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
          if (detailed) {
            const priorityColor = C[PRIORITY[t.priority].key];
            const taskTags = tags.filter((tag) => (t.tags || []).includes(tag.id));
            return (
              <div key={t.id} onClick={() => onTaskClick(t)} style={{
                display: 'flex', flexDirection: 'column', gap: 6,
                color: C.text, background: C.surfaceHi,
                borderLeft: `2px solid ${overdue ? C.coral : C[col.accentKey]}`,
                padding: '8px 10px', borderRadius: 5, cursor: 'pointer',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: priorityColor, flexShrink: 0,
                  }} />
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{t.title}</div>
                </div>
                {taskTags.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingLeft: 13 }}>
                    {taskTags.map((tag) => <TagChip key={tag.id} tag={tag} size="sm" />)}
                  </div>
                )}
              </div>
            );
          }
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

function CalendarView({ tasks, events, columns, onTaskClick, tags = [] }) {
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
      return v === 'week' || v === 'workweek' || v === 'day' ? v : 'month';
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
  // Day view's single visible date — normalized the same way weekStart is, so its
  // iso()-based bucketing can't drift from a stray time-of-day left on `cursor`.
  const dayDate = startOfDay(cursor);

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
  const dayLabel = dayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const title = layout === 'month'
    ? monthLabel
    : layout === 'day' ? dayLabel
    : fmtRange(weekDays[0], weekDays[weekDays.length - 1]);

  // prev/next: by one month in month view, by one day in day view, by one week in
  // week / work-week.
  const goPrev = () => setCursor(layout === 'month'
    ? new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1)
    : layout === 'day' ? addDays(cursor, -1)
    : addDays(cursor, -7));
  const goNext = () => setCursor(layout === 'month'
    ? new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    : layout === 'day' ? addDays(cursor, 1)
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
      ) : layout === 'day' ? (
        <div style={{
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 10, overflow: 'hidden', maxWidth: 480,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: C.bgGrain, padding: '10px 14px', borderBottom: `1px solid ${C.border}`,
          }}>
            <span style={{
              fontFamily: F.mono, fontSize: 10.5, letterSpacing: '0.1em',
              color: C.textMuted, textTransform: 'uppercase',
            }}>{dayDate.toLocaleDateString('en-US', { weekday: 'long' })}</span>
            <span style={{
              fontFamily: F.mono, fontSize: 13,
              color: isToday(dayDate) ? (C.isLight ? '#fff' : C.bg) : C.textMuted,
              background: isToday(dayDate) ? C.ice : 'transparent',
              borderRadius: 4, padding: isToday(dayDate) ? '2px 7px' : '0',
              fontWeight: isToday(dayDate) ? 600 : 400,
            }}>{dayDate.getDate()}</span>
          </div>
          <div style={{ padding: 14, minHeight: 480 }}>
            {(tasksForDay(dayDate).length || eventsForDay(dayDate).length) ? (
              <DayChips dayTasks={tasksForDay(dayDate)} dayEvents={eventsForDay(dayDate)}
                columns={columns} onTaskClick={onTaskClick} max={Infinity} tags={tags} detailed />
            ) : (
              <div style={{ fontFamily: F.body, fontSize: 13, color: C.textDim }}>No tasks due</div>
            )}
          </div>
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
// Device-local timeline view preference — its own localStorage key, NOT board data
// (same pattern as Calendar's K_CAL_VIEW). Sub-modes: the original rolling 42-day
// scroll (default) and a fixed 5-day Mon-Fri Work Week window.
const K_TIMELINE_VIEW = 'kanbantt:timeline-view:v1';
const TIMELINE_LAYOUTS = [
  { id: 'rolling', label: 'Rolling' },
  { id: 'workweek', label: 'Work Week' },
];

function GanttView({ tasks, events, columns, onTaskClick }) {
  const C = useTheme();
  const narrow = useNarrow();
  const DAY_W = 36;
  const ROW_H = 44;
  const LABEL_W = 220;
  // Work Week only has 5 columns (vs the scroll's 42), so each gets far more room —
  // mirrors how Calendar's own Week/Work-Week rows dwarf a Month cell.
  const WW_DAY_W = 140;
  // Narrow-only: shrink the label column, day width, and page padding for a phone.
  // On desktop these collapse to the module constants so the render is byte-for-byte.
  const labelW = narrow ? 124 : LABEL_W;
  const rollingDayW = narrow ? 32 : DAY_W;
  const wwDayW = narrow ? 84 : WW_DAY_W;
  const pagePad = narrow ? 12 : 28;

  const [offset, setOffset] = useState(-7);
  // Work Week's own cursor (any day in the target week) — independent of the
  // rolling scroll's `offset`, exactly like Calendar keeps one `cursor` per layout.
  const [weekCursor, setWeekCursor] = useState(() => new Date());
  // Device-local sub-mode preference: synchronous lazy read, same mechanism as
  // Calendar's `layout` state. Anything else (incl. absent) falls back to rolling.
  const [subview, setSubview] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem(K_TIMELINE_VIEW));
      return v === 'workweek' ? v : 'rolling';
    } catch { return 'rolling'; }
  });
  useEffect(() => { safeSet(K_TIMELINE_VIEW, subview); }, [subview]);
  const isWW = subview === 'workweek';

  const rollingStart = addDays(new Date(), offset);
  rollingStart.setHours(0, 0, 0, 0);
  // Mon-Sat-Sunday-anchored week (same convention as Calendar's weekStart), sliced
  // to its Monday so the Work Week window always opens on Monday.
  const wwWeekStart = startOfDay(addDays(weekCursor, -weekCursor.getDay()));
  const wwMonday = addDays(wwWeekStart, 1);

  const viewStart = isWW ? wwMonday : rollingStart;
  const numDays = isWW ? 5 : 42;
  const dayW = isWW ? wwDayW : rollingDayW;
  const days = Array.from({ length: numDays }, (_, i) => addDays(viewStart, i));

  const sorted = [...tasks].sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  const todayIdx = Math.round((new Date().setHours(0, 0, 0, 0) - viewStart.getTime()) / 86400000);

  // Per-task bar metrics, shared by both sub-modes (identical math, just a different
  // viewStart/numDays). Work Week additionally DROPS rows with no visible bar at all
  // (a task entirely outside Mon-Fri shouldn't show an empty row); the rolling scroll
  // keeps every task's label row regardless of bar visibility, exactly as before.
  const rows = sorted.map((t) => {
    const start = startOfDay(new Date(t.startDate));
    const end = startOfDay(new Date(t.dueDate));
    const startIdx = Math.round((start - viewStart.getTime()) / 86400000);
    const duration = Math.round((end - start) / 86400000) + 1;
    const visible = startIdx + duration > 0 && startIdx < numDays;
    return { t, startIdx, duration, visible };
  }).filter((r) => !isWW || r.visible);

  // On narrow, land the horizontal scroll on today: the 42-day window starts a week
  // before today (offset -7), so today otherwise sits off-screen to the right. Nudge
  // the day axis so today rests just past the frozen label column. Desktop: no-op.
  const scrollRef = useRef(null);
  useEffect(() => {
    if (!narrow) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, todayIdx * dayW - dayW);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow, subview]);

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

  // prev/next/today: page by 14 days / jump to offset -7 on the rolling scroll,
  // step by one week / jump to this week in Work Week — mirroring Calendar's own
  // per-layout goPrev/goNext split.
  const goPrev = () => isWW ? setWeekCursor((c) => addDays(c, -7)) : setOffset((o) => o - 14);
  const goNext = () => isWW ? setWeekCursor((c) => addDays(c, 7)) : setOffset((o) => o + 14);
  const goToday = () => isWW ? setWeekCursor(new Date()) : setOffset(-7);

  return (
    <div style={narrow ? {
      // Narrow: pin the page to the viewport below the header (67px) + FilterBar
      // (53px) — the same offset BoardView uses — and lay out as a flex column so
      // the scroll pane below can flex-fill the remaining height. This is what
      // moves vertical scrolling INSIDE the Gantt pane (see scroll container
      // below). box-sizing keeps the page padding inside the height. Desktop: the
      // root is just padded and the page scrolls normally — byte-for-byte as before.
      padding: pagePad, boxSizing: 'border-box',
      height: 'calc(100dvh - 67px - 53px)',
      display: 'flex', flexDirection: 'column',
    } : { padding: pagePad }}>
      <div style={{
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', marginBottom: 20,
      }}>
        <h2 style={{
          fontFamily: F.display, fontStyle: 'italic', fontWeight: 400,
          fontSize: 28, margin: 0, color: C.text, letterSpacing: '-0.02em',
        }}>Timeline</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{
            display: 'flex', gap: 4, background: C.surface,
            padding: 4, borderRadius: 10, border: `1px solid ${C.border}`,
          }}>
            {TIMELINE_LAYOUTS.map(({ id, label }) => {
              const active = subview === id;
              return (
                <button key={id} onClick={() => setSubview(id)} style={{
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
            <button onClick={goToday} style={{
              ...navBtn, padding: '0 14px', width: 'auto', fontFamily: F.mono, fontSize: 11,
            }}>TODAY</button>
            <button onClick={goNext} style={navBtn}>
              <ChevronRight size={16} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </div>

      <div ref={scrollRef} style={{
        border: `1px solid ${C.border}`, borderRadius: 10,
        overflow: 'auto', background: C.surface,
        // Narrow: fill the remaining viewport height (root is a viewport-tall flex
        // column) so VERTICAL scrolling happens inside this pane. That's what makes
        // the sticky-top date header (zIndex 5) and the sticky top-left corner
        // (zIndex 6) engage on vertical scroll — alongside the already-frozen
        // sticky-left label column (zIndex 3). Without a height cap the container
        // grew to fit every row, so vertical scroll happened at the PAGE level and
        // top:0 had nothing to stick to — the header rode up off-screen. The header
        // (C.bgGrain) and corner (C.surface) backgrounds are solid, so body rows
        // don't bleed through when pinned. Desktop: no height — unchanged.
        ...(narrow && { flex: 1, minHeight: 0 }),
        // The day-grid inside routinely needs 1700px+ (labelW + numDays*dayW) and
        // is meant to scroll horizontally WITHIN this bordered pane, not blow out
        // the page — this box's own overflow:auto is what makes that internal
        // scrollbar happen. contain:inline-size stops that intrinsic width from
        // counting toward #root's min-width:max-content (src/index.css), so #root
        // only grows for content that's genuinely meant to spill onto the
        // window's scrollbar (Board's grid), not for panes that already scroll
        // themselves. Doesn't change this box's own rendered width — that still
        // comes from its parent's available space exactly as before.
        contain: 'inline-size',
      }}>
        <div style={{ minWidth: labelW + numDays * dayW }}>
          <div style={{
            display: 'flex', borderBottom: `1px solid ${C.border}`,
            background: C.bgGrain, position: 'sticky', top: 0, zIndex: narrow ? 5 : 2,
          }}>
            <div style={{
              width: labelW, padding: '10px 14px',
              fontFamily: F.mono, fontSize: 10.5, color: C.textMuted,
              letterSpacing: '0.1em', textTransform: 'uppercase',
              borderRight: `1px solid ${C.border}`,
              // Narrow: the corner cell — sticky top AND left, on top of everything.
              ...(narrow && {
                position: 'sticky', left: 0, zIndex: 6,
                background: C.surface, flexShrink: 0,
              }),
            }}>Task</div>
            <div style={{ display: 'flex', flex: 1 }}>
              {days.map((d, i) => {
                const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                const isFirst = d.getDate() === 1 || i === 0;
                const isTodayD = iso(d) === iso(new Date());
                const evCount = eventByDay[i] || 0;
                return (
                  <div key={i} style={{
                    width: dayW, padding: '6px 0 4px', textAlign: 'center',
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
                left: labelW + todayIdx * dayW + dayW / 2,
                top: 0, bottom: 0, width: 1,
                background: C.ice, opacity: 0.4, zIndex: 1,
              }} />
            )}
            {rows.map(({ t, startIdx, duration, visible }) => {
              const overdue = isOverdue(t);
              const col = columns.find((c) => c.id === t.status);
              const accent = overdue ? C.coral : C[col.accentKey];
              const barLeft = Math.max(startIdx, 0) * dayW;
              const clipL = startIdx < 0 ? -startIdx : 0;
              const clipR = Math.max(0, startIdx + duration - numDays);
              const barWidth = Math.max(8, (duration - clipL - clipR) * dayW - 4);
              // Work Week only: a clipped edge drops its rounded cap and gets a small
              // chevron so a bar that runs past Monday/Friday visibly keeps going,
              // rather than reading as a hard stop. The 42-day scroll is untouched —
              // clipL/R already existed there (shrinking barWidth) but never got a
              // distinct look, so leaving its rounded corners alone keeps it byte-for-
              // byte identical to before.
              const clipLShown = isWW && clipL > 0;
              const clipRShown = isWW && clipR > 0;
              const barRadius = isWW
                ? `${clipLShown ? 0 : 4}px ${clipRShown ? 0 : 4}px ${clipRShown ? 0 : 4}px ${clipLShown ? 0 : 4}px`
                : 4;

              return (
                <div key={t.id} style={{
                  display: 'flex', height: ROW_H,
                  borderBottom: `1px solid ${C.border}`,
                  alignItems: 'center', position: 'relative',
                }}>
                  <div style={{
                    width: labelW, padding: '0 14px', fontSize: 13,
                    color: C.text, borderRight: `1px solid ${C.border}`,
                    height: '100%', display: 'flex', alignItems: 'center',
                    gap: 8, flexShrink: 0,
                    // Narrow: freeze the label column — pinned left, above bars and
                    // the today line (z:1), below the header row (z:5).
                    ...(narrow && { position: 'sticky', left: 0, zIndex: 3, background: C.surface }),
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
                        borderLeft: `3px solid ${accent}`, borderRadius: barRadius,
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
                        {clipLShown && (
                          <ChevronLeft size={10} strokeWidth={2.5} style={{
                            position: 'absolute', left: 1, opacity: 0.85, flexShrink: 0,
                          }} />
                        )}
                        {overdue ? '◆ ' : ''}{duration}d
                        {clipRShown && (
                          <ChevronRight size={10} strokeWidth={2.5} style={{
                            position: 'absolute', right: 1, opacity: 0.85, flexShrink: 0,
                          }} />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {/* Dependency edges SVG overlay — arrows from required card's bar right
                edge to dependent card's bar left edge, for cards visible in the current
                window. Dangling refs (dep not in rows): greyed stub. Cycles (DFS
                back-edge): coral + dashed. pointerEvents:none so bars stay clickable. */}
            {(() => {
              const hasDeps = rows.some((r) => (r.t.depends_on || []).length > 0);
              if (!hasDeps) return null;

              const idToIdx = new Map(rows.map((r, i) => [r.t.id, i]));

              // DFS cycle detection over visible rows (depends_on graph).
              const inCycle = new Set();
              const visited = new Set();
              const recStack = new Set();
              function dfsCycle(i) {
                if (recStack.has(i)) { inCycle.add(i); return true; }
                if (visited.has(i)) return inCycle.has(i);
                visited.add(i); recStack.add(i);
                let cyclic = false;
                for (const depId of (rows[i].t.depends_on || [])) {
                  const j = idToIdx.get(depId);
                  if (j !== undefined && dfsCycle(j)) { inCycle.add(i); cyclic = true; }
                }
                recStack.delete(i);
                return cyclic;
              }
              rows.forEach((_, i) => { if (!visited.has(i)) dfsCycle(i); });

              // For each visible dependent card, draw edges FROM each dep TO this card.
              const edges = [];
              rows.forEach((depRow, depIdx) => {
                const deps = depRow.t.depends_on || [];
                if (!deps.length) return;
                const toBarLeft = Math.max(depRow.startIdx, 0) * dayW;
                const toY = depIdx * ROW_H + ROW_H / 2;
                const toX = toBarLeft + 2; // left edge of this card's bar

                deps.forEach((reqId) => {
                  const reqIdx = idToIdx.get(reqId);
                  const cyclic = inCycle.has(depIdx) || (reqIdx !== undefined && inCycle.has(reqIdx));
                  if (reqIdx === undefined) {
                    // Dangling ref — greyed stub at the dependent bar's left
                    edges.push({ type: 'dangling', toX, toY, cyclic, key: `${depRow.t.id}-${reqId}` });
                    return;
                  }
                  const reqRow = rows[reqIdx];
                  const fromBarLeft = Math.max(reqRow.startIdx, 0) * dayW;
                  const reqClipL = reqRow.startIdx < 0 ? -reqRow.startIdx : 0;
                  const reqClipR = Math.max(0, reqRow.startIdx + reqRow.duration - numDays);
                  const reqBarW = Math.max(8, (reqRow.duration - reqClipL - reqClipR) * dayW - 4);
                  const fromX = fromBarLeft + 2 + reqBarW; // right edge of required card's bar
                  const fromY = reqIdx * ROW_H + ROW_H / 2;
                  edges.push({ type: 'edge', fromX, fromY, toX, toY, cyclic, key: `${depRow.t.id}-${reqId}` });
                });
              });

              if (!edges.length) return null;
              const svgH = rows.length * ROW_H;
              const svgW = numDays * dayW;

              return (
                <svg style={{
                  position: 'absolute', left: labelW, top: 0,
                  width: svgW, height: svgH,
                  pointerEvents: 'none', overflow: 'visible', zIndex: 2,
                }}>
                  <defs>
                    <marker id="dep-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                      <path d="M0,0 L6,3 L0,6 Z" fill={C.textDim} fillOpacity="0.6" />
                    </marker>
                    <marker id="dep-arrow-cycle" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                      <path d="M0,0 L6,3 L0,6 Z" fill={C.coral} fillOpacity="0.8" />
                    </marker>
                  </defs>
                  {edges.map((e) => {
                    const color = e.cyclic ? C.coral : C.textDim;
                    const opacity = e.cyclic ? 0.7 : 0.45;
                    const markerId = e.cyclic ? 'dep-arrow-cycle' : 'dep-arrow';
                    if (e.type === 'dangling') {
                      return (
                        <line key={e.key}
                          x1={e.toX - 4} y1={e.toY - 6}
                          x2={e.toX - 4} y2={e.toY + 6}
                          stroke={color} strokeWidth={1.5}
                          strokeDasharray="2,2" opacity={opacity * 0.6}
                        />
                      );
                    }
                    const mx = (e.fromX + e.toX) / 2;
                    return (
                      <path key={e.key}
                        d={`M ${e.fromX} ${e.fromY} C ${mx} ${e.fromY}, ${mx} ${e.toY}, ${e.toX} ${e.toY}`}
                        fill="none" stroke={color} strokeWidth={1.5}
                        strokeDasharray={e.cyclic ? '4,2' : 'none'}
                        opacity={opacity}
                        markerEnd={`url(#${markerId})`}
                      />
                    );
                  })}
                </svg>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   TASK MODAL
   ============================================================ */
function TaskModal({ task, tags, columns, onSave, onDelete, onClose, isNew, onCreateTag, readOnly, mcpWritable, canRetier, onRetier, canResolve, onResolveEscalation, canArchive, canUnarchive, onArchive, onUnarchive, allTasks }) {
  const C = useTheme();
  const [draft, setDraft] = useState(task);
  const [newTagInput, setNewTagInput] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newChecklistText, setNewChecklistText] = useState('');
  const [notesPreview, setNotesPreview] = useState(false);
  const depsSearchState = useState('');
  // Two-step delete confirm — the MCP-writable tombstone guard (a stray click must
  // not delete a card). Only the MCP path arms it; local delete stays immediate.
  const [confirmDelete, setConfirmDelete] = useState(false);
  // tier is WRITE-ONCE on the spine via card_update (settable while null; a non-null
  // tier can't be changed there). Lock the plain control once set so the user can't
  // queue a doomed update. The GOVERNED re-tier (card_retier) is the ONE sanctioned
  // way to change a set tier — gated on canRetier, surfaced as a deliberate sub-flow.
  const tierLocked = task.tier != null;

  // ── Governed re-tier sub-flow (card_retier) ─────────────────────────────────
  // A FOCUSED, isolated action — NOT bundled with the title/AC save. Two-step +
  // deliberate, in the spirit of the delete confirm: Unlock reveals a tier picker +
  // a REQUIRED reason, and Confirm calls the audited path. Tier is hyphen "tier-N"
  // internally (the provider maps to the wire "tier:N"); compare on the numeric part.
  const [retierOpen, setRetierOpen] = useState(false);
  const [retierTier, setRetierTier] = useState(task.tier); // selected new tier (defaults to current)
  const [retierReason, setRetierReason] = useState('');
  const [retiering, setRetiering] = useState(false);
  const tierNum = (t) => { const m = /^tier-([1-9][0-9]*)$/.exec(t || ''); return m ? Number(m[1]) : null; };
  // Mirror the spine's invariants client-side (the spine still enforces them as the
  // backstop): a re-tier needs a DIFFERENT in-range tier and a non-empty reason.
  const retierChanged = retierTier != null && retierTier !== draft.tier;
  const retierReasonOk = retierReason.trim().length > 0;
  const canConfirmRetier = retierChanged && retierReasonOk && !retiering;
  // reduces_control cue: a DOWNGRADE (new tier number < current) weakens oversight.
  // No coral when new_tier >= current. draft.tier is the current (re-)locked value.
  const retierDowngrade = retierChanged
    && tierNum(retierTier) != null && tierNum(draft.tier) != null
    && tierNum(retierTier) < tierNum(draft.tier);

  // Confirm → the governed write. The parent (onRetier) owns the optimistic apply +
  // the SHARED loud-revert path (snap-back + persistent banner) and hands back the
  // fresh Card on success; we re-lock the field at that fresh tier and clear the
  // sub-flow. On failure the parent already surfaced the loud banner + snapped the
  // board back, so we just close the sub-flow (re-locking at the unchanged value) —
  // we do NOT invent a second, modal-local error surface.
  const confirmRetier = async () => {
    if (!canConfirmRetier) return;
    setRetiering(true);
    try {
      const card = await onRetier(task.id, retierTier, retierReason.trim());
      if (card && card.tier != null) setDraft((d) => ({ ...d, tier: card.tier }));
      setRetierOpen(false);
      setRetierReason('');
    } catch {
      // Loud-revert already fired in the parent (banner + board snap-back). Close.
      setRetierOpen(false);
      setRetierReason('');
    } finally {
      setRetiering(false);
    }
  };
  // Cancel → re-lock the field, discard the reason, reset the picker to current.
  const cancelRetier = () => {
    setRetierOpen(false);
    setRetierReason('');
    setRetierTier(draft.tier);
  };

  // ── Per-card Archive/Unarchive (card_archive / card_unarchive) ──────────────
  // Gated on canArchive / canUnarchive — each derived from its OWN advertised tool,
  // INDEPENDENT of canWrite (spec §Discovery: a read-only mirror can still archive;
  // a card_archive-only server is a valid one-way archiver, so the two affordances
  // gate separately). The parent handler (onArchive/onUnarchive) sources
  // expected_version from the LIVE spineModel card exactly as onRetier does — never
  // from this modal's snapshot. Reason is omitted → the server's audited
  // "manual_archive"/"manual_unarchive" default. On success the modal closes (the
  // card just changed visibility class); on failure the parent already surfaced the
  // persistent banner + snapped the board back, so we only clear the busy state.
  const archivedNow = task.archived_at != null;
  const showArchiveControl = !isNew && (archivedNow ? (canUnarchive && !!onUnarchive) : (canArchive && !!onArchive));
  const [archiving, setArchiving] = useState(false);
  const confirmArchiveToggle = async () => {
    if (archiving) return;
    setArchiving(true);
    try {
      if (archivedNow) await onUnarchive(task.id);
      else await onArchive(task.id);
      onClose();
    } catch {
      // Loud-revert already fired in the parent (banner + snap-back). Stay open.
    } finally {
      setArchiving(false);
    }
  };

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

  // E1/E2 escalation. Read from the `task` prop, never the editable `draft`: it is a
  // read-only authorization artifact, not a task field. `resolvedLocally` is an
  // optimistic override so the section reflects a resolve the INSTANT it succeeds,
  // before the parent's next poll re-renders this modal: approve → the badge clears
  // (section closes); deny → the badge flips to the denied receipt.
  const [decision, setDecision] = useState(null);       // 'approve' | 'deny' | null
  const [rationale, setRationale] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(null);
  const [resolvedLocally, setResolvedLocally] = useState(null); // null | { resolution, resolution_rationale }

  // Dispatch provenance (spec v0.7.0), read-only: present only for agent-minted cards.
  // NOT editable — no input, no select; the mint stamp is immutable (write-once), and
  // this block is display-only. Absent entirely for human/local cards.
  const provenance = readProvenance(task.created_by);

  const rawBadge = task.badge && task.badge.kind === 'escalation' ? task.badge : null;
  const badge = resolvedLocally
    ? (resolvedLocally.resolution === 'approve'
        ? null
        : { ...rawBadge, status: 'denied', resolution_rationale: resolvedLocally.resolution_rationale })
    : rawBadge;
  const escalationDenied = !!badge && badge.status === 'denied';
  // The resolve control shows ONLY for an unresolved badge on a canResolve server. It
  // is INDEPENDENT of readOnly: the section sits OUTSIDE the disabled fieldset, so it
  // is never inerted — the board's card-writes stay hidden, this one mutation does not.
  const showResolveControl = !!badge && badge.status === 'unresolved' && !!canResolve;
  const rationaleOk = rationale.trim().length >= 10;   // mirror the server's >=10 floor
  const canSubmitResolve = showResolveControl && decision != null && rationaleOk && !resolving;

  const submitResolve = async () => {
    if (!canSubmitResolve) return;
    setResolving(true);
    setResolveError(null);
    try {
      await onResolveEscalation(badge.id, { resolution: decision, resolution_rationale: rationale.trim() });
      setResolvedLocally({ resolution: decision, resolution_rationale: rationale.trim() });
    } catch (e) {
      setResolveError((e && e.message) || 'resolve failed');
    } finally {
      setResolving(false);
    }
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
          }}>{isNew ? 'New task' : (readOnly ? 'View task' : 'Edit task')}</div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', color: C.textMuted,
            cursor: 'pointer', padding: 4,
          }}>
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        {/* Escalation (E1 display + E2 resolve). Rendered OUTSIDE the fieldset below,
            so it is NEVER inerted by read-only mode — the ONE permitted mutation
            (operator approve/deny) stays usable on a read-only board mirror. Header
            and frame go coral once denied, amber while it needs a human. */}
        {badge && (
          <div style={{
            marginBottom: 22, padding: 14,
            background: `${escalationDenied ? C.coral : C.amber}12`,
            border: `1px solid ${escalationDenied ? C.coral : C.amber}55`,
            borderRadius: 10,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12,
              fontFamily: F.mono, fontSize: 10, color: escalationDenied ? C.coral : C.amber, fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase',
            }}>
              <AlertTriangle size={13} strokeWidth={2} />
              {escalationDenied ? 'Escalation — denied' : 'Escalation — needs human review'}
            </div>
            <div style={fieldLabel}>Reason</div>
            <div style={{
              fontFamily: F.body, fontSize: 13, color: C.text,
              lineHeight: 1.5, marginBottom: 16,
            }}>
              {badge.reason || '—'}
            </div>
            <div style={fieldLabel}>Control diff (authorization artifact)</div>
            {/*
              control_diff is the authorization artifact. Canonically it is a
              STRUCTURED OBJECT — { control_id, old_value, new_value, reduces_control }
              — naming exactly which control is being overridden and how. We render
              it as an explicit delta (old → new) and SHOUT when the change relaxes a
              control (reduces_control === true): a loud coral flag plus the new value
              in red, so a loosened safety boundary can never be approved by accident.
              A bare STRING is the legacy/fallback shape — render it verbatim as a raw
              unified diff, colorizing whole lines only (never re-parsed). A null /
              absent control_diff renders a muted em dash. This block renders for both
              the unresolved and denied states.
            */}
            {(() => {
              const cd = badge.control_diff;

              // null / absent → nothing to authorize; muted placeholder.
              if (cd == null) {
                return (
                  <div style={{
                    marginTop: 4, fontFamily: F.mono, fontSize: 12, color: C.textMuted,
                  }}>—</div>
                );
              }

              // STRING (legacy/fallback) → verbatim unified diff, whole-line colorized.
              if (typeof cd === 'string') {
                return (
                  <pre style={{
                    margin: 0, marginTop: 4, padding: 12,
                    background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7,
                    fontFamily: F.mono, fontSize: 12, lineHeight: 1.5,
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    maxHeight: 280, overflowY: 'auto',
                  }}>
                    {cd.split('\n').map((line, i) => {
                      // Whole-line classification only; the literal text is rendered as-is.
                      // `+++`/`---` file headers stay neutral (they aren't content edits).
                      const added = line.startsWith('+') && !line.startsWith('+++');
                      const removed = line.startsWith('-') && !line.startsWith('---');
                      const color = added ? C.mint : removed ? C.coral : C.textMuted;
                      const bg = added ? `${C.mint}14` : removed ? `${C.coral}14` : 'transparent';
                      return (
                        <span key={i} style={{ display: 'block', minHeight: '1.5em', color, background: bg }}>
                          {line}
                        </span>
                      );
                    })}
                  </pre>
                );
              }

              // OBJECT (canonical) → structured delta with a loud reduces_control signal.
              const relaxes = cd.reduces_control === true;
              const fmtVal = (v) => {
                if (v === undefined) return '—';
                if (v === null) return 'null';
                return typeof v === 'object' ? JSON.stringify(v) : String(v);
              };
              return (
                <div style={{
                  marginTop: 4, padding: 12, borderRadius: 7, background: C.bg,
                  border: `1px solid ${relaxes ? `${C.coral}66` : C.border}`,
                }}>
                  <div style={{
                    fontFamily: F.mono, fontSize: 9, color: C.textDim,
                    letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 5,
                  }}>Control overridden</div>
                  <div style={{
                    fontFamily: F.mono, fontSize: 13, color: C.text, fontWeight: 700,
                    wordBreak: 'break-word', marginBottom: 12,
                  }}>{fmtVal(cd.control_id)}</div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                    <span style={{
                      fontFamily: F.mono, fontSize: 12, color: C.textMuted,
                      padding: '3px 8px', borderRadius: 5, background: `${C.textMuted}14`,
                      textDecoration: 'line-through', wordBreak: 'break-word',
                    }}>{fmtVal(cd.old_value)}</span>
                    <span style={{
                      fontFamily: F.mono, fontSize: 14, fontWeight: 700, flexShrink: 0,
                      color: relaxes ? C.coral : C.textDim,
                    }}>→</span>
                    <span style={{
                      fontFamily: F.mono, fontSize: 12, fontWeight: 700,
                      padding: '3px 8px', borderRadius: 5, wordBreak: 'break-word',
                      color: relaxes ? C.coral : C.mint,
                      background: relaxes ? `${C.coral}1f` : `${C.mint}14`,
                    }}>{fmtVal(cd.new_value)}</span>
                  </div>

                  {relaxes ? (
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12,
                      padding: '4px 9px', borderRadius: 6,
                      background: `${C.coral}1f`, border: `1px solid ${C.coral}66`,
                      color: C.coral, fontFamily: F.mono, fontSize: 10, fontWeight: 700,
                      letterSpacing: '0.1em', textTransform: 'uppercase',
                    }}>
                      <AlertTriangle size={11} strokeWidth={2.25} />
                      Relaxes control — weakens guardrail
                    </div>
                  ) : cd.reduces_control === false ? (
                    <div style={{
                      marginTop: 12, fontFamily: F.mono, fontSize: 10, fontWeight: 700,
                      letterSpacing: '0.1em', textTransform: 'uppercase', color: C.mint,
                    }}>Does not weaken control</div>
                  ) : null}
                </div>
              );
            })()}

            {/* DENIED → the receipt (K4): the decision + its rationale, shown in place
                of any control. A denied control change is a persistent kill-signal. */}
            {escalationDenied && (
              <div style={{ marginTop: 16 }}>
                <div style={fieldLabel}>Resolution</div>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '3px 9px', borderRadius: 6, marginBottom: badge.resolution_rationale ? 12 : 0,
                  background: `${C.coral}1f`, border: `1px solid ${C.coral}66`,
                  color: C.coral, fontFamily: F.mono, fontSize: 11, fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                }}>
                  <AlertTriangle size={11} strokeWidth={2.25} /> Denied
                </div>
                {badge.resolution_rationale && (
                  <>
                    <div style={fieldLabel}>Rationale</div>
                    <div style={{ fontFamily: F.body, fontSize: 13, color: C.text, lineHeight: 1.5 }}>
                      {badge.resolution_rationale}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* UNRESOLVED + canResolve → the resolve control (K3): an approve/deny
                choice, a rationale, and a submit gated at the server's >=10-char floor.
                The ONE permitted mutation in MCP mode — gated on canResolve, NOT on
                read-only (the board's card-writes stay hidden; this does not). */}
            {showResolveControl && (
              <div style={{ marginTop: 16, borderTop: `1px solid ${C.amber}33`, paddingTop: 16 }}>
                <div style={fieldLabel}>Decision</div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                  {['approve', 'deny'].map((d) => {
                    const active = decision === d;
                    const accent = d === 'deny' ? C.coral : C.mint;
                    return (
                      <button key={d} type="button" onClick={() => setDecision(d)} style={{
                        flex: 1, padding: '9px 12px', borderRadius: 7, cursor: 'pointer',
                        background: active ? `${accent}1f` : 'transparent',
                        border: `1px solid ${active ? accent : C.border}`,
                        color: active ? accent : C.textMuted,
                        fontFamily: F.mono, fontSize: 12, fontWeight: 700,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                      }}>
                        {d}
                      </button>
                    );
                  })}
                </div>
                <label style={fieldLabel}>Rationale (required, min 10 chars)</label>
                <textarea
                  value={rationale}
                  onChange={(e) => setRationale(e.target.value)}
                  rows={3}
                  placeholder="Why approve or deny? Recorded as the override receipt."
                  style={{ ...input, resize: 'vertical', minHeight: 64, fontFamily: F.body }}
                />
                {resolveError && (
                  <div style={{ marginTop: 8, color: C.coral, fontFamily: F.mono, fontSize: 11 }}>
                    {resolveError}
                  </div>
                )}
                <button
                  type="button"
                  onClick={submitResolve}
                  disabled={!canSubmitResolve}
                  style={{
                    marginTop: 12, width: '100%', padding: '10px 12px', borderRadius: 7,
                    background: canSubmitResolve ? C.ice : C.surface,
                    border: `1px solid ${canSubmitResolve ? C.ice : C.border}`,
                    color: canSubmitResolve ? C.bg : C.textMuted,
                    cursor: canSubmitResolve ? 'pointer' : 'not-allowed',
                    fontFamily: F.mono, fontSize: 12, fontWeight: 700,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    opacity: resolving ? 0.7 : 1,
                  }}
                >
                  {resolving ? 'Resolving…' : 'Submit decision'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Dispatch provenance (spec v0.7.0) — READ-ONLY. How this card was MINTED
            (reasoning model, effort budget, minting actor, originating job). Shown ONLY
            for agent-minted cards (human/local cards render nothing). Deliberately OUTSIDE
            the form fieldset and carrying NO input/select: mint provenance is write-once
            and immutable — the board reports it, never edits it. */}
        {provenance && (
          <div style={{
            marginBottom: 22, padding: 14,
            background: `${C.textDim}0d`,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12,
              fontFamily: F.mono, fontSize: 10, color: C.textMuted, fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase',
            }}>
              <Cpu size={13} strokeWidth={2} />
              Dispatch provenance
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 24px' }}>
              {[
                ['Model', provenance.model],
                ['Effort', provenance.effort],
                ['Actor', provenance.actor],
                ['Job', provenance.job_id],
              ].filter(([, v]) => v).map(([label, value]) => (
                <div key={label}>
                  <div style={fieldLabel}>{label}</div>
                  <div style={{
                    fontFamily: F.mono, fontSize: 12, color: C.text, wordBreak: 'break-all',
                  }}>{value}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Body form, two shapes:
            • MCP-writable (Pass 2b): the spine-Card fields that round-trip —
              title, acceptance_criteria, write-once tier, plus effort/impact
              (Pass 2 — plain ungoverned fields, no governance UI needed, just
              selects wired to `draft` and folded into the card_update patch by
              saveTaskMcp). No Status control (a column change is a move via
              drag/long-press, never an update). Not wrapped in `disabled` — this
              mode is writable.
            • local / read-only mirror: the full task form inside a fieldset whose
              disabled={readOnly} natively inerts every control for the read-only
              viewer; the footer Save/Delete are hidden below so there's no commit. */}
        {mcpWritable ? (
          <fieldset style={{
            display: 'flex', flexDirection: 'column', gap: 18,
            border: 'none', margin: 0, padding: 0, minInlineSize: 0,
          }}>
            <div>
              <label style={fieldLabel}>Title</label>
              <input autoFocus type="text" value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={input} />
            </div>
            <div>
              {/* Description — the spec-conformant narrative BODY (spec v0.8.0). This is the
                  SAME `description` field the local editor's Notes textarea edits (reconciled,
                  not a parallel field); it is DISTINCT from Acceptance criteria below (the
                  Claunker extension the judge / SG-1 framing pass read). */}
              <label style={fieldLabel}>Description — the card's narrative body (markdown)</label>
              <textarea value={draft.description || ''}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="What is this card about / what is it for?"
                style={{ ...input, minHeight: 80, resize: 'vertical', fontFamily: F.body, fontSize: 13 }} />
            </div>
            <div>
              <label style={fieldLabel}>Acceptance criteria</label>
              <textarea value={draft.acceptance_criteria || ''}
                onChange={(e) => setDraft({ ...draft, acceptance_criteria: e.target.value })}
                placeholder="What must be true for this card to be done?"
                style={{ ...input, minHeight: 80, resize: 'vertical', fontFamily: F.body, fontSize: 13 }} />
            </div>
            <div>
              <label style={fieldLabel}>Tier{tierLocked ? (canRetier ? ' · set' : ' · write-once (set)') : ''}</label>
              {tierLocked ? (
                // Already tiered. The plain control stays LOCKED — card_update can't
                // change a set tier (tier_write_once). When the spine advertises
                // card_retier (canRetier), offer the GOVERNED re-tier as a deliberate,
                // isolated sub-flow next to the locked value; without canRetier the
                // value is read-only exactly as before (no action the backend can't do).
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ ...input, flex: 1, color: C.textMuted, fontFamily: F.mono, display: 'flex', alignItems: 'center' }}>
                      {draft.tier}
                    </div>
                    {/* GATE on canRetier: the unlock affordance appears ONLY when the
                        provider reports it. canRetier is false ⇒ no button, tier stays
                        locked — exactly as today. */}
                    {canRetier && !retierOpen && (
                      <button type="button"
                        onClick={() => { setRetierTier(draft.tier); setRetierReason(''); setRetierOpen(true); }}
                        style={{
                          flexShrink: 0, background: 'transparent', border: `1px solid ${C.border}`,
                          color: C.textMuted, padding: '9px 12px', borderRadius: 7, cursor: 'pointer',
                          fontFamily: F.mono, fontSize: 11, fontWeight: 700,
                          letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                        }}>Unlock to re-tier</button>
                    )}
                  </div>

                  {/* The deliberate two-step re-tier sub-flow: tier picker (defaults to
                      current) + REQUIRED reason + Confirm/Cancel. Isolated from the
                      footer Save (title/AC via cardUpdate): this Confirm never carries
                      title/AC, and Save never carries the tier — separate calls. */}
                  {canRetier && retierOpen && (
                    <div style={{
                      padding: 12, borderRadius: 7, background: C.bg,
                      border: `1px solid ${retierDowngrade ? `${C.coral}66` : C.border}`,
                      display: 'flex', flexDirection: 'column', gap: 10,
                    }}>
                      <div>
                        <label style={fieldLabel}>New tier</label>
                        <select value={retierTier || ''}
                          onChange={(e) => setRetierTier(e.target.value || null)}
                          style={{ ...input, cursor: 'pointer' }}>
                          <option value="tier-1">tier-1</option>
                          <option value="tier-2">tier-2</option>
                          <option value="tier-3">tier-3</option>
                          <option value="tier-4">tier-4</option>
                        </select>
                      </div>
                      <div>
                        <label style={fieldLabel}>Reason (required)</label>
                        <input type="text" value={retierReason}
                          onChange={(e) => setRetierReason(e.target.value)}
                          placeholder="Why is this tier changing? Recorded in the tier audit."
                          style={input} />
                      </div>
                      {/* reduces_control cue (light, on-ethos): coral ONLY on a downgrade
                          (new tier < current = weaker oversight), reusing the control_diff
                          "relaxes control" coral language. No coral when new_tier >= current. */}
                      {retierDowngrade && (
                        <div style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          padding: '4px 9px', borderRadius: 6, alignSelf: 'flex-start',
                          background: `${C.coral}1f`, border: `1px solid ${C.coral}66`,
                          color: C.coral, fontFamily: F.mono, fontSize: 10, fontWeight: 700,
                          letterSpacing: '0.08em', textTransform: 'uppercase',
                        }}>
                          <AlertTriangle size={11} strokeWidth={2.25} />
                          Lowering the tier weakens oversight — this will be logged.
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" onClick={confirmRetier} disabled={!canConfirmRetier} style={{
                          flex: 1, padding: '9px 12px', borderRadius: 7,
                          background: canConfirmRetier ? C.ice : C.surface,
                          border: `1px solid ${canConfirmRetier ? C.ice : C.border}`,
                          color: canConfirmRetier ? C.bg : C.textMuted,
                          cursor: canConfirmRetier ? 'pointer' : 'not-allowed',
                          fontFamily: F.mono, fontSize: 12, fontWeight: 700,
                          letterSpacing: '0.06em', textTransform: 'uppercase',
                          opacity: retiering ? 0.7 : 1,
                        }}>{retiering ? 'Re-tiering…' : 'Confirm re-tier'}</button>
                        <button type="button" onClick={cancelRetier} style={{
                          background: 'transparent', border: `1px solid ${C.border}`, color: C.textMuted,
                          padding: '9px 16px', borderRadius: 7, cursor: 'pointer',
                          fontFamily: F.mono, fontSize: 12, fontWeight: 700,
                          letterSpacing: '0.06em', textTransform: 'uppercase',
                        }}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <select value={draft.tier || ''}
                  onChange={(e) => setDraft({ ...draft, tier: e.target.value || null })}
                  style={{ ...input, cursor: 'pointer' }}>
                  <option value="">— untiered</option>
                  <option value="tier-1">tier-1</option>
                  <option value="tier-2">tier-2</option>
                  <option value="tier-3">tier-3</option>
                  <option value="tier-4">tier-4</option>
                </select>
              )}
            </div>

            <div>
              <label style={fieldLabel}>Due</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="date" value={draft.due ? draft.due.slice(0, 10) : ''}
                  onChange={(e) => setDraft({ ...draft, due: e.target.value || null })}
                  style={{ ...input, flex: 1, fontFamily: F.mono }} />
                {draft.due && (
                  <button type="button" onClick={() => setDraft({ ...draft, due: null })}
                    style={{
                      flexShrink: 0, background: 'transparent', border: `1px solid ${C.border}`,
                      color: C.textMuted, padding: '9px 12px', borderRadius: 7, cursor: 'pointer',
                      fontFamily: F.mono, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase',
                    }}>Clear</button>
                )}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={fieldLabel}>Effort</label>
                <select value={draft.effort ?? ''}
                  onChange={(e) => setDraft({ ...draft, effort: e.target.value || null })}
                  style={{ ...input, cursor: 'pointer' }}>
                  <option value="">—</option>
                  <option value="low">Low</option>
                  <option value="med">Med</option>
                  <option value="high">High</option>
                </select>
              </div>
              <div>
                <label style={fieldLabel}>Impact</label>
                <select value={draft.impact ?? ''}
                  onChange={(e) => setDraft({ ...draft, impact: e.target.value || null })}
                  style={{ ...input, cursor: 'pointer' }}>
                  <option value="">—</option>
                  <option value="low">Low</option>
                  <option value="med">Med</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: -6 }}>
              {(() => {
                const q = QUADRANT_DEFS[getQuadrant(draft)];
                if (!q) return <span style={{ ...fieldLabel, textTransform: 'none' }}>Unsorted — drag into the Matrix to classify</span>;
                const Icon = q.Icon;
                const accent = C[q.accentKey];
                return (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '4px 9px', borderRadius: 6,
                    background: `${accent}${q.tintAlpha}`, border: `1px solid ${accent}66`,
                    color: accent, fontFamily: F.mono, fontSize: 11, fontWeight: 700,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}>
                    <Icon size={12} strokeWidth={2.25} />
                    {q.label} · {q.tagline}
                  </span>
                );
              })()}
            </div>

            {/* Dependencies editor — searchable multi-select over live (non-tombstoned,
                non-archived) cards, excluding this card itself. Writes full list via
                card_update depends_on; [] = clear. */}
            {(() => {
              const curDeps = draft.depends_on || [];
              const [depsSearch, setDepsSearch] = depsSearchState;
              const candidates = (allTasks || []).filter((t) =>
                t.id !== draft.id &&
                !t.deleted_at &&
                !t.archived_at
              );
              const q = depsSearch.trim().toLowerCase();
              const filtered = q
                ? candidates.filter((t) => t.title.toLowerCase().includes(q))
                : candidates;
              const removeDep = (id) => setDraft({ ...draft, depends_on: curDeps.filter((d) => d !== id) });
              const addDep = (id) => {
                if (!curDeps.includes(id)) setDraft({ ...draft, depends_on: [...curDeps, id] });
              };
              return (
                <div>
                  <label style={fieldLabel}>Dependencies</label>
                  {curDeps.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                      {curDeps.map((id) => {
                        const dep = (allTasks || []).find((t) => t.id === id);
                        return (
                          <span key={id} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '3px 8px', borderRadius: 5,
                            background: dep ? `${C.ice}18` : `${C.textDim}18`,
                            border: `1px solid ${dep ? C.ice : C.border}`,
                            color: dep ? C.ice : C.textDim,
                            fontFamily: F.mono, fontSize: 10,
                          }}>
                            {dep ? dep.title : `${id} (removed)`}
                            <button type="button" onClick={() => removeDep(id)} style={{
                              background: 'transparent', border: 'none', color: 'inherit',
                              cursor: 'pointer', padding: 0, lineHeight: 1, display: 'flex',
                            }}><X size={10} strokeWidth={1.75} /></button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <input type="text" value={depsSearch}
                    onChange={(e) => setDepsSearch(e.target.value)}
                    placeholder="Search cards to add…"
                    style={{ ...input, marginBottom: filtered.length ? 4 : 0 }} />
                  {depsSearch && filtered.length > 0 && (
                    <div style={{
                      maxHeight: 140, overflowY: 'auto',
                      border: `1px solid ${C.border}`, borderRadius: 7,
                      background: C.bg,
                    }}>
                      {filtered.slice(0, 12).map((t) => {
                        const selected = curDeps.includes(t.id);
                        return (
                          <div key={t.id} onClick={() => selected ? removeDep(t.id) : addDep(t.id)} style={{
                            padding: '7px 12px', cursor: 'pointer', fontSize: 13,
                            color: selected ? C.ice : C.text,
                            background: selected ? `${C.ice}12` : 'transparent',
                            borderBottom: `1px solid ${C.border}30`,
                            display: 'flex', alignItems: 'center', gap: 6,
                          }}>
                            {selected && <span style={{ fontSize: 10, color: C.ice }}>✓</span>}
                            {t.title}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
          </fieldset>
        ) : (
        <fieldset disabled={readOnly} style={{
          display: 'flex', flexDirection: 'column', gap: 18,
          border: 'none', margin: 0, padding: 0, minInlineSize: 0,
          opacity: readOnly ? 0.85 : 1,
        }}>
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
              <select value={draft.effort ?? ''}
                onChange={(e) => setDraft({ ...draft, effort: e.target.value || null })}
                style={{ ...input, cursor: 'pointer' }}>
                <option value="">—</option>
                <option value="low">Low</option>
                <option value="med">Med</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label style={fieldLabel}>Impact</label>
              <select value={draft.impact ?? ''}
                onChange={(e) => setDraft({ ...draft, impact: e.target.value || null })}
                style={{ ...input, cursor: 'pointer' }}>
                <option value="">—</option>
                <option value="low">Low</option>
                <option value="med">Med</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: -6 }}>
            {(() => {
              const q = QUADRANT_DEFS[getQuadrant(draft)];
              if (!q) return <span style={{ ...fieldLabel, textTransform: 'none' }}>Unsorted — drag into the Matrix to classify</span>;
              const Icon = q.Icon;
              const accent = C[q.accentKey];
              return (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 9px', borderRadius: 6,
                  background: `${accent}${q.tintAlpha}`, border: `1px solid ${accent}66`,
                  color: accent, fontFamily: F.mono, fontSize: 11, fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                }}>
                  <Icon size={12} strokeWidth={2.25} />
                  {q.label} · {q.tagline}
                </span>
              );
            })()}
          </div>

          {/* Dependencies editor for local/read-only form */}
          {(() => {
            const curDeps = draft.depends_on || [];
            const [depsSearch, setDepsSearch] = depsSearchState;
            const candidates = (allTasks || []).filter((t) =>
              t.id !== draft.id &&
              !t.deleted_at &&
              !t.archived_at
            );
            const q = depsSearch.trim().toLowerCase();
            const filtered = q
              ? candidates.filter((t) => t.title.toLowerCase().includes(q))
              : candidates;
            const removeDep = (id) => setDraft({ ...draft, depends_on: curDeps.filter((d) => d !== id) });
            const addDep = (id) => {
              if (!curDeps.includes(id)) setDraft({ ...draft, depends_on: [...curDeps, id] });
            };
            return (
              <div>
                <label style={fieldLabel}>Dependencies</label>
                {curDeps.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                    {curDeps.map((id) => {
                      const dep = (allTasks || []).find((t) => t.id === id);
                      return (
                        <span key={id} style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '3px 8px', borderRadius: 5,
                          background: dep ? `${C.ice}18` : `${C.textDim}18`,
                          border: `1px solid ${dep ? C.ice : C.border}`,
                          color: dep ? C.ice : C.textDim,
                          fontFamily: F.mono, fontSize: 10,
                        }}>
                          {dep ? dep.title : `${id} (removed)`}
                          <button type="button" onClick={() => removeDep(id)} style={{
                            background: 'transparent', border: 'none', color: 'inherit',
                            cursor: 'pointer', padding: 0, lineHeight: 1, display: 'flex',
                          }}><X size={10} strokeWidth={1.75} /></button>
                        </span>
                      );
                    })}
                  </div>
                )}
                <input type="text" value={depsSearch}
                  onChange={(e) => setDepsSearch(e.target.value)}
                  placeholder="Search cards to add…"
                  style={{ ...input, marginBottom: filtered.length ? 4 : 0 }} />
                {depsSearch && filtered.length > 0 && (
                  <div style={{
                    maxHeight: 140, overflowY: 'auto',
                    border: `1px solid ${C.border}`, borderRadius: 7,
                    background: C.bg,
                  }}>
                    {filtered.slice(0, 12).map((t) => {
                      const selected = curDeps.includes(t.id);
                      return (
                        <div key={t.id} onClick={() => selected ? removeDep(t.id) : addDep(t.id)} style={{
                          padding: '7px 12px', cursor: 'pointer', fontSize: 13,
                          color: selected ? C.ice : C.text,
                          background: selected ? `${C.ice}12` : 'transparent',
                          borderBottom: `1px solid ${C.border}30`,
                          display: 'flex', alignItems: 'center', gap: 6,
                        }}>
                          {selected && <span style={{ fontSize: 10, color: C.ice }}>✓</span>}
                          {t.title}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

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
        </fieldset>
        )}

        <div style={{
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', marginTop: 24,
          paddingTop: 18, borderTop: `1px solid ${C.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {(!isNew && !readOnly) && (
            confirmDelete ? (
              // Armed confirm (MCP-writable only): a stray click can't tombstone.
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: F.body, fontSize: 13, color: C.text }}>Delete this card?</span>
                <button onClick={() => onDelete(draft.id)} style={{
                  background: C.coral, border: 'none', color: C.isLight ? '#fff' : C.bg,
                  padding: '9px 12px', borderRadius: 7, cursor: 'pointer',
                  fontFamily: F.body, fontSize: 13, fontWeight: 600,
                }}>Delete</button>
                <button onClick={() => setConfirmDelete(false)} style={{
                  background: 'transparent', border: `1px solid ${C.border}`, color: C.textMuted,
                  padding: '9px 12px', borderRadius: 7, cursor: 'pointer',
                  fontFamily: F.body, fontSize: 13,
                }}>Keep</button>
              </div>
            ) : (
              // First click: arm the confirm on the MCP path; delete immediately in
              // local mode (existing behavior — local delete is unchanged).
              <button onClick={() => (mcpWritable ? setConfirmDelete(true) : onDelete(draft.id))} style={{
                background: 'transparent', border: `1px solid ${C.border}`,
                color: C.coral, padding: '9px 12px', borderRadius: 7,
                cursor: 'pointer', display: 'flex', alignItems: 'center',
                gap: 6, fontFamily: F.body, fontSize: 13,
              }}>
                <Trash2 size={14} strokeWidth={1.5} />
                Delete
              </button>
            )
            )}
            {/* Archive/Unarchive — OUTSIDE the readOnly gate deliberately: the pair
                gates on its OWN capabilities (canArchive/canUnarchive), independent
                of canWrite, so a read-only mirror with card_archive still offers it.
                Single-click, no confirm arm: unlike delete, archive is reversible
                (unarchive) and the server enforces the escalation gate loudly. */}
            {showArchiveControl && (
              <button onClick={confirmArchiveToggle} disabled={archiving} style={{
                background: 'transparent', border: `1px solid ${C.border}`,
                color: C.textMuted, padding: '9px 12px', borderRadius: 7,
                cursor: archiving ? 'default' : 'pointer', display: 'flex', alignItems: 'center',
                gap: 6, fontFamily: F.body, fontSize: 13,
                opacity: archiving ? 0.6 : 1,
              }}>
                {archivedNow
                  ? <ArchiveRestore size={14} strokeWidth={1.5} />
                  : <Archive size={14} strokeWidth={1.5} />}
                {archiving ? (archivedNow ? 'Unarchiving…' : 'Archiving…') : (archivedNow ? 'Unarchive' : 'Archive')}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{
              background: 'transparent', border: `1px solid ${C.border}`,
              color: C.textMuted, padding: '9px 16px', borderRadius: 7,
              cursor: 'pointer', fontFamily: F.body, fontSize: 13,
            }}>{readOnly ? 'Close' : 'Cancel'}</button>
            {!readOnly && (
            <button onClick={() => onSave(draft)} style={{
              background: C.ice, border: 'none',
              color: C.isLight ? '#fff' : C.bg,
              padding: '9px 18px', borderRadius: 7, cursor: 'pointer',
              fontFamily: F.body, fontSize: 13, fontWeight: 600,
            }}>Save</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   MATRIX VIEW (2x2 effort/impact prioritization)
   ============================================================ */
function MatrixView({ tasks, tags, onTaskClick, onClassify, readOnly, allTasks }) {
  const C = useTheme();
  const narrow = useNarrow();
  const [draggedId, setDraggedId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  const groups = useMemo(() => {
    const g = { avoid: [], plan: [], deprioritize: [], do: [], unsorted: [] };
    tasks.forEach((t) => g[getQuadrant(t)].push(t));
    return g;
  }, [tasks]);

  // Narrow-only: which bucket's card list renders below the compact map. Defaults to the
  // first non-empty bucket in priority order, falling back to 'do'.
  const [selectedQuadrant, setSelectedQuadrant] = useState(
    () => ['do', 'plan', 'deprioritize', 'avoid', 'unsorted'].find((k) => groups[k].length > 0) || 'do',
  );

  const handleDragStart = (e, taskId) => {
    if (readOnly) return;
    setDraggedId(taskId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, target) => {
    if (readOnly) return;
    e.preventDefault();
    if (dropTarget !== target) setDropTarget(target);
  };

  const handleDrop = (e, target) => {
    if (readOnly) return;
    e.preventDefault();
    if (!draggedId) return;
    if (target === 'unsorted') {
      onClassify(draggedId, { effort: null, impact: null });
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
        readOnly={readOnly}
        allTasks={allTasks}
      />
    ));

  const renderQuadrant = (type) => {
    const def = QUADRANT_DEFS[type];
    const accent = C[def.accentKey];
    const isDrop = dropTarget === type;
    const Icon = def.Icon;
    const cards = groups[type];
    const tintAlpha = C.quadrantTintAlpha?.[type] ?? def.tintAlpha;
    return (
      <div
        onDragOver={(e) => handleDragOver(e, type)}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget)) return;
          if (dropTarget === type) setDropTarget(null);
        }}
        onDrop={(e) => handleDrop(e, type)}
        style={{
          background: isDrop ? `${accent}28` : `${accent}${tintAlpha}`,
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

  // ── Narrow / mobile: a compact 2x2 quadrant map + the selected quadrant's card list,
  // mirroring the Calendar's overview+detail pattern. Summary-only tiles (no cards inside),
  // an Unsorted row below the grid, and the selected bucket's full-width TaskCards beneath.
  // No drag here — HTML5 DnD is dead on touch, so reclassification happens via the edit
  // modal (which exposes Effort/Impact selects). The desktop branch below is untouched. ──
  if (narrow) {
    const placeholderFor = (k) =>
      k === 'avoid' ? 'nothing here, good' : k === 'unsorted' ? 'all classified' : '—';

    // A tappable quadrant summary tile — icon, label, tagline, and zero-padded count in the
    // quadrant's accent; selection gets an accent tint + inset ring (like the calendar day).
    const tile = (k) => {
      const def = QUADRANT_DEFS[k];
      const accent = C[def.accentKey];
      const tintAlpha = C.quadrantTintAlpha?.[k] ?? def.tintAlpha;
      const Icon = def.Icon;
      const active = selectedQuadrant === k;
      return (
        <button
          key={k}
          onClick={() => setSelectedQuadrant(k)}
          style={{
            textAlign: 'left', cursor: 'pointer',
            background: active ? `${accent}28` : `${accent}${tintAlpha}`,
            border: `1px solid ${active ? accent : C.border}`,
            boxShadow: active ? `inset 0 0 0 1.5px ${accent}` : 'none',
            borderRadius: 12, padding: 12, minHeight: 76,
            display: 'flex', flexDirection: 'column', gap: 6,
            transition: 'background 120ms ease, border-color 120ms ease, box-shadow 120ms ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon size={14} color={accent} strokeWidth={1.75} />
            <span style={{
              fontFamily: F.mono, fontSize: 11, color: accent,
              letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 600,
            }}>{def.label}</span>
            <span style={{
              marginLeft: 'auto', fontFamily: F.mono, fontSize: 13, fontWeight: 600,
              color: accent, letterSpacing: '0.04em',
            }}>{groups[k].length.toString().padStart(2, '0')}</span>
          </div>
          <span style={{
            fontFamily: F.display, fontStyle: 'italic', fontSize: 12, color: C.textDim,
          }}>{def.tagline}</span>
        </button>
      );
    };

    const selDef = selectedQuadrant === 'unsorted'
      ? { label: 'Unsorted', tagline: 'not yet classified', accent: C.textMuted }
      : {
          label: QUADRANT_DEFS[selectedQuadrant].label,
          tagline: QUADRANT_DEFS[selectedQuadrant].tagline,
          accent: C[QUADRANT_DEFS[selectedQuadrant].accentKey],
        };
    const selCards = groups[selectedQuadrant];
    const unsortedActive = selectedQuadrant === 'unsorted';

    return (
      <div style={{ padding: 14 }}>
        <div style={{ marginBottom: 16 }}>
          <h2 style={{
            fontFamily: F.display, fontStyle: 'italic', fontWeight: 400, fontSize: 22,
            margin: 0, color: C.text, letterSpacing: '-0.02em',
          }}>Matrix</h2>
          {/* Axis gutters would crush the tiles on a phone, so the axes live here as a hint;
              the tiles' fixed positions + taglines carry the Effort×Impact meaning. */}
          <div style={{
            fontFamily: F.mono, fontSize: 10, color: C.textMuted,
            letterSpacing: '0.18em', textTransform: 'uppercase', marginTop: 6,
          }}>Effort ↑ × Impact →</div>
        </div>

        {/* Compact 2x2 map — spatial: top-left Avoid, top-right Plan, bottom-left
            Deprioritize, bottom-right Do (same positions as the desktop grid). */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 8,
        }}>
          {tile('avoid')}
          {tile('plan')}
          {tile('deprioritize')}
          {tile('do')}
        </div>

        {/* Unsorted — a separate tappable row below the 2x2 map (not part of the grid). */}
        <button
          onClick={() => setSelectedQuadrant('unsorted')}
          style={{
            marginTop: 8, width: '100%', textAlign: 'left', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 10,
            background: unsortedActive ? `${C.textMuted}22` : 'transparent',
            border: `1px ${unsortedActive ? 'solid' : 'dashed'} ${unsortedActive ? C.textMuted : C.border}`,
            boxShadow: unsortedActive ? `inset 0 0 0 1.5px ${C.textMuted}` : 'none',
            borderRadius: 12, padding: '12px 14px', minHeight: 52,
            transition: 'background 120ms ease, border-color 120ms ease, box-shadow 120ms ease',
          }}
        >
          <span style={{
            fontFamily: F.mono, fontSize: 11, color: C.text,
            letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 600,
          }}>Unsorted</span>
          <span style={{
            fontFamily: F.display, fontStyle: 'italic', fontSize: 12, color: C.textDim,
          }}>not yet classified</span>
          <span style={{
            marginLeft: 'auto', fontFamily: F.mono, fontSize: 13, fontWeight: 600,
            color: C.textMuted, letterSpacing: '0.04em',
          }}>{groups.unsorted.length.toString().padStart(2, '0')}</span>
        </button>

        {/* Selected-quadrant detail: header (label · tagline · count) + full-width cards. */}
        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
            <span style={{
              fontFamily: F.mono, fontSize: 11, color: selDef.accent,
              letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 600,
            }}>{selDef.label}</span>
            <span style={{
              fontFamily: F.display, fontStyle: 'italic', fontSize: 12, color: C.textDim,
            }}>{selDef.tagline}</span>
            <span style={{
              marginLeft: 'auto', fontFamily: F.mono, fontSize: 10, color: C.textDim,
              letterSpacing: '0.05em',
            }}>{selCards.length.toString().padStart(2, '0')}</span>
          </div>
          {selCards.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
              {renderCards(selCards)}
            </div>
          ) : (
            <div style={{
              padding: '24px 0', textAlign: 'center', fontFamily: F.display,
              fontStyle: 'italic', fontSize: 13, color: C.textDim, opacity: 0.7,
            }}>{placeholderFor(selectedQuadrant)}</div>
          )}
        </div>
      </div>
    );
  }

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
  // eslint-disable-next-line react-hooks/purity
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
  onAddTag, onRenameTag, onRecolorTag, onDeleteTag, readOnly,
  spineState, onSpineConnect, onSpineDisconnect,
  archiveConfig, onArchiveConfigChange,
}) {
  const C = useTheme();
  const [tab, setTab] = useState('columns');
  const [newColumnName, setNewColumnName] = useState('');
  const [newTagName, setNewTagName] = useState('');
  // Connection tab — prefill from the effective kanbantt_config (env baseline overlaid
  // with the stored override). These are the editable form values; the live status
  // comes from spineState (the controller's truth), never from these.
  const initialMcp = useMemo(() => readKanbanttConfig().mcp || {}, []);
  const [spineUrl, setSpineUrl] = useState(initialMcp.url || '');
  const [spineToken, setSpineToken] = useState(initialMcp.auth_token || '');
  const [showToken, setShowToken] = useState(false);
  // Remember-token opt-in (spec Auth v1): default UNCHECKED. Migration: a legacy config
  // with auth_token but no remember_token flag predates the opt-in — initialise checked
  // so the existing token is honored and the user can revoke by unchecking.
  const initialRemember = initialMcp.remember_token === true
    || (!!(initialMcp.auth_token) && initialMcp.remember_token === undefined);
  const [rememberToken, setRememberToken] = useState(initialRemember);
  const [connecting, setConnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  // Clear the transient "Connecting…" once the controller reaches a terminal state:
  // connected (provider 'mcp'), or degraded/failed (a fallback/error on local state).
  // Done as a render-time state adjustment keyed off a spineState transition (React's
  // documented alternative to an effect for deriving state from a changing prop) — it
  // fires exactly once per transition and never on a steady state.
  const [prevSpineState, setPrevSpineState] = useState(spineState);
  if (spineState !== prevSpineState) {
    setPrevSpineState(spineState);
    if (connecting && spineState
      && (spineState.provider === 'mcp'
        || (spineState.provider === 'local' && (spineState.fallback || spineState.error)))) {
      setConnecting(false);
    }
  }

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
  // Read-only spine mirror (canWrite false): a disabled fieldset inerts the whole
  // columns/tags editor (inputs, swatch-picker buttons, reorder/delete, the add
  // row) in one wrap while preserving the section's flex layout. The Account tab
  // (sync / sign-out — device-local, not a board write) stays interactive.
  const fieldsetReset = {
    border: 'none', margin: 0, padding: 0, minInlineSize: 0,
    display: 'flex', flexDirection: 'column', gap: 14,
    opacity: readOnly ? 0.55 : 1,
  };

  /* ---- Connection tab: live status + typed errors + contextual guidance ---- */
  // The controller's connection state is the source of truth (never the form fields).
  const spineConnected = !!(spineState && spineState.provider === 'mcp');
  const spineCaps = (spineState && spineState.capabilities) || null;
  const spineDegraded = !!(spineState && spineState.provider === 'local' && (spineState.fallback || spineState.error));
  const spineErrCode = (spineState && spineState.error && spineState.error.code) || null;
  const spineErrMsg = (spineState && spineState.error && spineState.error.message) || null;
  // 401 (the fetch got a RESPONSE with status 401) → a specific, actionable message.
  // Any other failure is a connection-class failure the browser won't let JS pin down
  // (CORS vs network vs mixed-content are deliberately indistinguishable) → a checklist.
  const spineAuthError = spineErrCode === 'auth';
  // window.location is the ONE honest source for the origin to whitelist + the https
  // detection (correct whether served from the deployed host, localhost:5173, or a fork).
  const origin = (typeof window !== 'undefined' && window.location && window.location.origin) || '';
  const originEnvLine = `CLAUNKER_SPINE_ORIGIN=${origin}`;
  const pageIsHttps = typeof window !== 'undefined' && window.location && window.location.protocol === 'https:';
  // Contextual localhost hint: a DEPLOYED (https) page cannot reach a http://localhost
  // spine (mixed content + Private Network Access). Detect the entered URL's host.
  const enteredHost = (() => {
    try { return spineUrl.trim() ? new URL(spineUrl.trim()).hostname : ''; } catch { return ''; }
  })();
  const enteredIsLocalhost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(enteredHost);
  const localhostConflict = enteredIsLocalhost && pageIsHttps;

  const doSpineConnect = async () => {
    if (!spineUrl.trim()) return;
    setConnecting(true);
    await onSpineConnect(spineUrl, spineToken, rememberToken);
  };
  const doSpineDisconnect = async () => {
    setConnecting(false);
    await onSpineDisconnect();
  };
  const copyOrigin = async () => {
    try {
      await navigator.clipboard.writeText(originEnvLine);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked (insecure context / denied) — the text stays selectable */ }
  };
  const fieldLabel = {
    fontFamily: F.mono, fontSize: 10, letterSpacing: '0.18em',
    textTransform: 'uppercase', color: C.textMuted,
  };
  const pillBtn = {
    padding: '7px 12px', background: C.surfaceHi, color: C.text,
    border: `1px solid ${C.border}`, borderRadius: 7, cursor: 'pointer',
    fontFamily: F.body, fontSize: 12, fontWeight: 500, flexShrink: 0,
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
            { id: 'connection', label: 'Connection', count: null },
            { id: 'archive', label: 'Archive', count: null },
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
            <fieldset disabled={readOnly} style={fieldsetReset}>
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
            </fieldset>
          )}

          {tab === 'tags' && (
            <fieldset disabled={readOnly} style={fieldsetReset}>
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
            </fieldset>
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

          {tab === 'connection' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* STATUS — the controller's truth (spineState), never the form fields */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: 14, background: C.surface, borderRadius: 10,
                border: `1px solid ${spineConnected ? `${C.mint}40` : spineDegraded ? `${C.coral}40` : C.border}`,
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '50%',
                  background: C.surfaceHi, border: `1px solid ${C.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <Cloud size={18} strokeWidth={1.5}
                    color={spineConnected ? C.mint : spineDegraded ? C.coral : C.textDim} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: F.body, fontSize: 14, color: C.text, fontWeight: 500 }}>
                    {spineConnected ? (spineState.server?.name || 'Spine')
                      : connecting ? 'Connecting…' : spineDegraded ? 'Disconnected' : 'Not connected'}
                  </div>
                  <div style={{
                    fontFamily: F.mono, fontSize: 11, color: C.textMuted, marginTop: 2,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {spineConnected ? (spineCaps && spineCaps.canWrite ? 'Writable board' : 'Read-only mirror')
                      : connecting ? 'Standing up the connection' : 'Your board is local on this device'}
                  </div>
                </div>
                {spineConnected && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                    padding: '4px 10px', borderRadius: 6,
                    background: (spineCaps && spineCaps.canWrite) ? `${C.mint}15` : C.surfaceHi,
                    border: `1px solid ${(spineCaps && spineCaps.canWrite) ? `${C.mint}30` : C.border}`,
                  }}>
                    <span style={{
                      fontFamily: F.mono, fontSize: 10, letterSpacing: '0.08em',
                      textTransform: 'uppercase', color: C.text,
                    }}>{(spineCaps && spineCaps.canWrite) ? 'Writable' : 'Read-only'}</span>
                  </div>
                )}
              </div>

              {/* Capability badges — canWrite / canRetier / canResolve from spineState.capabilities */}
              {spineConnected && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[
                    { key: 'canWrite', label: 'Write' },
                    { key: 'canRetier', label: 'Re-tier' },
                    { key: 'canResolve', label: 'Resolve' },
                  ].map((b) => {
                    const on = !!(spineCaps && spineCaps[b.key]);
                    return (
                      <span key={b.key} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        fontFamily: F.mono, fontSize: 10, letterSpacing: '0.06em',
                        textTransform: 'uppercase', padding: '4px 9px', borderRadius: 6,
                        color: on ? C.text : C.textDim,
                        background: on ? `${C.mint}15` : C.surface,
                        border: `1px solid ${on ? `${C.mint}40` : C.border}`,
                      }}>
                        {on ? <Check size={11} color={C.mint} strokeWidth={2.5} />
                          : <X size={11} strokeWidth={2} />}
                        {b.label}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* TYPED ERROR — 401 → a specific message; a 404 / Not Found → a path hint
                  (the server was reached but the /mcp path is likely missing); every other
                  failure is a connection-class failure the browser won't let JS pin down (CORS vs
                  network vs mixed-content are deliberately indistinguishable) → a checklist. */}
              {spineDegraded && (
                <div style={{
                  padding: '12px 14px', background: `${C.coral}10`,
                  border: `1px solid ${C.coral}30`, borderRadius: 8,
                  display: 'flex', gap: 10,
                }}>
                  <AlertTriangle size={15} color={C.coral} strokeWidth={2}
                    style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {spineAuthError ? (
                      <div style={{ fontFamily: F.body, fontSize: 13, color: C.text }}>
                        Authentication failed — check your token.
                      </div>
                    ) : (/\b404\b|not\s*found/i.test(spineErrMsg || '')) ? (
                      <>
                        <div style={{ fontFamily: F.body, fontSize: 13, color: C.text, marginBottom: 6 }}>
                          Endpoint not found.
                        </div>
                        <div style={{ fontFamily: F.mono, fontSize: 11, color: C.textMuted, lineHeight: 1.7 }}>
                          The server answered but nothing lives at that path. MCP endpoints usually live at /mcp: try appending it to your spine URL.
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontFamily: F.body, fontSize: 13, color: C.text, marginBottom: 6 }}>
                          Couldn’t connect. Check:
                        </div>
                        <ul style={{
                          margin: 0, paddingLeft: 16, fontFamily: F.mono, fontSize: 11,
                          color: C.textMuted, lineHeight: 1.7,
                        }}>
                          <li>the spine is running and the URL is correct;</li>
                          <li>if it’s up, its allowed origin must include this site’s origin
                            (<span style={{ color: C.text }}>{origin}</span>);</li>
                          <li>a deployed https page can’t reach a http://localhost spine — use a tunnel.</li>
                        </ul>
                      </>
                    )}
                    {spineErrMsg && (
                      <div style={{ fontFamily: F.mono, fontSize: 10, color: C.textDim, marginTop: 6 }}>
                        ({spineErrMsg})
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* FORM — Spine URL + Bearer token (maskable), prefilled from config.mcp */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={fieldLabel}>Spine URL</label>
                <input value={spineUrl} onChange={(e) => setSpineUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && doSpineConnect()}
                  placeholder="http://localhost:8848/mcp"
                  spellCheck={false} autoCapitalize="none" autoComplete="off"
                  style={{ ...input, flex: 'unset' }} />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={fieldLabel}>Bearer token</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={spineToken} onChange={(e) => setSpineToken(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && doSpineConnect()}
                    type={showToken ? 'text' : 'password'}
                    placeholder="optional — Bearer token"
                    spellCheck={false} autoCapitalize="none" autoComplete="off"
                    style={input} />
                  <button onClick={() => setShowToken((s) => !s)}
                    title={showToken ? 'Hide token' : 'Show token'} style={pillBtn}>
                    {showToken ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              {/* Remember-token opt-in (spec Auth v1: token in memory by default;
                  persisting to localStorage is an explicit opt-in). Default UNCHECKED. */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={rememberToken}
                  onChange={(e) => setRememberToken(e.target.checked)}
                  style={{ cursor: 'pointer', accentColor: C.ice, width: 14, height: 14, flexShrink: 0 }}
                />
                <span style={{ fontFamily: F.body, fontSize: 13, color: C.text }}>
                  Remember this server's token on this device
                </span>
              </label>

              {/* Contextual localhost note (PART 2) */}
              {localhostConflict ? (
                <div style={{
                  padding: '12px 14px', background: `${C.amber}12`,
                  border: `1px solid ${C.amber}40`, borderRadius: 8,
                  fontFamily: F.mono, fontSize: 11, color: C.textMuted, lineHeight: 1.6,
                }}>
                  A deployed (https) page can’t reach a localhost spine (mixed content +
                  Private Network Access). Use a Cloudflare Tunnel or other https endpoint.
                </div>
              ) : (
                <div style={helperText}>
                  The spine must be reachable from this browser and allow this site’s origin (CORS).
                </div>
              )}

              {/* ACTIONS — Connect/Save triggers the reconnect; Disconnect degrades to local */}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={doSpineConnect} disabled={connecting || !spineUrl.trim()}
                  style={{
                    ...addBtn,
                    opacity: (connecting || !spineUrl.trim()) ? 0.5 : 1,
                    cursor: (connecting || !spineUrl.trim()) ? 'default' : 'pointer',
                  }}>
                  {connecting ? 'Connecting…' : spineConnected ? 'Save & reconnect' : 'Connect'}
                </button>
                {(spineConnected || spineDegraded || initialMcp.url) && (
                  <button onClick={doSpineDisconnect} style={{
                    padding: '8px 14px', background: 'transparent', color: C.coral,
                    border: `1px solid ${C.coral}66`, borderRadius: 7, cursor: 'pointer',
                    fontFamily: F.body, fontSize: 12, fontWeight: 500,
                  }}>
                    Disconnect
                  </button>
                )}
              </div>

              {/* PART 2 GUIDANCE — origin whitelist, copy-pasteable + exact for this site */}
              <div>
                <div style={{ ...fieldLabel, marginBottom: 8 }}>Allow this origin on your spine</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                  <code style={{
                    flex: 1, minWidth: 0, fontFamily: F.mono, fontSize: 11, color: C.text,
                    background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7,
                    padding: '8px 11px', overflowX: 'auto', whiteSpace: 'nowrap',
                    display: 'flex', alignItems: 'center',
                  }}>{originEnvLine}</code>
                  <button onClick={copyOrigin} style={pillBtn}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div style={{ ...helperText, marginTop: 6 }}>
                  Set this on your spine (env var) so it accepts requests from this site.
                </div>
              </div>

              {/* Token trust note — context-sensitive (spec Auth v1) */}
              <div style={helperText}>
                {rememberToken
                  ? 'Token saved to localStorage on this device. Any script running on this page can read it — CSP is the practical defense. Only save tokens you trust.'
                  : 'Token held in memory only — not saved to localStorage. You will need to re-enter it after a page reload.'}
              </div>
            </div>
          )}

          {/* ARCHIVE — the kanbantt_config `archive` sub-key ({ autoAgeDays, showArchived }),
              modeled on the Connection tab: a status row driven by the controller's truth
              (spineCaps.canArchive), then the editable settings. The settings persist
              regardless of connection state; the sweep itself only runs against a live
              spine that advertises card_archive. */}
          {tab === 'archive' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: 14, background: C.surface, borderRadius: 10,
                border: `1px solid ${(spineCaps && spineCaps.canArchive) ? `${C.mint}40` : C.border}`,
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '50%',
                  background: C.surfaceHi, border: `1px solid ${C.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <Archive size={18} strokeWidth={1.5}
                    color={(spineCaps && spineCaps.canArchive) ? C.mint : C.textDim} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: F.body, fontSize: 14, color: C.text, fontWeight: 500 }}>
                    {(spineCaps && spineCaps.canArchive) ? 'Governed archive available' : 'Archive unavailable'}
                  </div>
                  <div style={{ fontFamily: F.mono, fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                    {(spineCaps && spineCaps.canArchive)
                      ? 'card_archive advertised — every archive is audited on the spine'
                      : 'Connect a spine that advertises card_archive'}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={fieldLabel}>Auto-archive delivered cards after</label>
                <select
                  value={archiveConfig && archiveConfig.autoAgeDays != null ? String(archiveConfig.autoAgeDays) : ''}
                  onChange={(e) => onArchiveConfigChange({ autoAgeDays: e.target.value === '' ? null : Number(e.target.value) })}
                  style={{ ...input, flex: 'unset', cursor: 'pointer' }}>
                  <option value="">Off</option>
                  <option value="1">1 day</option>
                  <option value="2">2 days</option>
                  <option value="3">3 days</option>
                  <option value="5">5 days</option>
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                </select>
                <div style={helperText}>
                  A client-side sweep (on load and periodically) archives delivered cards older
                  than this. v1 measures age from the card's last update (updated_at) — there is
                  no delivered-transition timestamp on the wire — so any later edit resets the
                  clock. Cards with an unresolved escalation are skipped loudly, never buried.
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  onClick={() => onArchiveConfigChange({ showArchived: !(archiveConfig && archiveConfig.showArchived) })}
                  aria-pressed={!!(archiveConfig && archiveConfig.showArchived)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
                    fontFamily: F.mono, fontSize: 10, letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    background: (archiveConfig && archiveConfig.showArchived) ? `${C.ice}22` : 'transparent',
                    border: `1px solid ${(archiveConfig && archiveConfig.showArchived) ? `${C.ice}55` : C.border}`,
                    color: (archiveConfig && archiveConfig.showArchived) ? C.ice : C.textMuted,
                  }}>
                  <Archive size={11} strokeWidth={1.75} />
                  {(archiveConfig && archiveConfig.showArchived) ? 'Showing archived' : 'Show archived'}
                </button>
                <div style={{ ...helperText, marginTop: 0 }}>
                  Default off — archived cards stay out of every view. Same toggle as the filter bar.
                </div>
              </div>
            </div>
          )}
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
  // Device-local top-level view preference: synchronous lazy read, same mechanism
  // as Calendar's K_CAL_VIEW / Timeline's K_TIMELINE_VIEW. Anything else (incl.
  // absent, e.g. first visit) falls back to Board.
  const [view, setView] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem(K_VIEW));
      return v === 'board' || v === 'calendar' || v === 'gantt' || v === 'matrix' ? v : 'board';
    } catch { return 'board'; }
  });
  useEffect(() => { safeSet(K_VIEW, view); }, [view]);
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
  // The active MCP connection (provider + pollNow), captured so the escalation-resolve
  // handler can reach the provider without re-deriving it. Set in the connection effect.
  const spineConnRef = useRef(null);
  // Tracks whether the user made local card mutations during an initial-load retry loop.
  // Prevents auto-switching to MCP (which would clobber in-progress local work) when
  // a background retry succeeds. Reset on each new connection attempt.
  const localEditedRef = useRef(false);
  // In-memory Bearer token (spec Auth v1: "Token held in memory by default"). Set by
  // handleSpineConnect when remember_token is false; null on page load so only a
  // remembered (persisted) token auto-connects on reload. Cleared on disconnect.
  const inMemoryTokenRef = useRef(null);
  // Bump to trigger a spine RECONNECT: the connection effect below depends on this, so
  // incrementing it re-runs the effect — React first tears down the existing conn
  // (cleanup: unsub + conn.disconnect() + clear the ref), then rebuilds from the fresh
  // kanbantt_config. The Connection settings tab drives this on connect/disconnect; no
  // page reload. (Distinct from handleReconnect, which re-acquires the GOOGLE token.)
  const [spineConfigNonce, setSpineConfigNonce] = useState(0);
  // Archive settings — the kanbantt_config `archive` sub-key (spec v0.4.0 client
  // behavior): { autoAgeDays: null|number, showArchived: boolean }. Device-local,
  // read once on mount (readKanbanttConfig supplies the defaults), persisted on
  // change like the mcp target. showArchived doubles as the poll's include_archived
  // flag, read through a ref so the connection's per-tick getter never goes stale.
  const [archiveCfg, setArchiveCfg] = useState(() => readKanbanttConfig().archive || { autoAgeDays: null, showArchived: false });
  const showArchived = !!archiveCfg.showArchived;
  const showArchivedRef = useRef(showArchived);
  useEffect(() => { showArchivedRef.current = showArchived; }, [showArchived]);
  // Calendar/Timeline overlay plumbing stays wired to this empty list as an
  // attachment point for real Google Calendar integration.
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
  // neutral display defaults (null due = no chip; never fabricate a date).
  const mcpActive = !!(spineState && spineState.provider === 'mcp' && spineModel);
  // True while the controller is in RECONNECTING state (mid-session drop with backoff
  // retry active). In this state: provider stays 'mcp' (mcpActive remains true, board
  // keeps rendering last-known cards), but ALL writes are suppressed — same mechanics
  // as the existing read-only mode — and a stale banner is shown.
  const mcpReconnecting = !!(spineState && spineState.provider === 'mcp' && spineState.reconnecting);
  // canWrite is capability-detected by the provider (all four card_* write tools
  // advertised) and threaded through the connection state. It splits a live spine
  // into two modes that the write handlers below branch on:
  //   mcpWritable (Pass 2b) — board writes (move/update/delete) route through the
  //     provider and reconcile from the spine; they NEVER touch the local store.
  //   mcpReadOnly — a read pair only (board_get + card_list); the board is a
  //     read-only mirror and every write affordance is gated off (drag/edit/delete).
  // During RECONNECTING both are treated as read-only (writes blocked, stale banner shown).
  // SPLIT-BRAIN: in BOTH MCP modes the local canonical store is left untouched — a
  // writable spine reconciles into transient React state (spineModel), so a later
  // disconnected boot can never mistake a stale mirror for local truth (see the
  // connection effect's guard). card_create stays deferred — see canCreate below.
  const mcpCanWrite = !!(spineState && spineState.capabilities && spineState.capabilities.canWrite);
  const mcpReadOnly = (mcpActive && !mcpCanWrite) || mcpReconnecting;
  const mcpWritable = mcpActive && mcpCanWrite && !mcpReconnecting;
  // canResolve gates the ONE permitted mutation in MCP mode (escalation approve/deny),
  // threaded via state.capabilities exactly like canWrite. It is INDEPENDENT of
  // mcpReadOnly: a read-only board mirror can still resolve escalations.
  const mcpCanResolve = !!(spineState && spineState.capabilities && spineState.capabilities.canResolve);
  // canRetier gates the GOVERNED tier-change control (card_retier), threaded via
  // state.capabilities exactly like canResolve. It is INDEPENDENT of canWrite — a
  // server may advertise the audited re-tier without the full card_* write set — so
  // the re-tier affordance gates on THIS flag, never on canWrite.
  const mcpCanRetier = !!(spineState && spineState.capabilities && spineState.capabilities.canRetier);
  // canArchive / canUnarchive gate the governed archive pair, threaded exactly like
  // canRetier — each derived from its OWN advertised tool, independent of canWrite
  // (a card_archive-only spine is a valid ONE-WAY archiver: archive affordances
  // render, unarchive stays hidden).
  const mcpCanArchive = !!(spineState && spineState.capabilities && spineState.capabilities.canArchive);
  const mcpCanUnarchive = !!(spineState && spineState.capabilities && spineState.capabilities.canUnarchive);
  // canTargetProjects gates the project-targeting read (project_list, spec v0.6.0
  // §Projects) — derived from its own advertised tool exactly like canRetier,
  // independent of canWrite. On such a spine a board create MUST name a live
  // project; the enumeration below feeds the QuickAdd picker.
  const mcpCanTargetProjects = !!(spineState && spineState.capabilities && spineState.capabilities.canTargetProjects);
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
        dueDate: c.due ?? null, // spec Card uses `due`; null = no chip, never fabricate
        effort: c.effort,
        impact: c.impact,
        priority: c.priority || 'med',
        tags: c.tags || [],
        checklist: c.checklist || [],
        // Pass 2b write-through fields. The Card lens echoes acceptance_criteria
        // and the write-once tier; the `...c` spread already carries them, but
        // enumerate them explicitly (like badge) so the MCP-writable modal can edit
        // them legibly and robustly — acceptance_criteria defaults to '' so the
        // textarea is always controlled; tier stays null when untiered.
        acceptance_criteria: c.acceptance_criteria || '',
        tier: c.tier ?? null,
        // Archive flag (spec v0.4.0): non-null = archived. The `...c` spread already
        // carries it; enumerated (like badge/tier) because the shared filter, the
        // per-card control, and both sweeps all key off it.
        archived_at: c.archived_at ?? null,
        // E1 escalation display: card_list attaches a per-card escalation badge
        // ({ kind:'escalation', id, reason, control_diff }) or null. The `...c`
        // spread above already carries it, but enumerate it explicitly — the card
        // and modal now consume `task.badge`, so this keeps the contract legible
        // (and robust if the spread is ever narrowed). Display only; the board
        // never resolves or clears it here.
        badge: c.badge || null,
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
    // Reconnect path (spineConfigNonce bumped by the Connection settings tab): React
    // first ran the previous cleanup (tore down the old conn, unsubscribed, cleared the
    // ref); now reset the transient spine state so a DISCONNECT (no target) reverts the
    // board to local, and a SERVER SWITCH doesn't momentarily show the prior server's
    // caps. On the initial mount both are already null → these are no-ops.
    setSpineState(null);
    setSpineModel(null);
    if (!hasMcpTarget(config)) return undefined;
    // Lazy-load the connection module (and the MCP SDK it pulls in) only when a
    // spine target is configured — keeps the SDK out of the default bundle.
    let conn = null;
    let unsub = () => {};
    let disposed = false;
    import('./lib/mcp-connection.js')
      .then(({ createMcpConnectionFromConfig, reconcileSpineModel }) => {
        if (disposed) return;
        // SPLIT-BRAIN GUARD: applyModel lands polled board_get/card_list snapshots
        // ONLY in transient React state (setSpineModel), NEVER in the card store (the
        // Local canonical in localStorage). Combined with every store-mutating handler
        // short-circuiting on mcpActive, the local board is left byte-for-byte untouched
        // while a spine is connected, so a later disconnected boot (or a boot with a
        // writable token) can never mistake a stale read-only mirror for local truth.
        // Do NOT route spineModel into the store.
        //
        // PURGE-RULE GUARD (spec v0.4.0 §Archive): the poll's replace is wrapped in
        // reconcileSpineModel — a locally-held card with non-null archived_at is NOT
        // purged when a DEFAULT fetch's results omit it (archived cards are absent
        // from default full fetches BY DESIGN; absence there is not deletion). Purge
        // authority over archived cards requires an include_archived:true fetch —
        // which the poll runs exactly when "Show archived" is on (the ref-backed
        // getter below, re-read every tick).
        localEditedRef.current = false; // reset per-connection local-edit tracking
        conn = createMcpConnectionFromConfig({
          config,
          // Auth v1: in-memory token (remember_token: false) passed explicitly; null on
          // initial load so only a remembered (persisted) token auto-connects on reload.
          authToken: inMemoryTokenRef.current || undefined,
          applyModel: (next) => setSpineModel((prev) => reconcileSpineModel(prev, next)),
          includeArchived: () => showArchivedRef.current,
        });
        spineConnRef.current = conn; // expose to the escalation-resolve handler
        unsub = conn.subscribe((st) => {
          setSpineState(st);
          // Mid-session reconnecting: provider stays 'mcp', keep last-known spineModel.
          // Initial-load failure/retrying: provider is 'local', clear to avoid stale data.
          if (st.provider !== 'mcp') setSpineModel(null);
          // Auto-switch on initial-load recovery — but ONLY if no local edits were made
          // (prevents clobbering in-progress local work). If local edits exist, we let the
          // "server reachable — switch?" affordance (rendered below) handle it explicitly.
          if (st.serverReachable && !localEditedRef.current) {
            conn.switchToMcp().catch(() => {});
          }
        });
        conn.connect();
      })
      .catch((e) => { console.error('MCP connection load failed:', e); });
    return () => { disposed = true; unsub(); if (conn) conn.disconnect(); spineConnRef.current = null; };
  }, [spineConfigNonce]);

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

  // ── BYO-spine (MCP) connection settings — the "connect from the web" flow ──────
  // Persist the entered target into kanbantt_config (MERGED — data_source and
  // poll_interval_ms are preserved), then bump the reconnect nonce so the connection
  // effect tears the old conn down and stands a fresh one up against the new config.
  const handleSpineConnect = async (url, token, rememberToken) => {
    const trimmedUrl = (url || '').trim();
    const trimmedToken = (token || '').trim();
    const cfg = readKanbanttConfig();
    const next = {
      ...cfg,
      // Never leave the source pinned to 'local' when the user is explicitly connecting;
      // 'auto' lets hasMcpTarget() honor the url. A pre-existing 'mcp' is preserved.
      data_source: cfg.data_source === 'local' ? 'auto' : (cfg.data_source || 'auto'),
      mcp: { ...(cfg.mcp || {}), url: trimmedUrl, remember_token: !!rememberToken },
    };
    if (rememberToken && trimmedToken) {
      // Opt-in: persist the token (spec §Configuration: auth_token present only if remember_token).
      next.mcp.auth_token = trimmedToken;
    } else {
      // Default: token stays in memory only; drop any previously-persisted token (e.g. the
      // user unchecked "Remember" — their stored token is revoked from localStorage on save).
      delete next.mcp.auth_token;
    }
    // Hold the token in memory for the upcoming connection effect (auth v1 default path).
    // Null on a remember-on connect — the token rides in config, not in memory.
    inMemoryTokenRef.current = (!rememberToken && trimmedToken) ? trimmedToken : null;
    await safeSet('kanbantt_config', next);
    setSpineConfigNonce((n) => n + 1);
  };
  // Disconnect: pin data_source:'local' and clear the mcp target in kanbantt_config
  // (MERGED — other fields preserved), then bump the nonce so the effect tears down and
  // degrades to local. Pinning local is what makes the disconnect STICK even if a build
  // env baseline (VITE_SPINE_URL) would otherwise re-supply a target.
  const handleSpineDisconnect = async () => {
    const cfg = readKanbanttConfig();
    inMemoryTokenRef.current = null; // spec Auth v1: disconnect clears the in-memory token
    await safeSet('kanbantt_config', { ...cfg, data_source: 'local', mcp: {} });
    setSpineConfigNonce((n) => n + 1);
  };
  // Manual retry: resets backoff and fires an immediate reconnect attempt.
  // Works in both mid-session reconnecting and initial-load retrying states.
  const handleSpineRetry = () => { spineConnRef.current?.retryNow?.(); };
  // Accept the pending initial-load MCP switch (user clicked the "switch?" affordance
  // after local edits prevented the auto-switch).
  const handleSpineSwitchToMcp = () => {
    localEditedRef.current = false;
    spineConnRef.current?.switchToMcp?.().catch(() => {});
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
  // Mark that the user made a local card mutation while the initial-load retry loop
  // is active. Prevents auto-switching to MCP when a background retry succeeds —
  // no rug-pulls while the user has in-progress local work.
  const markLocalEdited = () => {
    if (spineState && spineState.provider === 'local' && spineState.reconnecting) {
      localEditedRef.current = true;
    }
  };
  // TRANSIENT variant — the SAME banner slot/component as surface() (one notice
  // surface, two dismissal policies; no new component), auto-dismissing after ~4s.
  // Success-class messages only (the bulk/auto sweep's "Archived N of N."); anything
  // warning-class goes through surface(), which never auto-dismisses. The equality
  // guard keeps a late timer from clearing a NEWER notice that replaced this one.
  const noticeTimerRef = useRef(null);
  const surfaceTransient = (msg, ms = 4000) => {
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice((cur) => (cur === msg ? null : cur));
    }, ms);
  };
  const lastOrderOf = (columnId, excludeId) => {
    const inCol = liveColumnCards(getSnapshot(), columnId, excludeId);
    return inCol.length ? inCol[inCol.length - 1].order : null;
  };

  // ── Pass 2b write-through helpers (used only on the MCP-writable path) ────
  // The active spine provider (board writes go through it). null if the
  // connection dropped between render and the write — handlers bail loudly.
  const spineProvider = () => {
    const conn = spineConnRef.current;
    return (conn && conn.getProvider && conn.getProvider()) || null;
  };
  // Secondary reconciliation backstop: nudge ONE poll after a successful write so
  // any server-side side effect (a neighbor re-rank, a cleared badge) reconciles
  // without waiting up to 5s. The returned Card is the PRIMARY reconcile; this is
  // belt-and-suspenders. Fire-and-forget — the optimistic state stands until it lands.
  const reconcileSpine = () => {
    const conn = spineConnRef.current;
    if (conn && conn.pollNow) Promise.resolve(conn.pollNow()).catch(() => {});
  };
  // The project-targeting read (spec v0.6.0 §Projects): enumerate the spine's live
  // projects once per WRITABLE session so creates can target one. null = not yet
  // fetched / unavailable — on a project-aware spine the create affordance stays
  // hidden until the enumeration lands (an untargeted create there would only fail
  // loudly server-side, so the board never offers one it cannot land). Refetches
  // when mcpWritable re-flips true after a reconnect cycle.
  const [spineProjects, setSpineProjects] = useState(null);
  useEffect(() => {
    if (!(mcpWritable && mcpCanTargetProjects)) { setSpineProjects(null); return undefined; }
    const conn = spineConnRef.current;
    const provider = (conn && conn.getProvider && conn.getProvider()) || null;
    if (!provider) return undefined;
    let stale = false;
    provider.projectList().then(
      (projects) => { if (!stale) setSpineProjects(projects); },
      () => { if (!stale) setSpineProjects(null); },
    );
    return () => { stale = true; };
  }, [mcpWritable, mcpCanTargetProjects]);
  // The board-create affordance in MCP mode: rides canWrite (card_create is part of
  // the four-tool write set behind it), and on a project-aware spine ALSO needs at
  // least one live project to target.
  const mcpCanCreate = mcpWritable && (!mcpCanTargetProjects || !!(spineProjects && spineProjects.length));
  // HUMAN-INTAKE pinning: a board-side create enters the spine's intake column — the
  // FIRST served column ('created' on the Claunker spine) — never an arbitrary rung.
  const mcpIntakeColumnId = (mcpActive && spineModel && spineModel.columns.length) ? spineModel.columns[0].id : null;
  // Persistent-banner copy for a failed spine write. A stale write (code
  // 'conflict') and a deleted target get clearer lines; everything else carries
  // the provider's message/code so a failure is never silent. (surface() does NOT
  // auto-dismiss — the banner stays until the user closes it.)
  const writeError = (verb, e) => {
    if (e?.code === 'conflict') {
      return e.meta?.current?.deleted_at
        ? `That card was deleted on the spine — your ${verb} was reverted.`
        : `Card changed on the spine — your ${verb} was reverted. Try again.`;
    }
    if (e?.code === 'not_found') {
      return `That card no longer exists on the spine — your ${verb} was dropped.`;
    }
    return `Couldn't ${verb} — reverted. (${e?.message || e?.code || 'error'})`;
  };
  // Field-write notice (save/retier/archive convergence): failureTruth's classification
  // drives the wording — 'stale' (the card is still live; someone else changed it first,
  // so OUR write was undone) vs 'gone' (tombstoned or not_found; someone deleted it, so
  // our action never applied to anything). 'unknown' (transport/unproven) has no server
  // truth to report, so it falls back to the generic writeError() text.
  const mutationNotice = (action, e) => {
    const truth = failureTruth(e);
    if (truth === 'stale') return `This card changed elsewhere; your ${action} was undone.`;
    if (truth === 'gone') return `This card was deleted elsewhere; your ${action} was cancelled.`;
    return writeError(action === 'retier' ? 're-tier' : action, e);
  };
  // Mint the destination column + LexoRank from the drop neighbors, reading from
  // the given cards source ({ cards }). SHARED by the local-store and MCP-writable
  // drag paths — the only thing that differs between them is the destination (store
  // vs provider), never the ordering math. Returns null if the target vanished.
  const computeDropOrder = (source, draggedId, target) => {
    let columnId;
    let order;
    if (target.type === 'card') {
      const targetCard = source.cards.find((c) => c.id === target.id && !c.deleted_at);
      if (!targetCard) return null;
      columnId = targetCard.column_id;
      const colCards = liveColumnCards(source, columnId, draggedId);
      const tIdx = colCards.findIndex((c) => c.id === target.id);
      const prev = tIdx > 0 ? colCards[tIdx - 1] : null; // insert before target
      order = orderBetween(prev ? prev.order : null, targetCard.order);
    } else {
      columnId = target.id;
      const colCards = liveColumnCards(source, columnId, draggedId);
      const last = colCards.length ? colCards[colCards.length - 1] : null;
      order = orderBetween(last ? last.order : null, null); // append to end
    }
    return { columnId, order };
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

  // ── MCP-writable write-through core (Pass 2b) ───────────────────────────
  // Each mutates ONLY transient React state (spineModel), NEVER the local store
  // (preserving the read-only build's split-brain guard). Shape, every one:
  // CAPTURE prior state (incl. the spec-required version) → OPTIMISTIC apply →
  // call the provider → on SUCCESS reconcile with the returned Card (merge) and
  // nudge a backstop poll → on FAILURE reconcile SYNCHRONOUSLY (not waiting for
  // the 5s poll) and surface a persistent error banner. The two STRUCTURAL writes
  // (move/delete) reconcile failure through the uniform snap-back core
  // (spine-snapback.js: adopt a live meta.current / drop a gone card / restore
  // prior on unproven truth); the field writes keep the same three-way branch
  // inline pending the same consolidation.
  const moveTaskMcp = async (draggedId, target) => {
    const provider = spineProvider();
    const model = spineModel;
    if (!provider || !model) { surface('No live spine connection — move not sent.'); return; }
    const dragged = model.cards.find((c) => c.id === draggedId && !c.deleted_at);
    if (!dragged) return;
    const computed = computeDropOrder(model, draggedId, target);
    if (!computed) return;
    const { columnId, order } = computed;
    const prior = dragged; // CAPTURE the full pre-optimistic card (snap-back's restore/re-insert source)
    const expected_version = dragged.version;
    setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // OPTIMISTIC
      c.id === draggedId ? { ...c, column_id: columnId, order } : c) } : m));
    try {
      const card = await provider.cardMove(draggedId, columnId, { order, expected_version });
      setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // RECONCILE (merge)
        c.id === draggedId ? { ...c, ...card } : c) } : m));
      reconcileSpine();
    } catch (e) {
      // UNIFORM SNAP-BACK (spine-snapback.js) — converge on what the failure PROVES:
      // conflict+live → adopt meta.current (the server already moved this card on;
      // restoring our captured prior would snap it to a position the server no
      // longer agrees with); conflict+tombstone or not_found → the card is gone,
      // drop it (polls never carry tombstones, so removal IS convergence — and a
      // ghost restore would only fail every later write); anything else → the write
      // never landed, restore prior (version-guarded against a mid-flight poll).
      setSpineModel((m) => (m ? { ...m, cards: snapBackCards(m.cards, { id: draggedId, error: e, prior }) } : m)); // SNAP-BACK (synchronous)
      if (failureTruth(e) !== 'unknown') reconcileSpine(); // known-truth convergence gets the success path's backstop poll
      surface(writeError('move', e));
    }
  };

  // Matrix-drag classify write-through (Pass 2): a drop writes straight through the
  // spine's plain card_update (effort/impact are ungoverned fields, same treatment as
  // title/AC — no audit trail needed) via the SAME CAPTURE → OPTIMISTIC → call →
  // RECONCILE / SNAP-BACK-or-REVERT shape as saveTaskMcp/moveTaskMcp. `undefined`
  // (the unsorted-drop case) is coerced to null — same as the tier `?? null`
  // treatment — since `undefined` never survives JSON serialization to the wire.
  const classifyTaskMcp = async (taskId, update) => {
    const provider = spineProvider();
    const model = spineModel;
    if (!provider || !model) { surface('No live spine connection — classify not sent.'); return; }
    const cur = model.cards.find((c) => c.id === taskId && !c.deleted_at);
    if (!cur) { surface('That card was deleted'); return; }
    const patch = {};
    if ('effort' in update) patch.effort = update.effort ?? null;
    if ('impact' in update) patch.impact = update.impact ?? null;
    const prior = { effort: cur.effort, impact: cur.impact }; // CAPTURE
    const expected_version = cur.version;
    setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // OPTIMISTIC
      c.id === taskId ? { ...c, ...patch } : c) } : m));
    try {
      const card = await provider.cardUpdate(taskId, { ...patch, expected_version });
      setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // RECONCILE (merge)
        c.id === taskId ? { ...c, ...card } : c) } : m));
      reconcileSpine();
    } catch (e) {
      const fresh = e?.code === 'conflict' && e.meta?.current;
      setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // SNAP-BACK-or-REVERT (synchronous)
        c.id === taskId
          ? (fresh ? { ...c, ...e.meta.current } : { ...c, effort: prior.effort, impact: prior.impact })
          : c) } : m));
      surface(writeError('classify', e));
    }
  };

  const saveTaskMcp = async (task) => {
    if (!task.title.trim()) return;
    const provider = spineProvider();
    const model = spineModel;
    if (!provider || !model) { surface('No live spine connection — changes not sent.'); return; }
    const cur = model.cards.find((c) => c.id === task.id && !c.deleted_at);
    if (!cur) { surface('That card was deleted'); setEditing(null); return; }
    // Patch only the spine-Card fields the modal edits and only those that actually
    // changed. A column change is a move, not an update — it never travels here.
    const patch = {};
    if (task.title !== cur.title) patch.title = task.title;
    // description: the narrative body (spec v0.8.0). Diffed against the current card so an
    // unchanged body is never re-sent; '' means an empty body (not "unchanged").
    if ((task.description || '') !== (cur.description || '')) patch.description = task.description || '';
    if ((task.acceptance_criteria || '') !== (cur.acceptance_criteria || '')) patch.acceptance_criteria = task.acceptance_criteria || '';
    if ((task.tier ?? null) !== (cur.tier ?? null)) patch.tier = task.tier ?? null;
    if ((task.effort ?? null) !== (cur.effort ?? null)) patch.effort = task.effort ?? null;
    if ((task.impact ?? null) !== (cur.impact ?? null)) patch.impact = task.impact ?? null;
    if ((task.due ?? null) !== (cur.due ?? null)) patch.due = task.due ?? null;
    // depends_on: order-insensitive diff; [] = clear per spec (null → validation_failed).
    const taskDepsKey = JSON.stringify([...(task.depends_on || [])].sort());
    const curDepsKey = JSON.stringify([...(cur.depends_on || [])].sort());
    if (taskDepsKey !== curDepsKey) patch.depends_on = task.depends_on || [];
    setEditing(null); // close immediately; the edit shows optimistically behind it
    if (Object.keys(patch).length === 0) return; // nothing changed → no write
    const prior = cur; // CAPTURE the full pre-optimistic card (snap-back's restore/re-insert source)
    const expected_version = cur.version;
    setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // OPTIMISTIC
      c.id === task.id ? { ...c, ...patch } : c) } : m));
    try {
      const card = await provider.cardUpdate(task.id, { ...patch, expected_version });
      setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // RECONCILE (merge)
        c.id === task.id ? { ...c, ...card } : c) } : m));
      reconcileSpine();
    } catch (e) {
      // UNIFORM SNAP-BACK (spine-snapback.js) — the SAME core as moveTaskMcp/deleteTaskMcp:
      // conflict+live → adopt meta.current (someone else's write already landed; restoring
      // our captured prior would undo THEIR change too); conflict+tombstone or not_found →
      // the card is gone, drop it; anything else → the write never landed, restore prior.
      setSpineModel((m) => (m ? { ...m, cards: snapBackCards(m.cards, { id: task.id, error: e, prior }) } : m)); // SNAP-BACK (synchronous)
      if (failureTruth(e) !== 'unknown') reconcileSpine(); // known-truth convergence gets the success path's backstop poll
      surface(mutationNotice('save', e));
    }
  };

  // Governed re-tier (card_retier) — the audited path that changes an ALREADY-SET
  // tier and writes a tier_audit row. SAME CAPTURE → OPTIMISTIC → call → reconcile /
  // loud-revert shape as saveTaskMcp, but ISOLATED to the tier: it rides card_retier,
  // NOT card_update, so a re-tier never carries title/AC (and a Save never carries the
  // tier). The modal owns the deliberate sub-flow; this owns the write + the SHARED
  // loud-revert path. It hands the fresh Card back so the modal re-locks at the new
  // tier; on failure it surfaces the persistent banner AND rethrows so the modal can
  // close its sub-flow (the banner is the one error surface — no new error path).
  // expected_version is the live card's opaque version token (cur.version), sourced
  // from spineModel exactly like every other write here — NOT the modal's snapshot.
  const retierTaskMcp = async (taskId, newTier, reason) => {
    const provider = spineProvider();
    const model = spineModel;
    if (!provider || !model) { surface('No live spine connection — re-tier not sent.'); return; }
    const cur = model.cards.find((c) => c.id === taskId && !c.deleted_at);
    if (!cur) { surface('That card was deleted'); return; }
    const prior = cur;                       // CAPTURE the full pre-optimistic card
    const expected_version = cur.version;    // the card's opaque version token
    setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // OPTIMISTIC
      c.id === taskId ? { ...c, tier: newTier } : c) } : m));
    try {
      const card = await provider.cardRetier(taskId, newTier, expected_version, reason);
      setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // RECONCILE (merge fresh tier + version)
        c.id === taskId ? { ...c, ...card } : c) } : m));
      reconcileSpine();
      return card; // hand the fresh Card back so the modal re-locks at the new tier
    } catch (e) {
      // UNIFORM SNAP-BACK (spine-snapback.js) — the SAME core as saveTaskMcp: conflict+live
      // snaps to the server's truth (fresh tier + version, so a retry uses the right
      // expected_version); conflict+tombstone or not_found drops the card; anything else
      // restores the captured prior tier. Either way the persistent error banner fires — a
      // re-tier conflict surfaces loudly exactly like the other governed writes.
      setSpineModel((m) => (m ? { ...m, cards: snapBackCards(m.cards, { id: taskId, error: e, prior }) } : m));
      if (failureTruth(e) !== 'unknown') reconcileSpine();
      surface(mutationNotice('retier', e));
      throw e; // let the modal close its sub-flow (the banner is the error surface)
    }
  };

  // Governed archive/unarchive (card_archive / card_unarchive) — the audited pair
  // that moves the orthogonal archived_at flag (spec v0.4.0 §Archive). SAME CAPTURE →
  // OPTIMISTIC → call → reconcile / loud-revert shape as retierTaskMcp, gated on
  // canArchive/canUnarchive (NOT canWrite). expected_version comes from the LIVE
  // spineModel card, never a modal snapshot. Reason is OMITTED → the server's
  // audited "manual_archive"/"manual_unarchive" default (an explicit reason is for
  // the sweeps, which pass canned strings). Rethrows on failure so the modal can
  // close its busy state — the persistent banner here is the one error surface.
  const archiveTaskMcp = async (id) => {
    const provider = spineProvider();
    const model = spineModel;
    if (!provider || !model) { surface('No live spine connection — archive not sent.'); return undefined; }
    const cur = model.cards.find((c) => c.id === id && !c.deleted_at);
    if (!cur) { surface('That card was deleted'); return undefined; }
    const prior = cur; // CAPTURE the full pre-optimistic card
    const expected_version = cur.version;
    setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // OPTIMISTIC (server stamp reconciles over this)
      c.id === id ? { ...c, archived_at: new Date().toISOString() } : c) } : m));
    try {
      const card = await provider.cardArchive(id, expected_version);
      setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // RECONCILE (merge fresh flag + version)
        c.id === id ? { ...c, ...card } : c) } : m));
      reconcileSpine();
      return card;
    } catch (e) {
      // UNIFORM SNAP-BACK (spine-snapback.js) — the SAME core as retierTaskMcp. FLAGGED
      // PARITY DECISION (see the work order): archive-on-tombstone is NOT special-cased
      // to a success toast here — delete's own tombstone path has no distinct success
      // shape to extend (it still fires the same persistent banner via writeError()), so
      // archive-on-tombstone gets the same "cancelled" notice as every other gone target.
      setSpineModel((m) => (m ? { ...m, cards: snapBackCards(m.cards, { id, error: e, prior }) } : m));
      if (failureTruth(e) !== 'unknown') reconcileSpine();
      surface(mutationNotice('archive', e));
      throw e;
    }
  };
  const unarchiveTaskMcp = async (id) => {
    const provider = spineProvider();
    const model = spineModel;
    if (!provider || !model) { surface('No live spine connection — unarchive not sent.'); return undefined; }
    const cur = model.cards.find((c) => c.id === id && !c.deleted_at);
    if (!cur) { surface('That card was deleted'); return undefined; }
    const prior = { archived_at: cur.archived_at ?? null }; // CAPTURE
    const expected_version = cur.version;
    setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // OPTIMISTIC
      c.id === id ? { ...c, archived_at: null } : c) } : m));
    try {
      const card = await provider.cardUnarchive(id, expected_version);
      setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // RECONCILE
        c.id === id ? { ...c, ...card } : c) } : m));
      reconcileSpine();
      return card;
    } catch (e) {
      const fresh = e?.code === 'conflict' && e.meta?.current;
      setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => // SNAP-BACK-or-REVERT
        c.id === id
          ? (fresh ? { ...c, ...e.meta.current } : { ...c, archived_at: prior.archived_at })
          : c) } : m));
      surface(writeError('unarchive', e));
      throw e;
    }
  };

  // ── Archive sweep core — SHARED by the bulk button and the age-rule auto sweep ──
  // SEQUENTIAL per-card card_archive (matching the app's one-write-at-a-time
  // precedent — there is no bulk tool on the wire), each success merged into the
  // model as it lands. A rejected card (unresolved escalation; or a conflict racing
  // the sweep) is SKIPPED and reported — never force-archived, never silent. One
  // backstop poll at the end instead of per-card.
  const sweepBusyRef = useRef(false);
  const [sweepingDelivered, setSweepingDelivered] = useState(false);
  const sweepArchive = async (targets, reason) => {
    const provider = spineProvider();
    if (!provider) return { archived: 0, skipped: [], total: targets.length };
    let archived = 0;
    const skipped = [];
    for (const t of targets) {
      try {
        const card = await provider.cardArchive(t.id, t.version, reason);
        setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => (c.id === t.id ? { ...c, ...card } : c)) } : m));
        archived += 1;
      } catch (e) {
        skipped.push({ task: t, message: e?.message || e?.code || 'error' });
      }
    }
    reconcileSpine();
    return { archived, skipped, total: targets.length };
  };
  // LAYERED sweep reporting (locked): 100% success → transient toast (auto-dismisses);
  // ANY skip → the persistent warning banner (surface(), never auto-dismissed) naming
  // the count and identifying each skipped card inline — clicking one opens the card
  // (the same openEdit targeting every view already uses), so a buried escalation is
  // one click from human eyes.
  const reportSweep = (res) => {
    if (res.skipped.length === 0) {
      surfaceTransient(`Archived ${res.archived} of ${res.total}.`);
      return;
    }
    surface(
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        Archived {res.archived} of {res.total}. {res.skipped.length} skipped: unresolved escalation.
        {res.skipped.map((s) => (
          <button key={s.task.id} onClick={() => openEdit(s.task)} style={{
            background: 'transparent', border: `1px solid ${C.coral}66`, color: C.coral,
            padding: '2px 8px', borderRadius: 5, cursor: 'pointer',
            fontFamily: F.mono, fontSize: 11, maxWidth: 180,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }} title={`Open "${s.task.title}"`}>{s.task.title}</button>
        ))}
      </span>,
    );
  };
  // Bulk sweep "Archive all delivered": targets the CURRENTLY-VISIBLE delivered
  // cards (post-filter — what the user sees is what sweeps) that are not yet
  // archived. Wired to the delivered column's header button, gated on canArchive.
  const archiveAllDelivered = async () => {
    if (sweepBusyRef.current) return;
    const targets = filteredTasks.filter((t) => t.status === 'delivered' && t.archived_at == null && !t.deleted_at);
    if (!targets.length) return;
    sweepBusyRef.current = true;
    setSweepingDelivered(true);
    try {
      reportSweep(await sweepArchive(targets, 'bulk_archive_delivered'));
    } finally {
      sweepBusyRef.current = false;
      setSweepingDelivered(false);
    }
  };

  // Persist an archive-settings change (kanbantt_config.archive, merged like the mcp
  // target) and nudge one poll so a showArchived flip repaints promptly — the next
  // tick's card_list follows the new include_archived mode via the ref-backed getter.
  const updateArchiveConfig = (patch) => {
    setArchiveCfg((prev) => ({ ...prev, ...patch }));
    const cfg = readKanbanttConfig();
    safeSet('kanbantt_config', { ...cfg, archive: { ...(cfg.archive || {}), ...patch } });
    if ('showArchived' in patch) {
      showArchivedRef.current = !!patch.showArchived; // pre-effect, so the nudged poll already sees it
      reconcileSpine();
    }
  };

  // ── Age-rule AUTO sweep (client-side, v1) ────────────────────────────────────
  // With archive.autoAgeDays set, delivered cards older than the threshold are
  // swept on board load (mcpActive + canArchive coming true) and every 10 minutes
  // (age is measured in DAYS — a tighter timer buys nothing). KNOWN v1 IMPRECISION,
  // deliberate and flagged: the wire Card has NO delivered-transition timestamp
  // (the cards' "Yesterday" labels are DUE-DATE relative, not state-change times),
  // so age falls back to updated_at — any later edit resets the clock, and a card
  // updated while sitting in delivered postpones its own sweep. Targets come from
  // the FULL model (policy is not filter-scoped), read through a ref so the
  // interval never acts on a stale closure. Reporting is the SAME layered rule as
  // the bulk sweep, scaled down: swept nothing → SILENT (no toast spam every tick);
  // N>0 clean → the transient toast; ANY skip → the persistent banner (a buried
  // escalation is the same hazard whatever triggered the sweep) — re-surfaced only
  // when the SKIP SET changes, so a dismissed banner doesn't re-nag every interval
  // for the same stuck card.
  const spineTasksRef = useRef(null);
  useEffect(() => { spineTasksRef.current = spineTasks; }, [spineTasks]);
  const lastAutoSkipSigRef = useRef('');
  useEffect(() => {
    const days = archiveCfg.autoAgeDays;
    if (!mcpActive || !mcpCanArchive || !days || !(days > 0)) return undefined;
    let cancelled = false;
    const run = async () => {
      if (cancelled || sweepBusyRef.current) return;
      const cutoff = Date.now() - days * 86400000;
      const targets = (spineTasksRef.current || []).filter((t) =>
        t.status === 'delivered' && t.archived_at == null && !t.deleted_at
        && t.updated_at && Date.parse(t.updated_at) <= cutoff);
      if (!targets.length) return; // zero to do → silent
      sweepBusyRef.current = true;
      try {
        const res = await sweepArchive(targets, `auto_age_archive_${days}d`);
        if (cancelled) return;
        if (res.skipped.length === 0) {
          if (res.archived > 0) surfaceTransient(`Archived ${res.archived} of ${res.total}.`);
          return;
        }
        const sig = res.skipped.map((s) => s.task.id).sort().join(',');
        if (sig !== lastAutoSkipSigRef.current) {
          lastAutoSkipSigRef.current = sig;
          reportSweep(res);
        }
      } finally {
        sweepBusyRef.current = false;
      }
    };
    run(); // board load / rule change
    const h = setInterval(run, 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(h); };
    // run() reads live state via refs; deps re-arm on connection or rule changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpActive, mcpCanArchive, archiveCfg.autoAgeDays]);

  const deleteTaskMcp = async (id) => {
    const provider = spineProvider();
    const model = spineModel;
    if (!provider || !model) { surface('No live spine connection — delete not sent.'); return; }
    const cur = model.cards.find((c) => c.id === id && !c.deleted_at);
    setEditing(null);
    if (!cur) { surface('That card was deleted'); return; }
    const expected_version = cur.version;
    const priorCard = cur; // CAPTURE: its `order` encodes the board position → restore = re-insert
    setSpineModel((m) => (m ? { ...m, cards: m.cards.filter((c) => c.id !== id) } : m)); // OPTIMISTIC removal
    try {
      await provider.cardDelete(id, { expected_version });
      reconcileSpine(); // confirm removal against the authoritative card_list
    } catch (e) {
      // UNIFORM SNAP-BACK (spine-snapback.js) — the SAME core as moveTaskMcp; the
      // delete nuances fall out of the truth classes: conflict+tombstone or
      // not_found → already gone server-side, the delete effectively succeeded —
      // leave it removed, never resurrect; conflict+live (something else changed
      // first, e.g. a version bump from an unrelated edit) → the card still lives,
      // re-insert the server's fresh state over the captured prior, not our stale
      // copy; anything else → the write never landed, restore the captured prior
      // (version-guarded: a poll that already re-added it fresher is left standing).
      setSpineModel((m) => (m ? { ...m, cards: snapBackCards(m.cards, { id, error: e, prior: priorCard }) } : m)); // SNAP-BACK (synchronous)
      if (failureTruth(e) !== 'unknown') reconcileSpine(); // known-truth convergence gets the success path's backstop poll
      surface(writeError('delete', e));
    }
  };

  // Board-side create — HUMAN INTAKE into the spine. The board mints the client id
  // (so a retry replays idempotently per spec §Create) and the append-at-end order,
  // pins the intake column, sends NO tier (creation is intent capture: an intake
  // card is untiered, exactly like a hand-written one — classification and dispatch
  // are later, separate rungs the board never skips), and targets the project the
  // QuickAdd resolved. SAME OPTIMISTIC → call → RECONCILE / REVERT shape as the
  // writes above, minus the CAPTURE (no prior card) and minus a conflict branch:
  // card_create carries no expected_version — a duplicate id is idempotent success —
  // so ANY failure means the create never landed → remove the ghost + surface.
  const createTaskMcp = async (colId, title, projectId) => {
    const provider = spineProvider();
    const model = spineModel;
    if (!provider || !model) { surface('No live spine connection — card not created.'); return; }
    const id = globalThis.crypto.randomUUID();
    const inCol = model.cards.filter((c) => c.column_id === colId && !c.deleted_at).sort(compareCards);
    const order = orderBetween(inCol.length ? inCol[inCol.length - 1].order : null, null); // append to end
    // The optimistic ghost: enough Card shape to render (spineTasks defaults the
    // rest); created_at is display-only here and NEVER sent — the authority stamps
    // its own. The canonical returned card replaces it wholesale.
    const optimistic = { id, title, column_id: colId, order, tags: [], tier: null, created_at: new Date().toISOString() };
    setSpineModel((m) => (m ? { ...m, cards: [...m.cards, optimistic] } : m)); // OPTIMISTIC insert
    try {
      const card = await provider.cardCreate(
        { id, title, column_id: colId, order },
        projectId != null ? { project_id: projectId } : {},
      );
      setSpineModel((m) => (m ? { ...m, cards: m.cards.map((c) => (c.id === id ? card : c)) } : m)); // ADOPT canonical
      reconcileSpine();
    } catch (e) {
      setSpineModel((m) => (m ? { ...m, cards: m.cards.filter((c) => c.id !== id) } : m)); // REVERT: never landed
      surface(writeError('create', e));
    }
  };

  // ── Public write handlers — the split-brain routing (Pass 2b STEP f) ─────
  // Each branches on mode: mcpWritable → provider write-through; mcpActive but
  // read-only → blocked (the mirror stays read-only); else local → the card store.
  const saveTask = (task) => {
    if (mcpWritable) { saveTaskMcp(task); return; }
    if (mcpActive) { surface(READONLY_MSG); return; }
    markLocalEdited();
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
        // depends_on: order-insensitive diff, not in EDITABLE_FIELDS (JSON.stringify is order-sensitive).
        const taskDepsKey = JSON.stringify([...(task.depends_on || [])].sort());
        const curDepsKey = JSON.stringify([...(cur.depends_on || [])].sort());
        if (taskDepsKey !== curDepsKey) patch.depends_on = task.depends_on || [];
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
    if (mcpWritable) { deleteTaskMcp(id); return; }
    if (mcpActive) { surface(READONLY_MSG); return; }
    markLocalEdited();
    withConflict(() => {
      const cur = store.get(id);
      if (!cur) return;
      if (cur.deleted_at) { surface('That card was deleted'); return; }
      store.delete(id, { expected_version: cur.version });
    });
    setEditing(null);
  };

  // The ONE permitted mutation in MCP mode: resolve an escalation (operator approve/
  // deny). Distinct from the board's card-writes — those are gated OFF on a read-only
  // spine; this is gated on mcpCanResolve, INDEPENDENT of mcpReadOnly. Sends the
  // decision + rationale; the server derives the actor from the credential (never
  // sent). On success: optimistically reflect it in the polled model (approve clears
  // the badge; deny flips it to the red 'denied' receipt), then poll to reconcile from
  // card_list (the authoritative source).
  const handleResolveEscalation = async (escalationId, { resolution, resolution_rationale }) => {
    const conn = spineConnRef.current;
    const provider = conn && conn.getProvider && conn.getProvider();
    if (!provider) throw new Error('no active spine connection');
    await provider.escalationResolve(escalationId, { resolution, resolution_rationale });
    setSpineModel((m) => {
      if (!m) return m;
      return {
        ...m,
        cards: m.cards.map((c) => {
          if (!(c.badge && c.badge.id === escalationId)) return c;
          if (resolution === 'approve') return { ...c, badge: null };
          return { ...c, badge: { ...c.badge, status: 'denied', resolution_rationale } };
        }),
      };
    });
    // Reconcile from card_list (the source of truth); the optimistic state stands until
    // it lands. Fire-and-forget so the modal can close immediately.
    if (conn && conn.pollNow) Promise.resolve(conn.pollNow()).catch(() => {});
  };

  // Quick-add routing. MCP-writable → createTaskMcp (the once-deferred slice: human
  // intake, project-targeted); read-only mirror → blocked; local unchanged. The
  // modal "New task" stays LOCAL-ONLY (Header canCreate) — in MCP mode intake is
  // the title-only quick-add on the intake column, nothing richer.
  const quickAdd = (colId, title, projectId) => {
    if (mcpWritable) { createTaskMcp(colId, title, projectId); return; }
    if (mcpActive) { surface(READONLY_MSG); return; }
    markLocalEdited();
    const t = new Date();
    store.create({
      title, description: '', column_id: colId,
      startDate: iso(t), dueDate: iso(addDays(t, 3)),
      priority: 'med', tags: [], checklist: [],
    });
  };

  // Drag-and-drop. Mint the order from the drop neighbors (computeDropOrder handles
  // the null-neighbor cases: empty column, drop-before-first, append-to-end) then
  // route by mode — the destination is the only thing that changes (Pass 2b STEP b).
  const moveTask = (draggedId, target) => {
    if (mcpWritable) { moveTaskMcp(draggedId, target); return; }
    if (mcpActive) { surface(READONLY_MSG); return; }
    markLocalEdited();
    withConflict(() => {
      const dragged = store.get(draggedId);
      if (!dragged || dragged.deleted_at) { surface('That card was deleted'); return; }
      const computed = computeDropOrder(getSnapshot(), draggedId, target);
      if (!computed) return;
      store.move(draggedId, { column_id: computed.columnId, order: computed.order }, { expected_version: dragged.version });
    });
  };

  /* ---- board config (columns + tags) via the store --------------------- */
  // Every board-config mutation routes through a card-store method that owns the
  // integrity invariants (orphan-move on column delete, tag ref-strip on tag
  // delete). The app no longer computes replacement columns/tags arrays itself;
  // it only mints ids and picks the next accent/hue (UI palette concerns) before
  // handing the change to the store.
  const createTag = (tag) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    store.tagCreate(tag);
  };

  const addColumn = (label) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    const trimmed = label.trim();
    if (!trimmed) return;
    const id = `col-${uid('').slice(2, 8)}`;
    const accentKey = COLUMN_ACCENTS[columns.length % COLUMN_ACCENTS.length];
    store.columnCreate({ id, label: trimmed, accentKey });
  };
  const renameColumn = (id, label) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    store.columnUpdate(id, { label });
  };
  const recolorColumn = (id, accentKey) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
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
    if (mcpActive) { surface(READONLY_MSG); return; }
    const idx = columns.findIndex((c) => c.id === id);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= columns.length) return;
    store.columnReorder(id, target);
  };
  const deleteColumn = (id) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    // Guard mirrors the disabled delete control: the last column can't be deleted,
    // and we never call with a null destination. The store moves orphaned cards.
    if (columns.length <= 1) return;
    const fallback = columns.find((c) => c.id !== id).id;
    store.columnDelete(id, fallback);
  };

  const renameTag = (id, name) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    store.tagUpdate(id, { name });
  };
  const recolorTag = (id, color) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    // Explicit hue from the palette picker; fall back to cycling when omitted.
    let next = color;
    if (!next || !TAG_PALETTE[next]) {
      const cur = tags.find((t) => t.id === id);
      const idx = TAG_COLOR_CYCLE.indexOf(cur?.color);
      next = TAG_COLOR_CYCLE[(idx + 1) % TAG_COLOR_CYCLE.length];
    }
    store.tagUpdate(id, { color: next });
  };
  const deleteTag = (id) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    store.tagDelete(id); // store strips refs (live + tombstoned)
  };
  const addTag = (name) => {
    if (mcpActive) { surface(READONLY_MSG); return; }
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = `tag-${uid('').slice(2, 8)}`;
    const color = TAG_COLOR_CYCLE[tags.length % TAG_COLOR_CYCLE.length];
    store.tagCreate({ id, name: trimmed, color });
  };

  const classifyTask = (taskId, update) => {
    if (mcpWritable) { classifyTaskMcp(taskId, update); return; }
    if (mcpActive) { surface(READONLY_MSG); return; }
    withConflict(() => {
      const cur = store.get(taskId);
      if (!cur || cur.deleted_at) { surface('That card was deleted'); return; }
      const patch = {};
      if ('effort' in update) patch.effort = update.effort ?? null;
      if ('impact' in update) patch.impact = update.impact ?? null;
      store.update(taskId, patch, { expected_version: cur.version });
    });
  };

  // Apply filters over the active board source (local store, or the live spine
  // model while MCP is active). This memo is the ONE filtering seam every view
  // consumes (board/calendar/timeline/matrix — and the Dispatch Log board, which is
  // just a spine project rendered through the same views), so the archived gate
  // below applies everywhere by construction, wired once.
  const filteredTasks = useMemo(() => {
    return baseTasks.filter((t) => {
      // Show Archived (default OFF): archived cards are held in the model (the
      // purge guard retains them; an include_archived poll refreshes them) but
      // enter the views only when the toggle admits them. Local-mode tasks carry
      // no archived_at, so this gate is a no-op off the spine.
      if (t.archived_at != null && !showArchived) return false;
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
  }, [baseTasks, activeTags, filters, showArchived]);

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
          spineState={spineState} onSpineRetry={handleSpineRetry} canCreate={!mcpActive} />
        <FilterBar tags={activeTags} filters={filters} setFilters={setFilters}
          showArchived={showArchived}
          onToggleShowArchived={mcpActive ? () => updateArchiveConfig({ showArchived: !showArchived }) : undefined} />
        {/* RECONNECTING banner: mid-session drop — board shows last-known data, writes blocked */}
        {mcpReconnecting && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 20px', background: `${C.amber}18`, borderBottom: `1px solid ${C.amber}44`,
            fontFamily: F.body, fontSize: 12, color: C.amber, gap: 12,
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={12} strokeWidth={2} color={C.amber} />
              Connection lost — showing last-known data. Writes disabled until reconnected.
            </span>
            <button onClick={handleSpineRetry} style={{
              background: 'transparent', border: `1px solid ${C.amber}88`, borderRadius: 4,
              color: C.amber, padding: '2px 8px', cursor: 'pointer',
              fontFamily: F.mono, fontSize: 10, letterSpacing: '0.05em', textTransform: 'uppercase',
            }}>Retry now</button>
          </div>
        )}
        {/* SERVER REACHABLE banner: initial-load recovery, user made local edits → switch? */}
        {spineState && spineState.serverReachable && !mcpActive && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 20px', background: `${C.amber}18`, borderBottom: `1px solid ${C.amber}44`,
            fontFamily: F.body, fontSize: 12, color: C.amber, gap: 12,
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={12} strokeWidth={2} color={C.amber} />
              MCP server is reachable. Switch to live view? (local edits will be kept locally)
            </span>
            <button onClick={handleSpineSwitchToMcp} style={{
              background: 'transparent', border: `1px solid ${C.amber}88`, borderRadius: 4,
              color: C.amber, padding: '2px 8px', cursor: 'pointer',
              fontFamily: F.mono, fontSize: 10, letterSpacing: '0.05em', textTransform: 'uppercase',
            }}>Switch</button>
          </div>
        )}
        {view === 'board' && (
          <BoardView tasks={filteredTasks} tags={activeTags} columns={activeColumns}
            onTaskClick={openEdit} onMove={moveTask} onQuickAdd={quickAdd}
            readOnly={mcpReadOnly} canCreate={mcpActive ? mcpCanCreate : true}
            quickAddColumnId={mcpActive ? mcpIntakeColumnId : null}
            quickAddProjects={mcpActive && mcpCanTargetProjects ? (spineProjects || undefined) : undefined}
            allTasks={baseTasks}
            sweep={mcpActive && mcpCanArchive ? {
              columnId: 'delivered',
              count: filteredTasks.filter((t) => t.status === 'delivered' && t.archived_at == null && !t.deleted_at).length,
              busy: sweepingDelivered,
              onSweep: archiveAllDelivered,
            } : null} />
        )}
        {view === 'calendar' && (
          <CalendarView tasks={filteredTasks} events={events} columns={activeColumns} onTaskClick={openEdit} tags={activeTags} />
        )}
        {view === 'gantt' && (
          <GanttView tasks={filteredTasks} events={events} columns={activeColumns} onTaskClick={openEdit} />
        )}
        {view === 'matrix' && (
          // readOnly=mcpReadOnly (Pass 2, matches BoardView): matrix drag = classify
          // (effort/impact) now rides the same plain card_update write-through as
          // every other board write — gated on write capability, not on connection.
          <MatrixView tasks={filteredTasks} tags={activeTags}
            onTaskClick={openEdit} onClassify={classifyTask} readOnly={mcpReadOnly}
            allTasks={baseTasks} />
        )}
        {editing && (
          <TaskModal task={editing} tags={activeTags} columns={activeColumns} isNew={isNew}
            onSave={saveTask} onDelete={deleteTask}
            onClose={() => setEditing(null)} onCreateTag={createTag} readOnly={mcpReadOnly}
            mcpWritable={mcpWritable}
            canRetier={mcpCanRetier} onRetier={retierTaskMcp}
            canArchive={mcpCanArchive} canUnarchive={mcpCanUnarchive}
            onArchive={archiveTaskMcp} onUnarchive={unarchiveTaskMcp}
            canResolve={mcpCanResolve} onResolveEscalation={handleResolveEscalation}
            allTasks={baseTasks} />
        )}
        {/* SettingsModal readOnly=mcpActive (NOT mcpReadOnly): board-config
            (columns/tags) is NOT part of the Pass 2b card write-through, so it stays
            read-only on ANY live spine. (Settings reads columns/tags from the local
            store, which is intentionally untouched while a spine is connected.) */}
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
            syncStatus={syncStatus} onSyncNow={handleSyncNow} readOnly={mcpActive}
            spineState={spineState}
            onSpineConnect={handleSpineConnect} onSpineDisconnect={handleSpineDisconnect}
            archiveConfig={archiveCfg} onArchiveConfigChange={updateArchiveConfig} />
        )}
        {driveSync && syncStatus === 'collision_pending' && (
          <CollisionDialog onResolve={handleResolveCollision} busy={collisionBusy} />
        )}
      </div>
    </ThemeContext.Provider>
  );
}
