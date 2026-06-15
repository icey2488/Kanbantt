/**
 * Kanbantt — local-first card store with optimistic concurrency + delta sync.
 *
 * One JSON blob in localStorage under `kanbantt_data_v1`:
 *
 *   {
 *     schema_version: 1,
 *     seq: number,                 // monotonic mutation counter (drives delta sync)
 *     cards:   Card[],
 *     tags:    Tag[],
 *     columns: Column[],
 *     settings: object,
 *   }
 *
 * Card:
 *   {
 *     id, column_id, order,        // identity + position
 *     version,                     // optimistic-concurrency counter, starts at 1
 *     deleted_at,                  // null, or ISO string => tombstone
 *     created_at, updated_at,      // ISO strings
 *     created_by, updated_by,      // actor stamps
 *     seq,                         // mutation counter at last change (delta cursor)
 *     ...domain + preserved unknown fields
 *   }
 *
 * Design choices worth calling out:
 *   - Every mutation is version-checked. A stale `expected_version` throws a
 *     `conflict` carrying the current card in `error.meta.current`. `force`
 *     skips the check — except a tombstone is immutable, so `force` on a
 *     deleted card still throws `conflict`.
 *   - Order keys are base-62 fractional strings compared lexicographically.
 *     `orderBetween` mints a key between two neighbors; the migration instead
 *     uses a dedicated even-distribution pass (no chained orderBetween).
 *   - Reads/writes are injected (storage, clock, uuid, actor) so the whole
 *     thing is deterministically testable without a browser.
 */

/* ======================================================================== */
/* Constants                                                                */
/* ======================================================================== */

export const STORAGE_KEY = 'kanbantt_data_v1';
export const MIGRATED_MARKER = 'kanbantt_migrated_at';
export const SCHEMA_VERSION = 1;

// Legacy localStorage keys from the pre-Drive prototype (see src/App.jsx).
export const LEGACY_KEYS = {
  tasks: 'kanbantt:tasks:v5',
  columns: 'kanbantt:columns:v1',
  tags: 'kanbantt:tags:v2',
};

// Delta-sync tokens go stale after this; an older token must do a full re-sync.
export const SYNC_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The app's built-in defaults, mirrored here so migration can fall back to them
// without importing the React bundle.
export const DEFAULT_COLUMNS = [
  { id: 'backlog', label: 'Backlog', accentKey: 'textDim' },
  { id: 'todo', label: 'To Do', accentKey: 'ice' },
  { id: 'doing', label: 'In Progress', accentKey: 'amber' },
  { id: 'done', label: 'Done', accentKey: 'mint' },
];

export const DEFAULT_TAGS = [
  { id: 'tag-frontend', name: 'frontend', color: 'cyan' },
  { id: 'tag-backend', name: 'backend', color: 'blue' },
  { id: 'tag-privacy', name: 'privacy', color: 'red' },
  { id: 'tag-mobile', name: 'mobile', color: 'orange' },
  { id: 'tag-v1', name: 'v1', color: 'amber' },
  { id: 'tag-polish', name: 'polish', color: 'slate' },
  { id: 'tag-bug', name: 'bug', color: 'pink' },
];

// Fields the store owns and stamps itself. Client input for these is ignored on
// create; they are also stripped from update/move patches.
const CONTROLLED_FIELDS = [
  'id', 'version', 'deleted_at', 'created_at', 'updated_at',
  'created_by', 'updated_by', 'seq',
];

/* ======================================================================== */
/* Errors                                                                   */
/* ======================================================================== */

/**
 * Every failure the store surfaces is a StoreError with a stable `code`, never a
 * raw TypeError. Conflicts carry the current card under `meta.current`.
 */
export class StoreError extends Error {
  constructor(code, message, meta = {}) {
    super(message || code);
    this.name = 'StoreError';
    this.code = code;
    this.meta = meta;
  }
}

const conflict = (current) =>
  new StoreError('conflict', 'version conflict', { current: clone(current) });

/* ======================================================================== */
/* Small helpers                                                            */
/* ======================================================================== */

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function stripControlled(patch) {
  const out = { ...patch };
  for (const f of CONTROLLED_FIELDS) delete out[f];
  return out;
}

/* ======================================================================== */
/* Order keys — base-62 fractional strings                                  */
/* ======================================================================== */

// Ascending ASCII order, so lexicographic string comparison matches digit order.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length; // 62
const MID_DIGIT = ALPHABET[Math.floor(BASE / 2)]; // 'V'

const digitVal = (ch) => ALPHABET.indexOf(ch);
const digitChar = (n) => ALPHABET[n];

function stripTrailingZeros(s) {
  let end = s.length;
  while (end > 0 && s[end - 1] === ALPHABET[0]) end--;
  return s.slice(0, end);
}

/**
 * Average of two fractional keys `a` < `b` (each a string of base-62 digits
 * interpreted as 0.d1d2…; '' == 0). Returns the exact midpoint, canonicalized
 * (no trailing zeros), which is strictly between a and b.
 */
function avg(a, b) {
  const len = Math.max(a.length, b.length);

  // Sum a + b digit-wise, least-significant first, carrying left.
  const digits = new Array(len).fill(0);
  let carry = 0;
  for (let i = len - 1; i >= 0; i--) {
    const da = i < a.length ? digitVal(a[i]) : 0;
    const db = i < b.length ? digitVal(b[i]) : 0;
    const s = da + db + carry;
    carry = Math.floor(s / BASE);
    digits[i] = s % BASE;
  }
  // carry is the integer part of (a + b), in {0, 1} since a, b < 1.

  // Long-divide (carry.digits) by 2, most-significant first.
  const out = [];
  let rem = carry;
  for (let i = 0; i < len; i++) {
    const cur = rem * BASE + digits[i];
    out.push(Math.floor(cur / 2));
    rem = cur % 2;
  }
  if (rem !== 0) out.push(Math.floor((rem * BASE) / 2)); // one extra digit, B/2

  return stripTrailingZeros(out.map(digitChar).join(''));
}

/** Shortest key strictly greater than `a` (used for "append to end"). */
function increment(a) {
  for (let i = a.length - 1; i >= 0; i--) {
    if (digitVal(a[i]) < BASE - 1) {
      return a.slice(0, i) + digitChar(digitVal(a[i]) + 1);
    }
  }
  return a + MID_DIGIT; // all digits maxed (or empty) => extend
}

/**
 * Mint an order key strictly between neighbors `a` and `b` (lexicographically).
 * Pass null for an open side:
 *   orderBetween(null, null) -> first key in an empty column
 *   orderBetween(null, b)    -> before the first card
 *   orderBetween(a, null)    -> after the last card
 *   orderBetween(a, b)       -> between two cards (requires a < b)
 */
export function orderBetween(a = null, b = null) {
  if (a != null && b != null) {
    if (a >= b) {
      throw new StoreError('invalid_order', `orderBetween needs a < b (got ${a}, ${b})`);
    }
    return avg(a, b);
  }
  if (a == null && b != null) return avg('', b);
  if (a != null && b == null) return increment(a);
  return MID_DIGIT;
}

/**
 * Even-distribution order keys for `n` items, minted in one pass (NOT chained
 * orderBetween). Divides the key space into n+1 slots and places each item at a
 * slot boundary, yielding short uniform-length, strictly-increasing keys.
 */
export function mintOrders(n) {
  if (n <= 0) return [];
  // Width such that BASE^width > n+1 guarantees distinct, ordered slots.
  const width = Math.max(1, Math.ceil(Math.log(n + 1) / Math.log(BASE)));
  const span = BASE ** width;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const v = Math.round((i * span) / (n + 1)); // in (0, span)
    out.push(encodeFixed(v, width));
  }
  return out;
}

/** Encode integer `v` (0 <= v < BASE^width) as exactly `width` base-62 digits. */
function encodeFixed(v, width) {
  let s = '';
  let x = v;
  for (let i = 0; i < width; i++) {
    s = digitChar(x % BASE) + s;
    x = Math.floor(x / BASE);
  }
  return s;
}

/**
 * `n` strictly-increasing keys all greater than `after` (null => start fresh),
 * minted in a single pass. Each step advances the lower bound to the key just
 * minted, so the results are distinct and correctly sorted — never N keys minted
 * between the same two boundaries (which would collide). Used to append a run of
 * orphaned cards below a destination column's existing cards.
 */
export function appendOrders(after, n) {
  const out = [];
  let prev = after;
  for (let i = 0; i < n; i++) {
    prev = orderBetween(prev, null); // shortest key > prev; bound moves each step
    out.push(prev);
  }
  return out;
}

/** Total order over cards: by `order`, then `id` as the collision tiebreak. */
export function compareCards(x, y) {
  if (x.order !== y.order) return x.order < y.order ? -1 : 1;
  if (x.id !== y.id) return x.id < y.id ? -1 : 1;
  return 0;
}

/* ======================================================================== */
/* Sync tokens                                                              */
/* ======================================================================== */

// base64url that works in both the browser (btoa/atob) and Node (Buffer). Token
// payloads are ASCII JSON, so the simple byte path is sufficient.
function b64urlEncode(s) {
  const b64 =
    typeof Buffer !== 'undefined'
      ? Buffer.from(s, 'utf8').toString('base64')
      : btoa(s);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  // Throws on malformed input (atob throws; Buffer is lenient but yields garbage
  // that fails the later JSON parse). Either way callers map it to a domain error.
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  return typeof Buffer !== 'undefined'
    ? Buffer.from(padded, 'base64').toString('utf8')
    : atob(padded);
}

/** Issue an opaque delta-sync cursor pinned to `seq` and stamped at `iat`. */
function issueToken(seq, iat) {
  return b64urlEncode(JSON.stringify({ v: 1, seq, iat }));
}

/**
 * Decode a sync token to { seq, iat }. Throws StoreError('invalid_sync_token')
 * for anything that isn't one of our tokens — including the strings "null", a
 * random blob, or a bare timestamp — never a TypeError. Expiry is checked by the
 * caller (which knows "now").
 */
function decodeToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new StoreError('invalid_sync_token', 'sync token is not a string');
  }
  let json;
  try {
    json = b64urlDecode(token);
  } catch {
    throw new StoreError('invalid_sync_token', 'sync token is not valid base64url');
  }
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new StoreError('invalid_sync_token', 'sync token payload is not JSON');
  }
  if (
    obj === null ||
    typeof obj !== 'object' ||
    obj.v !== 1 ||
    typeof obj.seq !== 'number' ||
    !Number.isFinite(obj.seq) ||
    typeof obj.iat !== 'number' ||
    !Number.isFinite(obj.iat)
  ) {
    throw new StoreError('invalid_sync_token', 'sync token shape is not recognized');
  }
  return { seq: obj.seq, iat: obj.iat };
}

/* ======================================================================== */
/* Blob helpers                                                             */
/* ======================================================================== */

export function emptyBlob() {
  return {
    schema_version: SCHEMA_VERSION,
    seq: 0,
    cards: [],
    tags: [],
    columns: clone(DEFAULT_COLUMNS),
    settings: {},
  };
}

/**
 * The single source of truth for "is this blob safe to load into the store?".
 * Pure: it inspects only its argument — no module state, no localStorage, no
 * mutation. Both load() (reading the persisted blob) and hydrate() (applying an
 * externally-sourced blob) call this exact helper, so there is ZERO validation
 * drift between them. Throws a StoreError on the first problem; returns nothing.
 *
 * Checks (parity with what load historically refused, PLUS hardening): schema
 * version, structural shape, required card fields, duplicate ids, no dangling
 * tag refs, and single-blob column self-consistency. The dangling-ref and
 * column-consistency checks are the A.5-proper integrity invariants — hydrate is
 * the one sanctioned whole-blob replace, so it must not become a way to smuggle
 * a corrupt blob (dangling tag ref / orphaned column_id) past those invariants.
 */
export function validateBlob(blob) {
  if (blob == null || typeof blob !== 'object' || Array.isArray(blob)) {
    throw new StoreError('invalid_blob', 'blob must be an object');
  }
  // Schema: refuse any mismatch, exactly as load() does today (parity, not just
  // "newer than supported"). A future/foreign schema is never partially adopted.
  if (blob.schema_version !== SCHEMA_VERSION) {
    throw new StoreError(
      'schema_unsupported',
      `unsupported schema_version ${blob.schema_version}; expected ${SCHEMA_VERSION}`,
      { found: blob.schema_version, expected: SCHEMA_VERSION },
    );
  }
  // Structural shape.
  if (!Array.isArray(blob.cards)) throw new StoreError('invalid_blob', 'cards must be an array');
  if (!Array.isArray(blob.tags)) throw new StoreError('invalid_blob', 'tags must be an array');
  if (!Array.isArray(blob.columns)) throw new StoreError('invalid_blob', 'columns must be an array');
  if (blob.settings == null || typeof blob.settings !== 'object' || Array.isArray(blob.settings)) {
    throw new StoreError('invalid_blob', 'settings must be an object');
  }
  if (typeof blob.seq !== 'number' || !Number.isFinite(blob.seq)) {
    throw new StoreError('invalid_blob', 'seq must be a finite number');
  }

  // Tag id set (+ no duplicate tag ids).
  const tagIds = new Set();
  for (const t of blob.tags) {
    if (t == null || typeof t !== 'object' || typeof t.id !== 'string') {
      throw new StoreError('invalid_blob', 'every tag needs a string id');
    }
    if (tagIds.has(t.id)) throw new StoreError('invalid_blob', `duplicate tag id ${t.id}`, { id: t.id });
    tagIds.add(t.id);
  }

  // Column id set (+ no duplicate column ids).
  const columnIds = new Set();
  for (const c of blob.columns) {
    if (c == null || typeof c !== 'object' || typeof c.id !== 'string') {
      throw new StoreError('invalid_blob', 'every column needs a string id');
    }
    if (columnIds.has(c.id)) throw new StoreError('invalid_blob', `duplicate column id ${c.id}`, { id: c.id });
    columnIds.add(c.id);
  }

  // Cards: required fields, no duplicate ids, no dangling tag refs, and column
  // self-consistency (a card's column_id must exist in THIS blob's own columns —
  // distinct from the spec's fallback-tray case for columns the CLIENT lacks).
  const cardIds = new Set();
  for (const card of blob.cards) {
    if (card == null || typeof card !== 'object') {
      throw new StoreError('invalid_blob', 'every card must be an object');
    }
    for (const f of ['id', 'column_id', 'order', 'version']) {
      if (card[f] == null) throw new StoreError('invalid_blob', `card missing ${f}`, { id: card.id });
    }
    if (cardIds.has(card.id)) throw new StoreError('invalid_blob', `duplicate card id ${card.id}`, { id: card.id });
    cardIds.add(card.id);
    if (!columnIds.has(card.column_id)) {
      throw new StoreError('invalid_blob', `card ${card.id} references unknown column ${card.column_id}`, {
        id: card.id, column_id: card.column_id,
      });
    }
    if (card.tags != null) {
      if (!Array.isArray(card.tags)) {
        throw new StoreError('invalid_blob', `card ${card.id} tags must be an array`, { id: card.id });
      }
      for (const ref of card.tags) {
        if (!tagIds.has(ref)) {
          throw new StoreError('invalid_blob', `card ${card.id} references unknown tag ${ref}`, {
            id: card.id, tag: ref,
          });
        }
      }
    }
  }
}

/* ======================================================================== */
/* Store                                                                    */
/* ======================================================================== */

/**
 * Create a store bound to the given dependencies.
 *
 * @param {object}   deps
 * @param {Storage}  deps.storage  localStorage-like: getItem/setItem/removeItem
 * @param {string}   [deps.actor]  actor id stamped on writes
 * @param {() => number} [deps.now]   clock in epoch ms
 * @param {() => string} [deps.uuid]  id minter
 */
export function createStore({
  storage,
  actor = 'local',
  now = () => Date.now(),
  uuid = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (!storage) throw new StoreError('config', 'createStore requires a storage');

  let blob = null;      // in-memory state; stays null until a successful load
  let loaded = false;

  // Reactivity bridge (for useSyncExternalStore). `snapshotRef` is referentially
  // stable between mutations; a fresh reference is minted only when a successful
  // mutation notifies. Listeners fire after every successful write.
  let snapshotRef = null;
  const listeners = new Set();

  const iso = () => new Date(now()).toISOString();

  /* ---- load / persist -------------------------------------------------- */

  function load() {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw == null) {
      blob = emptyBlob();
      loaded = true;
      snapshotRef = buildSnapshot();
      return blob;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt blob is refused rather than silently reset — surfaced, no data.
      blob = null;
      loaded = false;
      throw new StoreError('corrupt_blob', `${STORAGE_KEY} is not valid JSON`);
    }
    // Single shared validator (schema + structure + integrity invariants). On any
    // refusal, nothing is loaded into memory — a newer/foreign/corrupt blob can't
    // be partially adopted or clobber a newer client's data. Same helper hydrate
    // uses, so load and hydrate never drift.
    try {
      validateBlob(parsed);
    } catch (e) {
      blob = null;
      loaded = false;
      throw e;
    }
    blob = parsed;
    loaded = true;
    snapshotRef = buildSnapshot();
    return blob;
  }

  function ensureLoaded() {
    if (!loaded) load();
    return blob;
  }

  function persist() {
    storage.setItem(STORAGE_KEY, JSON.stringify(blob));
  }

  // A shallow-cloned, immutable view of the board. Entities get fresh refs so
  // older snapshots never observe later in-place field mutations.
  function buildSnapshot() {
    return {
      schema_version: blob.schema_version,
      seq: blob.seq,
      cards: blob.cards.map((c) => ({ ...c })),
      tags: blob.tags.map((t) => ({ ...t })),
      columns: blob.columns.map((c) => ({ ...c })),
      settings: blob.settings,
    };
  }

  function notify() {
    for (const listener of listeners) listener();
  }

  // Persist, mint a fresh snapshot reference, then notify. Every successful
  // mutation goes through here so subscribers and useSyncExternalStore stay live.
  function commit() {
    persist();
    snapshotRef = buildSnapshot();
    notify();
  }

  /**
   * Atomically adopt a fully-built draft blob (used by the bulk board-config ops
   * — columnDelete / tagDelete). The single localStorage write happens FIRST; only
   * once it succeeds do we swap `blob`, mint exactly one fresh snapshot reference,
   * and fire exactly one notify. A throw from the write leaves blob, snapshotRef,
   * and listeners untouched — the draft is discarded and nothing is persisted.
   * Mirrors the build-in-memory-then-write-once pattern the migration uses.
   */
  function persistDraft(draft, affectedCardIds = []) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(draft));
    } catch (e) {
      throw new StoreError('persist_failed', `could not persist board mutation: ${e?.name || e}`, {
        affectedCardIds, cause: e,
      });
    }
    blob = draft;
    snapshotRef = buildSnapshot();
    notify();
  }

  /**
   * Replace the ENTIRE local blob with an externally-sourced one (the Drive blob,
   * already merged + canonical from sync-merge.js). This is the SOLE sanctioned
   * whole-blob-replace path — the deliberate, narrow exception to A.5-proper's
   * removal of whole-array setters. It is apply-or-refuse, never transform.
   *
   * 1. Validate the INCOMING ARGUMENT in total isolation (validateBlob) BEFORE
   *    touching any live state. On failure it throws and live state, the in-memory
   *    cache, and localStorage are left byte-identical — no persist, no snapshot
   *    swap, no notify. A malformed external blob can never partially apply.
   * 2. Apply verbatim with exactly two exceptions:
   *      - seq      -> max(localSeq, incoming.seq): never regress the local
   *                    version-token counter (a lower seq would reissue consumed
   *                    sequence numbers and mint duplicate version tokens).
   *      - settings -> local settings preserved verbatim. The codebase has NO
   *                    explicit device-local-vs-board-wide settings key split
   *                    (settings is a reserved, always-empty object; the one
   *                    device-local pref, theme, lives outside the blob), so per
   *                    the batch's stop-and-report rule we do NOT guess a merge;
   *                    we keep local settings, which cannot corrupt device prefs.
   *    Everything else (cards, tags, columns) applies verbatim — no version
   *    minting, no content transform.
   * 3. Apply as a single atomic swap: persist once (write first, so a failed
   *    write leaves everything untouched), then swap the live blob, mint one fresh
   *    snapshot reference, and notify exactly once.
   */
  function hydrate(incoming) {
    ensureLoaded(); // need the local blob for the seq/settings exceptions
    validateBlob(incoming); // throws on any invalid blob; nothing mutated yet

    const next = {
      ...incoming,
      seq: Math.max(blob.seq, incoming.seq), // never regress the local counter
      settings: blob.settings, // preserve device-local settings (see doc above)
    };

    // Atomic swap: write first; a throw here leaves blob/snapshot/listeners and
    // localStorage byte-identical. Only on a successful write do we adopt it.
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      throw new StoreError('persist_failed', `could not persist hydrated blob: ${e?.name || e}`, { cause: e });
    }
    blob = next;
    loaded = true;
    snapshotRef = buildSnapshot();
    notify();
    return clone(blob);
  }

  /* ---- internal lookups ------------------------------------------------ */

  const findCard = (id) => ensureLoaded().cards.find((c) => c.id === id) || null;

  // Last live order key in `columnId`, computed over an explicit card array so a
  // not-yet-adopted bulk-op draft can be measured the same way live state is.
  function lastLiveOrder(cards, columnId) {
    const inCol = cards
      .filter((c) => c.column_id === columnId && !c.deleted_at)
      .sort(compareCards);
    return inCol.length ? inCol[inCol.length - 1].order : null;
  }
  const lastOrderInColumn = (columnId) => lastLiveOrder(blob.cards, columnId);

  // A tombstone is immutable; even force cannot resurrect it.
  function assertMutable(card, opts) {
    if (card.deleted_at) throw conflict(card);
    if (!opts.force && opts.expected_version !== card.version) throw conflict(card);
  }

  /* ---- public API ------------------------------------------------------ */

  function create(input = {}) {
    ensureLoaded();

    // Idempotent replay: creating an id that already exists returns it untouched.
    if (input.id != null) {
      const existing = findCard(input.id);
      if (existing) return clone(existing);
    }

    const id = input.id != null ? input.id : uuid();
    const columnId = input.column_id != null ? input.column_id : blob.columns[0]?.id;
    const order =
      input.order != null ? input.order : orderBetween(lastOrderInColumn(columnId), null);

    const seq = ++blob.seq;
    const ts = iso();

    // Preserve every client field except the ones the store owns/derives, then
    // stamp the controlled fields fresh (ignoring any client-supplied values).
    const domain = stripControlled(input);
    delete domain.column_id;
    delete domain.order;

    const card = {
      ...domain,
      id,
      column_id: columnId,
      order,
      version: 1,
      deleted_at: null,
      created_at: ts,
      updated_at: ts,
      created_by: actor,
      updated_by: actor,
      seq,
    };

    blob.cards.push(card);
    commit();
    return clone(card);
  }

  function update(id, patch = {}, opts = {}) {
    ensureLoaded();
    const card = findCard(id);
    if (!card) throw new StoreError('not_found', `no card ${id}`, { id });
    assertMutable(card, opts);

    // update is for content; repositioning goes through move(), so column_id /
    // order in a patch are ignored.
    const fields = stripControlled(patch);
    delete fields.column_id;
    delete fields.order;
    Object.assign(card, fields);
    card.version += 1;
    card.updated_at = iso();
    card.updated_by = actor;
    card.seq = ++blob.seq;
    commit();
    return clone(card);
  }

  function move(id, target = {}, opts = {}) {
    ensureLoaded();
    const card = findCard(id);
    if (!card) throw new StoreError('not_found', `no card ${id}`, { id });
    assertMutable(card, opts);

    if (target.column_id != null) card.column_id = target.column_id;
    card.order =
      target.order != null
        ? target.order
        : orderBetween(lastOrderInColumn(card.column_id), null);
    card.version += 1;
    card.updated_at = iso();
    card.updated_by = actor;
    card.seq = ++blob.seq;
    commit();
    return clone(card);
  }

  function remove(id, opts = {}) {
    ensureLoaded();
    const card = findCard(id);
    if (!card) throw new StoreError('not_found', `no card ${id}`, { id });
    // Re-deleting a tombstone is a conflict, even with force (assertMutable
    // throws on deleted_at before it ever looks at force/version).
    assertMutable(card, opts);

    card.deleted_at = iso();
    card.version += 1;
    card.updated_at = card.deleted_at;
    card.updated_by = actor;
    card.seq = ++blob.seq;
    commit();
    return clone(card);
  }

  /**
   * List cards.
   *   list()                       -> live cards, sorted, + fresh sync_token
   *   list({ includeDeleted:true })-> live + tombstones
   *   list({ since: token })       -> delta: everything changed since the token,
   *                                   tombstones included; throws on bad/expired
   *                                   tokens.
   */
  function list(opts = {}) {
    ensureLoaded();
    const { includeDeleted = false, since = null } = opts;

    if (since != null) {
      const { seq, iat } = decodeToken(since); // throws invalid_sync_token
      if (now() - iat > SYNC_TOKEN_TTL_MS) {
        throw new StoreError('sync_token_expired', 'sync token has expired', {
          issued_at: iat,
        });
      }
      const changed = blob.cards
        .filter((c) => c.seq > seq) // delta always includes tombstones
        .sort(compareCards)
        .map(clone);
      return { cards: changed, sync_token: issueToken(blob.seq, now()) };
    }

    const cards = blob.cards
      .filter((c) => includeDeleted || !c.deleted_at)
      .sort(compareCards)
      .map(clone);
    return { cards, sync_token: issueToken(blob.seq, now()) };
  }

  function get(id) {
    const c = findCard(id);
    return c ? clone(c) : null;
  }

  /* ---- board config (columns + tags) ----------------------------------- */
  // Board config is not card data: a column/tag carries no version token and no
  // delta cursor (the spec models these as optional, locally-owned capabilities).
  // The store owns the canonical arrays AND the integrity invariants a conforming
  // MCP server would enforce — orphan-move on column delete, tag ref-strip on tag
  // delete — so there is no whole-array setter that could introduce a dangling
  // tag ref or an orphaned column_id. The simple ops (create/update/reorder) touch
  // a single config entity and mutate-then-commit; the two bulk ops (delete) build
  // a complete draft and adopt it in one atomic write (see persistDraft).
  //
  // These are SYSTEM mutations: they mint each affected card's next version token
  // internally and do NOT take or check an expected_version — the operation is
  // itself the authority, so they never route through the card concurrency path
  // (which would deadlock on a tombstone or a caller-less version).

  function columnCreate(col) {
    ensureLoaded();
    if (!col || typeof col !== 'object' || typeof col.id !== 'string' || col.id === '') {
      throw new StoreError('validation_failed', 'column requires a non-empty string id');
    }
    if (blob.columns.some((c) => c.id === col.id)) {
      throw new StoreError('validation_failed', `column ${col.id} already exists`, { id: col.id });
    }
    blob.columns.push({ ...col });
    commit();
    return clone(blob.columns);
  }

  // Board-config patch (rename and/or recolor). `id` is immutable.
  function columnUpdate(id, patch = {}) {
    ensureLoaded();
    const col = blob.columns.find((c) => c.id === id);
    if (!col) throw new StoreError('column_unknown', `no column ${id}`, { id });
    const fields = { ...patch };
    delete fields.id;
    Object.assign(col, fields);
    commit();
    return clone(blob.columns);
  }

  // Columns are positioned by array order (the board has no per-column LexoRank
  // field in v1); `toIndex` is the destination index, clamped into range.
  function columnReorder(id, toIndex) {
    ensureLoaded();
    const from = blob.columns.findIndex((c) => c.id === id);
    if (from < 0) throw new StoreError('column_unknown', `no column ${id}`, { id });
    const dest = Math.max(0, Math.min(toIndex, blob.columns.length - 1));
    const [col] = blob.columns.splice(from, 1);
    blob.columns.splice(dest, 0, col);
    commit();
    return clone(blob.columns);
  }

  /**
   * Delete a column, moving every LIVE card in it to `orphanDestinationColumnId`
   * (a new version minted per moved card). Cascade-deleting cards is forbidden.
   * Tombstones are skipped: a soft-deleted card has no live column placement to
   * rescue, so it keeps its (now-defunct) column_id and is never resurrected.
   * The destination must exist and differ from the deleted id; the last remaining
   * column cannot be deleted. Atomic: one write, one notify, or nothing at all.
   */
  function columnDelete(id, orphanDestinationColumnId) {
    ensureLoaded();
    if (!blob.columns.some((c) => c.id === id)) {
      throw new StoreError('column_unknown', `no column ${id}`, { id });
    }
    if (blob.columns.length <= 1) {
      throw new StoreError('column_last_forbidden', 'cannot delete the last remaining column', { id });
    }
    const dest = orphanDestinationColumnId;
    // Destination must exist, not be the column being deleted, and (trivially in a
    // single-column delete) not itself be slated for deletion.
    if (dest == null || dest === id || !blob.columns.some((c) => c.id === dest)) {
      throw new StoreError('column_unknown', `invalid orphan destination: ${dest}`, {
        id, destination: dest,
      });
    }

    const draft = clone(blob);
    const ts = iso();
    const orphans = draft.cards
      .filter((c) => c.column_id === id && !c.deleted_at) // live only
      .sort(compareCards);                                // preserve relative order
    const orders = appendOrders(lastLiveOrder(draft.cards, dest), orphans.length);
    const affectedCardIds = orphans.map((c) => c.id);
    orphans.forEach((card, i) => {
      card.column_id = dest;
      card.order = orders[i];
      card.version += 1;
      card.updated_at = ts;
      card.updated_by = actor;
      card.seq = ++draft.seq;
    });
    draft.columns = draft.columns.filter((c) => c.id !== id);

    persistDraft(draft, affectedCardIds);
    return clone(blob.columns);
  }

  function tagCreate(tag) {
    ensureLoaded();
    if (!tag || typeof tag !== 'object' || typeof tag.id !== 'string' || tag.id === '') {
      throw new StoreError('validation_failed', 'tag requires a non-empty string id');
    }
    if (blob.tags.some((t) => t.id === tag.id)) {
      throw new StoreError('validation_failed', `tag ${tag.id} already exists`, { id: tag.id });
    }
    blob.tags.push({ ...tag });
    commit();
    return clone(blob.tags);
  }

  // Tag patch (covers both recolor and rename). `id` is immutable.
  function tagUpdate(id, patch = {}) {
    ensureLoaded();
    const tag = blob.tags.find((t) => t.id === id);
    if (!tag) throw new StoreError('not_found', `no tag ${id}`, { id });
    const fields = { ...patch };
    delete fields.id;
    Object.assign(tag, fields);
    commit();
    return clone(blob.tags);
  }

  /**
   * Delete a tag, stripping its id from EVERY card that references it — including
   * tombstones (the ref is removed and a new version minted, but deleted_at is
   * left intact so the card stays a tombstone; it is never resurrected). A
   * dangling tag reference is never left behind. Atomic: one write, one notify.
   */
  function tagDelete(id) {
    ensureLoaded();
    if (!blob.tags.some((t) => t.id === id)) {
      throw new StoreError('not_found', `no tag ${id}`, { id });
    }
    const draft = clone(blob);
    const ts = iso();
    const affectedCardIds = [];
    for (const card of draft.cards) {
      if (!(card.tags || []).includes(id)) continue;
      card.tags = card.tags.filter((t) => t !== id);
      card.version += 1;
      card.updated_at = ts;
      card.updated_by = actor;
      card.seq = ++draft.seq;
      // deleted_at deliberately untouched: tombstones stay tombstoned.
      affectedCardIds.push(card.id);
    }
    draft.tags = draft.tags.filter((t) => t.id !== id);

    persistDraft(draft, affectedCardIds);
    return clone(blob.tags);
  }

  /* ---- reactivity bridge ----------------------------------------------- */

  /** Subscribe to mutations; returns an unsubscribe function. */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Referentially stable board snapshot (new ref only after a notify). */
  function getSnapshot() {
    ensureLoaded();
    return snapshotRef;
  }

  /** Direct (test/debug) view of the in-memory blob; null until loaded. */
  function snapshot() {
    return blob ? clone(blob) : null;
  }
  const isLoaded = () => loaded;

  return {
    load, hydrate, list, get, create, update, move, delete: remove,
    columnCreate, columnUpdate, columnReorder, columnDelete,
    tagCreate, tagUpdate, tagDelete,
    subscribe, getSnapshot,
    orderBetween, snapshot, isLoaded,
  };
}

/* ======================================================================== */
/* One-time legacy migration                                                */
/* ======================================================================== */

/**
 * Read a legacy key and parse it.
 * @returns {{ present: boolean, value: any }}
 * @throws  StoreError('migration_failed') if present but unparseable.
 */
function readLegacy(storage, key, label) {
  const raw = storage.getItem(key);
  if (raw == null) return { present: false, value: undefined };
  try {
    return { present: true, value: JSON.parse(raw) };
  } catch {
    throw new StoreError('migration_failed', `legacy ${label} (${key}) is corrupt`, { key });
  }
}

/**
 * One-time migration from the legacy localStorage keys into the v1 blob.
 *
 * Runs iff `kanbantt_data_v1` is absent AND `kanbantt:tasks:v5` is present and
 * parses. Builds the entire blob in memory, validates it, and writes it once —
 * then writes the `kanbantt_migrated_at` marker. On ANY failure (corrupt legacy
 * key, validation, QuotaExceededError) it writes nothing, leaves the legacy keys
 * untouched, and throws. On success the legacy keys are left in place as the
 * natural backup; their removal is future manual housekeeping.
 *
 * @returns {{ status: 'skipped'|'migrated', reason?: string, cards?: number,
 *             tags?: number, synthetic_tags?: string[] }}
 */
export function runLegacyMigration({
  storage,
  actor = 'migration',
  now = () => Date.now(),
  uuid = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (!storage) throw new StoreError('config', 'runLegacyMigration requires a storage');

  // Gate 1: never overwrite an existing blob.
  if (storage.getItem(STORAGE_KEY) != null) {
    return { status: 'skipped', reason: 'already_migrated' };
  }

  // Gate 2: legacy tasks must exist. Absent => fresh user, nothing to do.
  const tasksRaw = storage.getItem(LEGACY_KEYS.tasks);
  if (tasksRaw == null) {
    return { status: 'skipped', reason: 'no_legacy_data' };
  }
  // Gate 3: corrupt tasks halts the whole migration, nothing written.
  let legacyTasks;
  try {
    legacyTasks = JSON.parse(tasksRaw);
  } catch {
    throw new StoreError('migration_failed', `legacy tasks (${LEGACY_KEYS.tasks}) is corrupt`, {
      key: LEGACY_KEYS.tasks,
    });
  }
  if (!Array.isArray(legacyTasks)) {
    throw new StoreError('migration_failed', 'legacy tasks is not an array');
  }

  // Columns / tags: absent => app defaults; present-but-corrupt => halt.
  const colsRead = readLegacy(storage, LEGACY_KEYS.columns, 'columns');
  const tagsRead = readLegacy(storage, LEGACY_KEYS.tags, 'tags');
  const columns =
    colsRead.present && Array.isArray(colsRead.value) && colsRead.value.length
      ? colsRead.value
      : clone(DEFAULT_COLUMNS);
  const baseTags =
    tagsRead.present && Array.isArray(tagsRead.value) ? tagsRead.value : clone(DEFAULT_TAGS);

  const ts = new Date(now()).toISOString();

  // ---- Tag resolution: never drop a reference; mint a synthetic for orphans.
  const tagById = new Map(baseTags.map((t) => [t.id, t]));
  const synthetic = new Map(); // ref -> synthetic tag
  const resolveTagRef = (ref) => {
    if (tagById.has(ref)) return ref;
    const synthId = `orphaned-${ref}`;
    if (!synthetic.has(ref)) {
      synthetic.set(ref, {
        id: synthId,
        name: `Unknown tag (${ref})`,
        color: 'gray',
      });
    }
    return synthId;
  };

  // ---- Group tasks by destination column, preserving legacy array order, so
  //      order keys can be minted in one even-distribution pass per column.
  const byColumn = new Map();
  const decorated = legacyTasks.map((task, idx) => {
    const columnId = task.status != null ? task.status : columns[0]?.id;
    if (!byColumn.has(columnId)) byColumn.set(columnId, []);
    const positionInColumn = byColumn.get(columnId).length;
    byColumn.get(columnId).push(idx);
    return { task, idx, columnId, positionInColumn };
  });

  // Mint orders per column, then index them back by original task position.
  const orderByIdx = new Map();
  for (const [columnId, idxs] of byColumn) {
    const orders = mintOrders(idxs.length);
    idxs.forEach((taskIdx, pos) => orderByIdx.set(taskIdx, orders[pos]));
  }

  const cards = decorated.map(({ task, idx, columnId }) => {
    // Preserve all legacy fields (including unknown ones); transform the rest.
    const { status, tags, id, version, deleted_at, created_at, updated_at,
            created_by, updated_by, seq, ...rest } = task;

    const tagRefs = Array.isArray(tags) ? tags.map(resolveTagRef) : [];

    return {
      ...rest,
      id: id != null ? id : uuid(),
      column_id: columnId,
      order: orderByIdx.get(idx),
      version: 1,
      deleted_at: null,
      // Timestamps from existing data where present, else now.
      created_at: created_at != null ? created_at : ts,
      updated_at: updated_at != null ? updated_at : ts,
      created_by: actor,
      updated_by: actor,
      seq: idx + 1,
      tags: tagRefs,
    };
  });

  const allTags = [...baseTags, ...synthetic.values()];

  const newBlob = {
    schema_version: SCHEMA_VERSION,
    seq: cards.length,
    cards,
    tags: allTags,
    columns,
    settings: {},
  };

  // ---- Validate the whole blob before writing anything.
  const tagIds = new Set(allTags.map((t) => t.id));
  for (const c of cards) {
    if (c.id == null || c.column_id == null || c.order == null || c.version == null) {
      throw new StoreError('migration_failed', `card missing required field`, { card: c });
    }
    for (const ref of c.tags) {
      if (!tagIds.has(ref)) {
        throw new StoreError('migration_failed', `unresolved tag ref ${ref}`, { ref });
      }
    }
  }

  // ---- Atomic write: blob first, then marker. Roll the blob back if the marker
  //      write fails, so a quota error never leaves a half-migrated state.
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(newBlob));
  } catch (e) {
    throw new StoreError('migration_failed', `could not write blob: ${e?.name || e}`, {
      cause: e,
    });
  }
  try {
    storage.setItem(MIGRATED_MARKER, ts);
  } catch (e) {
    try { storage.removeItem(STORAGE_KEY); } catch { /* best-effort rollback */ }
    throw new StoreError('migration_failed', `could not write marker: ${e?.name || e}`, {
      cause: e,
    });
  }

  return {
    status: 'migrated',
    cards: cards.length,
    tags: allTags.length,
    synthetic_tags: [...synthetic.values()].map((t) => t.id),
  };
}
