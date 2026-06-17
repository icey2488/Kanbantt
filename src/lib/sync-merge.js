/**
 * Kanbantt — pure convergent merge core for Drive sync (Feature 1).
 *
 * This module is the deterministic, CRDT-like foundation a later transport batch
 * (Drive upload/.tmp/read-back/.bak/401/keepalive) will sit ON TOP of. It is
 * intentionally:
 *   - PURE: every export is a pure function. No I/O, no Drive, no network, no
 *     auth, no localStorage, no clocks, no device ids, no randomness.
 *   - SELF-CONTAINED: zero imports. SHA-256 is embedded so the exact same hash is
 *     produced in every environment (browser + Node test) with no dependency.
 *
 * Blob shape (reused verbatim from card-store.js — the persisted v1 blob, NOT the
 * spec's nested `board:` illustration):
 *   { schema_version, seq, cards:[Card], tags:[Tag], columns:[Column], settings }
 * Cards carry: client-minted `id`, opaque equality-only `version`, `deleted_at`
 * (tombstone when non-null), LexoRank `order`, `column_id`, `tags:[tagId]`, plus
 * content. `version` is compared for EQUALITY only — never ordered or parsed.
 *
 * Convergence is the non-negotiable property and is proven by the test matrix:
 * mergeBlobs is commutative, associative, and idempotent (under canonicalize).
 */

/* ======================================================================== */
/* SHA-256 — embedded, synchronous, dependency-free (FIPS 180-4)            */
/* ------------------------------------------------------------------------ */
/* Web Crypto's subtle.digest is async, which would force every consumer    */
/* (canonicalize/blobHash/conflictId/mergeBlobs) to be async. The merge core */
/* must be synchronous + pure, so we embed a compact SHA-256 and use the     */
/* SAME implementation everywhere. Hashing is always over canonical bytes.   */
/* ======================================================================== */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** UTF-8 encode a string to an array of byte values. */
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      // surrogate pair -> single code point
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** SHA-256 of a UTF-8 string -> 64-char lowercase hex. */
function sha256hex(str) {
  const bytes = utf8Bytes(str);
  const l = bytes.length;

  // Pad: append 0x80, then zeros, then 64-bit big-endian bit length.
  const withOne = bytes.slice();
  withOne.push(0x80);
  while (withOne.length % 64 !== 56) withOne.push(0);
  const bitLenHi = Math.floor(l / 0x20000000); // (l*8) >> 32
  const bitLenLo = (l * 8) >>> 0;
  withOne.push((bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 8) & 0xff, bitLenHi & 0xff);
  withOne.push((bitLenLo >>> 24) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 8) & 0xff, bitLenLo & 0xff);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Array(64);
  for (let i = 0; i < withOne.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] =
        ((withOne[i + t * 4] << 24) |
          (withOne[i + t * 4 + 1] << 16) |
          (withOne[i + t * 4 + 2] << 8) |
          withOne[i + t * 4 + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

/* ======================================================================== */
/* 1. Canonical serialization                                              */
/* ======================================================================== */

// Conflict-id hash length (hex chars). 12 = 48 bits, ample for slot ids.
const SHORT_HASH = 12;

/**
 * Deterministic JSON. Object keys sorted at every depth; no insignificant
 * whitespace; numbers via JSON's stable formatting. Array order is normalized
 * ONLY where order is not semantically meaningful:
 *   - arrays of entities (every element an object with a string `id`: cards,
 *     tags, columns, tombstones) are sorted by `id`;
 *   - arrays of primitives (e.g. a card's `tags:[tagId]`) are sorted by value;
 *   - arrays of objects WITHOUT an `id` (e.g. a card's `checklist:[{text,done}]`)
 *     keep their order — that order IS meaningful and must not be disturbed.
 * Two semantically identical blobs therefore canonicalize to byte-identical
 * strings regardless of in-memory key/array order.
 */
export function canonicalize(value) {
  return enc(value);
}

function enc(v) {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s; // undefined leaf -> null (JSON array semantics)
  }
  if (Array.isArray(v)) {
    const items = v.map((el) => ({ el, canon: enc(el) }));
    const allIdObjects =
      items.length > 0 &&
      items.every(
        ({ el }) => el !== null && typeof el === 'object' && !Array.isArray(el) && typeof el.id === 'string',
      );
    const allPrimitive =
      items.length > 0 && items.every(({ el }) => el === null || typeof el !== 'object');
    if (allIdObjects) {
      items.sort((x, y) =>
        x.el.id < y.el.id ? -1 : x.el.id > y.el.id ? 1 : x.canon < y.canon ? -1 : x.canon > y.canon ? 1 : 0,
      );
    } else if (allPrimitive) {
      items.sort((x, y) => (x.canon < y.canon ? -1 : x.canon > y.canon ? 1 : 0));
    } // else: order-meaningful (e.g. checklist) — leave as-is
    return '[' + items.map((it) => it.canon).join(',') + ']';
  }
  const keys = Object.keys(v).sort();
  const parts = [];
  for (const k of keys) {
    if (v[k] === undefined) continue; // drop undefined-valued keys (JSON semantics)
    parts.push(JSON.stringify(k) + ':' + enc(v[k]));
  }
  return '{' + parts.join(',') + '}';
}

/** SHA-256 hex of the canonical bytes of a blob. */
export function blobHash(blob) {
  return sha256hex(canonicalize(blob));
}

/* ======================================================================== */
/* 2. Deterministic, device-independent conflict ids                       */
/* ======================================================================== */

const canonLess = (a, b) => {
  const ca = canonicalize(a);
  const cb = canonicalize(b);
  return ca <= cb;
};
/** The deterministic winner of a same-id divergence: lexicographically-lesser canon. */
const lesserCanon = (a, b) => (canonLess(a, b) ? a : b);

/**
 * The conflict slot id a displaced card lands at, derived from that card's OWN
 * canonical content (which still carries its base `id`). Content-only — never a
 * device id, never a clock.
 */
function conflictSlotId(card) {
  return `${card.id}.conflict.${sha256hex(canonicalize(card)).slice(0, SHORT_HASH)}`;
}

/**
 * Deterministic, device-independent conflict id for a same-id divergence.
 * Symmetric: both devices compute the identical result. The lexicographically-
 * LESSER-canonical card keeps `baseId`; the GREATER one is displaced, and its
 * conflict id is a function of ITS OWN content alone.
 *
 * NOTE — deliberate, flagged deviation from the literal spec wording ("sort the
 * two canonical strings, join, hash"): a PAIR hash makes a displaced card's id
 * depend on what it collided with, which breaks three-way ASSOCIATIVITY (the same
 * card would land at different conflict ids under different merge groupings).
 * Convergence is the overriding, non-negotiable requirement, so the conflict id
 * is keyed on the displaced (greater-canonical) card's own canon. This is still
 * content-only and symmetric, and it is what makes the proven matrix hold.
 */
export function conflictId(cardA, cardB) {
  const loser = canonLess(cardA, cardB) ? cardB : cardA;
  return conflictSlotId(loser);
}

/**
 * Build the conflict copy of a displaced (loser) card: same content, re-homed to
 * its conflict slot id, with loser-only provenance. We record the copy's OWN
 * source version and base lineage id — NOT the winner's version, which would vary
 * by merge grouping and break associativity. The counterpart version remains
 * visible on the base card, so both diverged versions survive (no data lost).
 */
function makeConflictCopy(loser) {
  return {
    ...loser,
    id: conflictSlotId(loser),
    _conflict: { of: loser.id, source_version: loser.version },
  };
}

/* ======================================================================== */
/* 3. The merge                                                            */
/* ======================================================================== */

const isTombstone = (card) => card != null && card.deleted_at != null;

/**
 * Resolve two cards sharing an id into a kept card plus an optional displaced
 * conflict copy. Symmetric in its arguments (so the overall merge is commutative)
 * and structured so the result depends only on content (so it is associative):
 * the base slot always converges to the global-minimum-canonical version, and
 * every other version is re-homed to a conflict slot keyed by its own content.
 */
function combineCards(x, y) {
  const xDead = isTombstone(x);
  const yDead = isTombstone(y);

  if (xDead && yDead) {
    // Two tombstones: keep one deterministically. A tombstone has no live content
    // to preserve, so there is no conflict copy.
    return { keep: lesserCanon(x, y) };
  }
  if (xDead || yDead) {
    // Deletion wins the canonical slot and is never resurrected. A genuine
    // post-deletion edit (live.version !== the version on the tombstone) is
    // preserved as a conflict copy so the edit is not silently destroyed; an
    // unchanged live side (matching versions) is a plain deletion.
    const tomb = xDead ? x : y;
    const live = xDead ? y : x;
    if (live.version !== tomb.version) {
      return { keep: tomb, displaced: makeConflictCopy(live) };
    }
    return { keep: tomb };
  }
  // Both live.
  if (x.version === y.version) {
    // Same id + same version => the same card. Include once.
    return { keep: lesserCanon(x, y) };
  }
  // Genuine divergence: lesser-canonical keeps baseId; greater becomes a copy.
  const winner = lesserCanon(x, y);
  const loser = winner === x ? y : x;
  return { keep: winner, displaced: makeConflictCopy(loser) };
}

/** Insert/merge a card into the by-id map, re-homing any displaced conflict copy. */
function addCard(map, card) {
  const existing = map.get(card.id);
  if (!existing) {
    map.set(card.id, card);
    return;
  }
  const { keep, displaced } = combineCards(existing, card);
  map.set(card.id, keep);
  if (displaced) addCard(map, displaced); // identical copies dedup; terminates
}

/** Union two entity lists by id; same-id divergence resolves to lesser-canonical. */
function unionById(listA, listB) {
  const m = new Map();
  for (const item of listA) m.set(item.id, item);
  for (const item of listB) {
    const ex = m.get(item.id);
    m.set(item.id, ex ? lesserCanon(ex, item) : item);
  }
  return [...m.values()];
}

/* ------------------------------------------------------------------------ */
/* Collection registry — declares WHICH top-level collections merge HOW.      */
/* This is the ONLY thing that determines collection dispatch. The union /     */
/* conflictId / tombstone algorithm is UNCHANGED; enrolling a collection is    */
/* purely additive (list its name here). The spine's projects/tasks/artifacts/ */
/* escalations get full id-keyed conflict-copy union by appearing in           */
/* UNION_COLLECTIONS — no new merge logic, no cross-collection awareness.       */
/* ------------------------------------------------------------------------ */
// Full id-keyed union WITH deterministic conflict copies (the cards path).
const UNION_COLLECTIONS = ['cards', 'projects', 'tasks', 'artifacts', 'escalations'];
// Union by id, lesser-canonical wins a same-id divergence (NO conflict copies).
const CONFIG_COLLECTIONS = ['columns', 'tags'];
// Everything registered is handled by mergeBlobs; mergeRest skips both lists.
// Anything still unregistered falls through mergeRest exactly as before.
const REGISTERED_COLLECTIONS = new Set([...UNION_COLLECTIONS, ...CONFIG_COLLECTIONS]);

/** Merge all top-level keys except the registered collections, deterministically. */
function mergeRest(a, b) {
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (REGISTERED_COLLECTIONS.has(k)) continue; // handled by the union/config registries
    if (!(k in a)) out[k] = b[k];
    else if (!(k in b)) out[k] = a[k];
    else out[k] = lesserCanon(a[k], b[k]); // deterministic tie-break (commutative + associative)
  }
  return out;
}

/**
 * Pure merge of two blobs. Commutative, associative, and idempotent under
 * canonicalize() (see the test matrix). No data is discarded: a same-id
 * divergence keeps the lesser-canonical entity at its base id and preserves the
 * other as a conflict copy.
 *
 * Collection dispatch is driven by the registry (UNION_COLLECTIONS /
 * CONFIG_COLLECTIONS), NOT hardcoded names. A registered collection is
 * materialized only when present in at least one input, so output stays
 * byte-identical to the prior hardcoded behavior for cards/columns/tags and no
 * empty collection an input never had is injected.
 */
export function mergeBlobs(a, b) {
  // Registered union collections: union by id with deterministic conflict
  // resolution + re-homing (the proven cards path, now applied to every
  // registered union collection — e.g. the spine's tasks/artifacts/...).
  const union = {};
  for (const name of UNION_COLLECTIONS) {
    if (!(name in a) && !(name in b)) continue;
    const map = new Map();
    for (const item of a[name] || []) addCard(map, item);
    for (const item of b[name] || []) addCard(map, item);
    union[name] = [...map.values()];
  }

  // Registered config collections: union by id, lesser-canonical wins a same-id
  // divergence (no conflict copies).
  const config = {};
  for (const name of CONFIG_COLLECTIONS) {
    if (!(name in a) && !(name in b)) continue;
    config[name] = unionById(a[name] || [], b[name] || []);
  }

  // Strip dangling tag refs (the A.5-proper invariant) — UNCHANGED scope: applies
  // ONLY to cards, whose `tags:[tagId]` may reference a tag absent from the merged
  // tags. No-op on well-formed inputs; NOT extended to any other collection (no
  // new cross-collection awareness). A card whose column_id is absent from the
  // merged columns is LEFT INTACT (the UI renders it in a fallback tray per spec).
  if ('cards' in union) {
    const tagIds = new Set((config.tags || []).map((t) => t.id));
    union.cards = union.cards.map((c) =>
      Array.isArray(c.tags) && c.tags.some((t) => !tagIds.has(t))
        ? { ...c, tags: c.tags.filter((t) => tagIds.has(t)) }
        : c,
    );
  }

  return { ...mergeRest(a, b), ...union, ...config };
}

/* ======================================================================== */
/* 4. The state resolver (pure)                                            */
/* ======================================================================== */

/** A blob is "empty" (a blank board) when it has no cards and no tags. */
function defaultIsEmptyBlob(blob) {
  return (blob.cards || []).length === 0 && (blob.tags || []).length === 0;
}

/** Structurally a blob: an object with a cards array. */
function defaultIsBlob(b) {
  return b != null && typeof b === 'object' && Array.isArray(b.cards);
}

/**
 * Decide what to do with a local blob versus the drive blob, given the hash this
 * device last synced. PURE — never performs I/O; for `merge` it returns the
 * merged blob, for `collision` it returns no blob (the caller drives the user
 * choice). Branches are evaluated in strict precedence order; first match wins.
 * This ordering is the fix for the fall-through bugs the review caught — notably
 * that an empty side (branch 3) must short-circuit BEFORE the lastSynced/merge
 * branches, so it never falls through to an auto-merge.
 *
 * The blob-shape (`isBlob`) and emptiness (`isEmpty`) predicates are injectable so
 * the SAME reconcile policy serves a non-card schema (the spine: projects/tasks/
 * artifacts/escalations) without forking this function. They default to the card
 * shape, so every existing caller is byte-identical. The reconcile branches and
 * the convergent `mergeBlobs` are UNCHANGED — only the shape checks are pluggable.
 *
 * @returns {{ action: 'in_sync'|'adopt_drive'|'push_local'|'merge'|'collision'|'recover',
 *             blob?: object, reason: string }}
 */
export function resolve({ local, drive, lastSynced }, { isBlob = defaultIsBlob, isEmpty = defaultIsEmptyBlob } = {}) {
  // 1. Drive missing/malformed — the caller recovers (e.g. restore from .bak).
  if (!isBlob(drive)) {
    return { action: 'recover', reason: 'drive is null or malformed' };
  }

  const localHash = blobHash(local);
  const driveHash = blobHash(drive);

  // 2. Byte-identical state — nothing to do (caller may fast-forward lastSynced).
  if (driveHash === localHash) {
    return { action: 'in_sync', reason: 'drive and local hash identical' };
  }

  // 3. Either side empty — ignore lastSynced entirely (this also catches the
  //    review's fall-through: lastSynced present but matching neither + one side
  //    empty must adopt/push, never merge).
  const localEmpty = isEmpty(local);
  const driveEmpty = isEmpty(drive);
  if (localEmpty || driveEmpty) {
    if (localEmpty) return { action: 'adopt_drive', reason: 'local is empty; take drive' };
    return { action: 'push_local', reason: 'drive is empty; upload local' };
  }

  // 4. Local unchanged since last sync, drive advanced — adopt drive.
  if (lastSynced != null && lastSynced === localHash) {
    return { action: 'adopt_drive', reason: 'local unchanged since sync; drive advanced' };
  }

  // 5. Drive unchanged since last sync, local advanced — push local.
  if (lastSynced != null && lastSynced === driveHash) {
    return { action: 'push_local', reason: 'drive unchanged since sync; local advanced' };
  }

  // 6. Never synced on this device, both non-empty — unrelated histories. The
  //    caller MUST prompt the user; the resolver does NOT auto-merge these.
  if (lastSynced == null) {
    return { action: 'collision', reason: 'no shared sync point; unrelated histories' };
  }

  // 7. Shared sync point, both advanced — three-way convergent merge.
  return {
    action: 'merge',
    blob: mergeBlobs(local, drive),
    reason: 'both advanced since the shared sync point',
  };
}
