<!-- CANONICAL. Home of this contract (kanbantt-app owns it); the Claunker spine keeps a synced copy at claunker-hermes/docs/kanbantt-mcp-spec.md. Bodies verified byte-identical outside this comment 2026-07-03. v0.4.0 (the archive surface) ORIGINATED spine-side on 2026-07-02 — the documented reverse-flow exception — and was back-synced FROM that spine copy VERBATIM on 2026-07-02, closing the drift. Normal flow (kanbantt → spine re-sync on change) resumes from here. Canonical edited at v0.5.0 on 2026-07-06; re-synced to the claunker copy same day. Normal flow applies. Canonical edited at v0.6.0 (draft) on 2026-07-20 on branch feat/board-card-create — claunker-copy re-sync PENDING review/merge (the spine's v0.6.0 implementation landed the same day on its own feat/board-card-create). -->

# Kanbantt MCP Specification

**Version:** 0.6.0
**Date:** 2026-07-20
**Author:** Erick M. Gonzales
**Schema Version:** 1
**Status:** Private draft — breaking changes permitted until public release
**Supersedes:** kanbantt-provider-spec.md v0.1.0 (REST contract, retired)
**Parent Doc:** claunker-foundation.md
**MCP Revision Pinned:** 2025-06-18 (verify latest before public release)

**Changes in v0.6.0 (draft):** (a) Adds `project_list` — the optional project-targeting read, `{ "projects": [{ id, name, created_at }] }`, live projects only in deterministic `(created_at, id)` order — gated on the new `canTargetProjects` capability, derived from that one tool ALONE, independent of `canWrite`. (b) `card_create` input gains an optional top-level `project_id` riding NEXT TO the card (CardInput stays a pure Card subset). A server advertising `project_list` is **project-aware**: `project_id` is REQUIRED there — absent → `validation_failed` naming `project_list`; unknown or tombstoned project → `not_found`; there is NO default-project fallback. Idempotent replay of a known id runs BEFORE the targeting requirement, so a retry of a landed create never trips targeting. A server without `project_list` MUST ignore a sent `project_id`. (c) CardInput requiredness relaxes to human-intake defaults: `title` becomes the ONE required field; absent `id` → server-minted, absent `column_id` → the server's intake column (its first Board column — the `created` semantic state on a governance spine), absent `order` → append at end. A create is INTAKE ONLY: servers MUST NOT auto-tier (the card is untiered unless the input itself carries a tier) and MUST NOT trigger downstream automation. Data `schema_version` unchanged: no Card shape change.

**Changes in v0.5.0:** (a) `card_update` patch adopts RFC 7386 key-presence semantics: key absent = unchanged, key present with `null` = CLEAR; clearable set enumerated: `due`, `effort`, `impact`; `depends_on` clears via `[]` (type-strict; `null` → `validation_failed`); guarded set: `tier`, `archived_at`, `deleted_at` — present-null → `validation_failed` naming the governed tool (`card_retier`, `card_archive`/`card_unarchive`, `card_delete`). (b) Card gains `depends_on: [card-id]`, empty default — display-only dependency metadata (no server-side transition gating); dangling refs render greyed and are never stripped from storage; self-reference rejected at write; cycles flagged at render, never blocked at write; clears via `[]`. (c) Reserves the append-only generic card-edit audit ledger `{ card_id, field, old, new, actor, ts }` covering `due`, `effort`, `impact`, `depends_on` mutations, recorded server-side atomically with each set/change/clear; no read API this version (same stance as the tier- and archive-audit ledgers). Data `schema_version` unchanged: new fields are additive (nullable or empty-default).

**Changes in v0.4.0:** Adds the governed, audited archive pair `card_archive` / `card_unarchive`, gated on the new `canArchive` capability (derived from `card_archive` alone); adds the nullable `archived_at` Card field — an orthogonal flag mirroring `deleted_at`'s shape, NOT a lifecycle state (an archived card keeps its `column_id`); adds `include_archived` to `card_list` (archived cards omitted from full fetches by default, composing with `include_deleted`); and reserves the append-only archive-audit ledger (recorded server-side, no read API this version, same stance as the tier-audit ledger). Data `schema_version` is unchanged: `archived_at` is nullable-with-null-default, so v1 blobs load untouched.

**Changes in v0.3.0:** Adds `card_retier` — a governed, audited tier change — gated on the new `canRetier` capability; makes a *set* tier **write-once** on `card_update` (a set tier moves only through `card_retier`); and reserves the append-only tier-audit ledger (recorded server-side, no read API this version). The Card schema and data `schema_version` are unchanged: tier still lives as a `tier:N` tag, not a native field.

---

## Purpose

This document defines the contract between Kanbantt (a client-side kanban/calendar/timeline/matrix board) and any remote data backend. The protocol is real MCP: JSON-RPC 2.0 over Streamable HTTP, using MCP tools with enforced output schemas. Any MCP server implementing the required tool set below can serve as a Kanbantt backend.

Claunker's MCP server is the reference implementation. Kanbantt has no dependency on Claunker; the relationship is contract, not coupling. Because the contract is standard MCP, any MCP-speaking agent (Claude Code, claude.ai connectors, or third-party tooling) can read and write the same board Kanbantt renders.

## Design Principles

1. **The Card is canonical.** Servers with task/agent semantics (prompt, agent, status enums) adapt to the Card schema at their boundary. Kanbantt never renders a Task.
2. **Clients never trust clocks.** All synchronization and concurrency use opaque version tokens minted by the authority. Timestamps are display metadata only.
3. **Absence is not deletion — in deltas.** Within delta responses, deletions are communicated exclusively by tombstones; a client MUST NOT infer deletion from a card's absence in a delta. A full fetch is the one exception: it is the authoritative state (see Full Fetch Semantics).
4. **Declare your violence.** Mutations require the expected version. Overwriting without it requires an explicit `force` flag.
5. **Degrade by capability, never silently.** Features gate on advertised tools. Partial or truncated data is an error, never a silent success.

---

## Architecture Context

Kanbantt's UI calls a provider interface; providers own all backend-specific logic.

- **LocalProvider** — default; localStorage, with Google Drive JSON sync as a persistence option. No server required.
- **MCPProvider** — connects to any server conforming to this spec.

### Provider Parity Contract

LocalProvider MUST implement the same semantics as a conforming server wherever the behavior is observable: version-token minting, soft-delete tombstones (same retention floor), idempotent create, and actor stamping (`{ "type": "human", "id": "local" }`). The UI may not branch on provider identity for any behavior covered by this spec.

**Authority handoff (local → MCP migration):** LocalProvider-minted tokens have no meaning to a server. Migration is performed by replaying local cards through `card_create`; per the canonical-response rule, the client adopts each server-returned card and its server-minted `version`. Local tokens are discarded on adoption and MUST never be sent as `expected_version` to a server that did not mint them.

---

## Entity Schemas

A single schema serves as the wire shape, the Drive blob shape, and the localStorage shape. `schema_version` governs all three.

### Card

```json
{
  "id": "uuid",
  "title": "string",
  "description": "string",
  "column_id": "string",
  "order": "string",
  "tags": ["tag-id"],
  "checklist": [{ "text": "string", "done": false }],
  "due": "ISO 8601 | null",
  "priority": "low | med | high",
  "effort": "low | med | high | null",
  "impact": "low | med | high | null",
  "depends_on": ["card-id"],
  "version": "opaque string",
  "deleted_at": "ISO 8601 | null",
  "archived_at": "ISO 8601 | null",
  "created_at": "ISO 8601",
  "updated_at": "ISO 8601",
  "created_by": { "type": "human | agent", "id": "string" },
  "updated_by": { "type": "human | agent", "id": "string" },
  "attachments": [{ "id": "string", "ref": "string" }]
}
```

Field rules:

- **`id`** — client-minted UUIDv4. Servers MUST accept client ids. See `card_create` for duplicate semantics.
- **`order`** — lexicographic fractional position (LexoRank-style string). Inserting between `"a"` and `"c"` mints `"b"`. No integer cascades; reordering one card touches one card. Clients mint positions; the minting algorithm is client-internal but MUST produce strings that sort correctly under ordinal comparison. On an exact `order` collision (possible under concurrent offline minting), clients MUST break the tie by sorting on `id` so rendering is stable.
- **`version`** — opaque token minted by the authority (server, or LocalProvider) on every mutation. Clients MUST NOT generate, parse, or compare these except for equality. This is the sole concurrency primitive.
- **`deleted_at`** — non-null marks a tombstone. Tombstoned cards are soft-deleted; hard deletion is server housekeeping outside this protocol (see Tombstones).
- **`archived_at`** — non-null marks an ARCHIVED card: an orthogonal nullable flag mirroring `deleted_at`'s shape, NOT a lifecycle state. An archived card keeps its `column_id` and all other fields; it is merely omitted from default `card_list` full fetches (see `include_archived`). Set/cleared ONLY through the governed `card_archive` / `card_unarchive` pair — never via `card_update` patch. Archived ≠ deleted: an archived card is live, mutable, and unarchivable; the two flags are independent and compose.
- **`depends_on`** — list of card ids this card depends on; empty list by default. Display-only in v1: the server does NOT gate state transitions on dependency state — the field is stored, projected, and rendered (timeline edges, board badge "waiting on") but enforces no ordering. Plain refs; the merge never rewrites them. Dangling refs (tombstoned or unknown card ids) render greyed at the client and are NEVER stripped from storage. Self-reference (a card depending on itself) is rejected at write (`validation_failed`). Cycles are flagged at render, never blocked at write. Clears via `[]` (sending `null` → `validation_failed` per the patch guarded-set rule).
- **`created_at` / `updated_at`** — display metadata ONLY. MUST NOT be used for synchronization, conflict detection, or ordering decisions.
- **`created_by` / `updated_by`** — stamped by the authority on mutation. Servers SHOULD derive actor identity from the authenticated context; agents SHOULD identify with a stable id.
- **`attachments`** — reserved shape, optional in v1. Large objects live in external storage; the blob carries references only. No v1 tool operates on attachments beyond round-tripping the field.

### Board

```json
{
  "schema_version": 1,
  "columns": [{ "id": "string", "name": "string", "color": "string", "order": "string" }],
  "tags": [{ "id": "string", "name": "string", "color": "string" }]
}
```

Theme is device-local and not part of the board (not synced, not in the blob).

### Escalation (optional capability)

```json
{
  "id": "string",
  "card_id": "string",
  "question": "string",
  "status": "pending | resolved",
  "resolution": "string | null",
  "resolved_at": "ISO 8601 | null"
}
```

### Artifact (optional capability)

```json
{
  "id": "string",
  "card_id": "string",
  "output": "string",
  "type": "code | text | file | error",
  "timestamp": "ISO 8601"
}
```

---

## Schema Versioning & Forward Compatibility

- Clients and servers MUST parse tolerantly: **unknown fields are preserved and round-tripped**, never stripped, never an error.
- Refuse-to-load triggers ONLY when `schema_version` is a major version newer than the client supports. In that case the client MUST refuse the whole document visibly — never partially load.
- Migration hooks exist from day one. v1→v1 is a no-op, but the code path is real and tested.

---

## Reserved Column IDs (Semantic States)

The ids `backlog`, `todo`, `in_progress`, `done` are reserved as **semantic states for agent routing** — a shared vocabulary so a first-contact agent knows where to place work. They are not a UI contract:

- Servers map their internal lifecycle onto these states however fits (e.g. `queued`→`todo`, `running`→`in_progress`, `failed`→`done` with an error-typed artifact).
- Clients map reserved states onto whatever columns the user actually has.
- User-defined columns carry generated ids and are never required to exist server-side.

### Unknown Columns — Fallback Tray

A client receiving cards with a `column_id` it cannot map MUST render them in a visible fallback tray. Tray cards are **read-only for data mutations**: the client MUST NOT issue `card_update` or `card_delete` against them. The one permitted operation is rescue: a user-initiated `card_move` to a known `column_id`, which lifts the restriction. This prevents a client from clobbering structure it does not understand while never stranding data.

---

## Discovery & Connection

There is no custom capabilities endpoint. Standard MCP mechanisms only:

1. **`initialize`** handshake — server identity (name, version) arrives in `serverInfo`. Kanbantt displays this as the connection indicator (`MCP: Claunker`, `MCP: <name>`).
2. **`tools/list`** — feature gating keys off advertised tool names. The escalations column renders iff `escalation_list` and `escalation_resolve` are advertised. Column-mutation tools absent ⇒ server board config is read-only to the client and column edits stay local. The governed re-tier affordance renders iff `card_retier` is advertised (`canRetier`) — derived from that one tool ALONE, independent of the `card_*` write set (`canWrite`): a server may govern re-tier without offering the full board writes, or vice versa. Likewise the archive affordance: `canArchive` derives true iff `card_archive` is advertised — that one tool ALONE, independent of `canWrite` and `canRetier` (a server advertising `card_archive` without `card_unarchive` is one-way: the client shows archive but no unarchive affordance). And the project picker: `canTargetProjects` derives true iff `project_list` is advertised — that one tool ALONE, the same rule — and marks the server project-aware for `card_create` (see Create semantics).
3. `board_get` returns `kanbantt_schema_version` — the data schema version, deliberately separate from the MCP protocol revision.

Connection flow and indicators (`Local`, `MCP: <name>`, `Local (MCP unavailable)` with retry) carry over from v0.1.0 unchanged.

### Read-Only Servers (a first-class connection state)

A server advertising the read surface (`board_get` + `card_list`) but **not** the four `card_*` write tools is a valid, fully supported backend — not a failed connection. Kanbantt connects, polls, and renders a **read-only mirror**; the connection indicator reads `MCP: <name> (read-only)`.

- **Required for a viable connection:** `board_get` + `card_list`. A server missing either is genuinely unusable (no board to render) and connection fails as incompatible.
- **Write affordances are feature-gated on the four `card_*` write tools** — `card_create`, `card_update`, `card_move`, `card_delete`, treated as a set. All four advertised ⇒ writes enabled (`canWrite`); any absent ⇒ the board is read-only: drag is disabled at the source (`draggable=false`), and add/edit/delete controls are suppressed. This is the same rule the column-mutation and escalation tools already follow above.
- **Capability is detected from `tools/list`, never assumed.** A client MUST gate writes on advertised tool names, not on connection success.

(The Required Tools table below lists the `card_*` tools because a *fully writable* backend needs them; their absence gates writes off per the rule here, it does not block the connection. This is Design Principle 5 — degrade by capability, never silently — applied to the card surface.)

---

## Tool Contract (v1)

Tools-only. No resources or subscriptions in v1; clients poll. Resources + `resources/subscribe` are the v2 realtime path.

All tool results use `structuredContent` with a **top-level object wrapper** (MCP requires an object, not an array). All output schemas are **normative and enforced**: a result that fails its output schema is a server bug, full stop.

### Required Tools

| Tool | Input | Output (structuredContent) |
|---|---|---|
| `board_get` | — | `{ "board": Board, "kanbantt_schema_version": 1 }` |
| `card_list` | `{ "updated_since?": sync_token, "column_id?": string, "tag?": string, "include_deleted?": bool, "include_archived?": bool }` | `{ "cards": [Card], "sync_token": string }` |
| `card_get` | `{ "id": string }` | `{ "card": Card }` |
| `card_create` | `{ "card": CardInput, "project_id?": string }` | `{ "card": Card }` |
| `card_update` | `{ "id": string, "patch": object, "expected_version": string, "force?": bool }` | `{ "card": Card }` |
| `card_move` | `{ "id": string, "column_id": string, "order": string, "expected_version": string, "force?": bool }` | `{ "card": Card }` |
| `card_delete` | `{ "id": string, "expected_version": string }` | `{ "card": Card }` (the tombstone) |

### Optional Tools (gate features on advertisement)

| Tool | Input | Output |
|---|---|---|
| `card_retier` | `{ "id": string, "new_tier": "tier:N", "expected_version": string, "reason": string }` | `{ "card": Card }` |
| `card_archive` | `{ "id": string, "expected_version": string, "reason?": string }` | `{ "card": Card }` |
| `card_unarchive` | `{ "id": string, "expected_version": string, "reason?": string }` | `{ "card": Card }` |
| `project_list` | `{}` | `{ "projects": [{ "id": string, "name": string, "created_at": string }] }` |
| `escalation_list` | `{ "status?": "pending" \| "resolved" }` | `{ "escalations": [Escalation] }` |
| `escalation_resolve` | `{ "id": string, "resolution": string }` | `{ "escalation": Escalation }` |
| `artifact_list` | `{ "card_id": string }` | `{ "artifacts": [Artifact] }` |

`card_retier` is the GOVERNED, audited tier change — gated on its own capability (`canRetier`), distinct from `canWrite`. It changes an already-set tier and is the ONLY way to change a set tier (see Re-tier semantics and the `card_update` write-once rule). It has NO `force`. See Re-tier below.

`card_archive` / `card_unarchive` are the GOVERNED, audited archive pair — gated on `canArchive` (derived from `card_archive` alone), distinct from `canWrite` and `canRetier`. They are the ONLY way to set/clear `archived_at`. Neither has `force`; `reason` is optional on the wire but every audit row records one (see Archive below).

`project_list` is the PROJECT-TARGETING read — gated on `canTargetProjects`, derived from that one tool alone, independent of `canWrite` (a server may expose the enumeration read-only, or accept untargeted creates without it). Live projects only, deterministic `(created_at, id)` order. Its advertisement is what makes a server **project-aware**: `card_create.project_id` becomes REQUIRED there (see Create semantics), and the client's project picker feeds from this enumeration.

Escalations and artifacts referencing a **tombstoned** card remain valid and retrievable (deleted work still has an audit trail). A `card_id` the server has never known returns `not_found`.
| `column_create` / `column_update` | column shape / patch | `{ "board": Board }` |
| `column_delete` | `{ "id": string, "orphan_destination_column_id": string }` | `{ "board": Board }` |
| `tag_create` / `tag_update` | tag shape / patch | `{ "board": Board }` |
| `tag_delete` | `{ "id": string }` | `{ "board": Board }` |

`column_delete`: servers MUST move every card in the deleted column to `orphan_destination_column_id`, minting a new `version` for each moved card. Cascade-deleting cards via `column_delete` is forbidden. If the destination column does not exist, fail with `column_unknown` and delete nothing.

`tag_delete`: servers MUST strip the deleted tag id from every card referencing it, minting a new `version` for each affected card. Dangling tag references are never left behind. Tag tools are optional as a set; when absent, tag edits stay local, mirroring the column rule.

### Semantics

**Synchronization (`card_list`):**
- `sync_token` is opaque, server-minted. Clients echo it verbatim into the next poll's `updated_since`. Clients never construct one.
- If the server cannot honor an `updated_since` token (event log truncated, server state reset), it MUST fail with `sync_token_expired`. On receiving it, the client MUST discard its token and perform a full fetch. Clients MUST NOT retry an expired token.
- When `updated_since` is provided, the response MUST include tombstones matching the window unconditionally — `include_deleted` is ignored for delta queries. `include_deleted` governs full fetches (no `updated_since`) only.
- `include_archived` governs full fetches the same way: archived cards (`archived_at` non-null) are OMITTED from a full fetch by default and included when `include_archived: true`. The two flags COMPOSE independently: a card that is both deleted and archived appears only when BOTH `include_deleted` and `include_archived` are true. Within delta responses, archive/unarchive changes MUST ride unconditionally (they mint a new `version` like any mutation) — `include_archived`, like `include_deleted`, is ignored for delta queries.
- Servers MUST return complete results for any query, or fail with `payload_too_large`. **Capping or truncating a successful response is non-conforming.** A `cursor` parameter is reserved for v2 pagination.

**Full Fetch Semantics (no `updated_since`):**
- A full fetch response is the authoritative server state. A local card absent from it MUST be purged **if and only if the client holds a server-minted `version` for it** (the server once knew it; its absence means hard deletion after tombstone retention).
- Cards with only local provenance (never accepted by this server) are sync candidates, never purge candidates.
- A card with unsynced local edits whose id is absent from a full fetch MUST surface as user-visible reconciliation, never a silent purge and never a silent re-create.

**Create (`card_create`):**
- `CardInput` is a Card minus the authority-owned fields: no `version`, `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at`. Required: `title` (non-empty). Optional with authority defaults (v0.6.0 — the human-intake defaults): `id` (absent → server-minted; supply one to make retries idempotent), `column_id` (absent → the server's intake column: its first Board column, the `created` semantic state on a governance spine), `order` (absent → append at the end of that column). All other fields optional with documented defaults (`priority: "med"`, empty collections, nulls). Authority-owned fields supplied by a client MUST be ignored, not errored; fields a server does not model flatten away at its boundary, and the projection re-emits their Card defaults.
- If the id already exists (including tombstoned), the server returns the existing card as success. Create is safe to retry.
- **Project targeting (v0.6.0):** `project_id` rides at the top level NEXT TO `card`. A server advertising `project_list` is project-aware: `project_id` is REQUIRED — absent → `validation_failed` with a message naming `project_list`; a project the server does not know LIVE → `not_found`. There is NO default-project fallback: a typo must not mint or borrow a project, and a tombstoned project is not a create target. The idempotency rule above runs FIRST — a duplicate `id` returns the existing card as success even with no `project_id` (a retry of a landed create never trips targeting). A server without `project_list` MUST ignore a sent `project_id`. Clients with no target OMIT the key — it is never sent `null`.
- **A create is human intake.** It captures intent and nothing more: the server MUST NOT auto-tier (the card is untiered unless the input itself carries a tier) and MUST NOT dispatch or trigger downstream automation. Classification and dispatch are later, separately governed steps (`card_update`'s free initial tier, then `card_retier`).
- **The card returned by `card_create` is canonical.** The client MUST adopt it wholesale — including its `version` — replacing local state. This single rule covers retry replays, concurrent-edit races, and local→server migration (where the client discards the LocalProvider-minted version in favor of the server's).

**Concurrency (`card_update`, `card_move`, `card_delete`):**
- `expected_version` is REQUIRED. On mismatch the server returns a `conflict` error carrying the current card so the client can re-merge without an extra round trip.
- `force: true` (update/move only) skips the version check. Clients MUST NOT default to force.
- **Tombstoned cards are immutable.** Any `card_update`, `card_move`, or `card_delete` targeting a tombstone MUST fail with `conflict` (meta carries the tombstone), even with `force: true`. There is no undelete in v1; resurrection, if ever supported, is a v2 tool with its own semantics.
- **Patch semantics — RFC 7386 key-presence (`card_update` only):** key ABSENT → field unchanged; key PRESENT with `null` → **clear the field**. Clearable set (all nullable): `due`, `effort`, `impact`. `depends_on` clears via `[]` (type-strict: sending `null` for `depends_on` → `validation_failed`). **Guarded set** — `tier`, `archived_at`, `deleted_at`: a key present with `null` → `validation_failed`, naming the governed tool that owns that field (`card_retier`, `card_archive`/`card_unarchive`, `card_delete` respectively). These fields move only through their governed tools; the back-door lifecycle mutation via patch-null is explicitly closed. **Client obligation:** never send a key you do not mean — a key's presence IS the intent signal.
- **Tier is write-once on `card_update`.** A `patch.tier` that DIFFERS from the card's current set tier MUST fail with `validation_failed` — a set tier changes only through the governed `card_retier`. The free initial classification (an untiered card → its first tier) is allowed; a same-value `patch.tier`, or a patch with no `tier` key, is unaffected. Enforced server-side, so it holds even if a client bypasses any UI lock; `force` does NOT bypass it (force gates only the version check). The check runs AFTER the not-found / tombstone / version gate, so a tombstoned or stale target is still a `conflict`, not a validation error. This value-change guard is separate from and additive to the null guard above: both apply independently.

**Deletion:**
- Soft-delete only at the protocol level: `card_delete` sets `deleted_at` and mints a new `version`.
- Servers MUST retain tombstones ≥ 30 days. A client returning from a longer offline gap MUST treat local-only cards as requiring user-visible reconciliation, never silent re-create.

**Re-tier (`card_retier`) — governed, audited tier change:**
Tier is the one field with a control gradient (tier 1 = self-accept, weakest oversight … tier 4 = human, strongest), so changing a *set* tier is GOVERNED, not a free edit. `card_retier` is gated on `canRetier` (advertised iff the tool is present), independent of `canWrite`. Tier lives as a `tier:N` tag, not a native Card field — a re-tier rewrites that tag.

- **Signature:** `{ id, new_tier, expected_version, reason }` → `{ card }`. `new_tier` is the `tier:N` tag id (the form the projection emits into `tags`; a client mapping an internal `tier-N` form does so at its own boundary). There is NO `column_id` and NO `force`.
- **Concurrency:** `expected_version` is REQUIRED. A re-tier always runs against fresh state: on mismatch it returns `conflict` (meta carries the current card) — re-fetch and re-decide. There is deliberately NO `force`; a governed override never clobbers.
- **Invariants** (each → `validation_failed`), checked AFTER the not-found / tombstone / version gate (a tombstoned or stale target is a `conflict`, not a validation error):
  - the card MUST already be tiered — re-tier is N→M only; there is NO N→null clear in v1 (set the initial tier via `card_update`);
  - `new_tier` MUST be a valid tier (1..4);
  - `new_tier` MUST differ from the current tier — a no-op is rejected and writes NO audit row;
  - `reason` MUST be non-empty after trimming.
- **Audit (record now, render later):** on success the server appends exactly ONE row to an append-only tier-audit ledger, ATOMICALLY with the tier change: `{ card_id, old_tier, new_tier, reduces_control, actor, reason, ts }`. `reduces_control` is true iff `new_tier < old_tier` (a LOWER tier weakens oversight). `actor` is derived from the authenticated credential, NEVER the payload (a placeholder `client:bearer` until per-user tokens; the field accepts a per-user id later with no schema change). `ts` is ISO-8601 UTC. There is NO ledger read tool in this version — the record is written for a later history surface (see Out of Scope).
- On success the tier tag is rewritten in place (the new `tier:N` replaces the old; every OTHER tag is untouched) and the re-projected `{ card }` is returned.

**Archive (`card_archive` / `card_unarchive`) — governed, audited visibility change:**
Archiving takes a finished card out of the default working view without deleting anything. `archived_at` is an ORTHOGONAL nullable flag mirroring `deleted_at`'s shape — NOT a lifecycle state: the card keeps its `column_id`, its tags, and every other field, and stays fully readable and mutable. The pair is gated on `canArchive` (advertised iff `card_archive` is present), independent of `canWrite` and `canRetier`.

- **Signature:** `{ id, expected_version, reason? }` → `{ card }` for both tools. There is NO `force`.
- **Concurrency:** `expected_version` is REQUIRED. On mismatch the server returns `conflict` (meta carries the current card) — re-fetch and re-decide; a governed control never clobbers. Tombstoned cards are immutable as everywhere: either tool targeting one MUST fail with `conflict` (meta carries the tombstone). The not-found / tombstone / version gate runs FIRST — a tombstoned or stale target is a `conflict`, never a validation error.
- **Loud idempotency** (each → `validation_failed`, checked AFTER the gate): `card_archive` on an ALREADY-ARCHIVED card fails with "already archived"; `card_unarchive` on a NOT-ARCHIVED card fails with "not archived". Deliberately NOT idempotent-silent: a healthy operation and a broken caller must not emit the same signal — bulk sweepers filter their own targets rather than blind-firing.
- **Escalation gate** (`card_archive` ONLY, → `validation_failed`): a card with an OPEN escalation (one that is live and not yet resolved) CANNOT be archived — "cannot archive a task with an unresolved escalation". Archiving would bury a card awaiting human attention; resolve the escalation first. `card_unarchive` is ungated (restoring a card to view never buries anything).
- **Reason** — two layers, deliberately split:
  - the WIRE is ergonomic: `reason` is OPTIONAL; when omitted the server injects a deterministic default (`"manual_archive"` / `"manual_unarchive"`). Bulk/auto contexts pass their own canned strings.
  - the LEDGER is hard: every audit row MUST carry a non-empty, non-whitespace reason — the server REJECTS (→ `validation_failed`) an explicitly empty/whitespace `reason` rather than defaulting it (explicit garbage is loud; omission is ergonomic). Result: 100% of ledger rows are reasoned.
- **Audit (record now, render later):** on success the server appends exactly ONE row to an append-only archive-audit ledger, ATOMICALLY with the flag change: `{ card_id, action: "archive" | "unarchive", actor, reason, ts }`. `actor` is derived from the authenticated credential, NEVER the payload (the `client:bearer` placeholder until per-user tokens, exactly as the tier-audit ledger). `ts` is ISO-8601 UTC. A failed gate or invariant writes NO row. There is NO ledger read tool in this version (see Out of Scope).
- **Versioning:** archive and unarchive are real mutations — each mints a new `version` (the token moves on archive and again on unarchive).
- **Full-fetch purge interaction:** archived cards are absent from a DEFAULT full fetch by design, and absence there is NOT deletion. A client that holds a card with non-null `archived_at` MUST NOT purge it on absence from a default full fetch; purge authority over archived cards requires an `include_archived: true` fetch (and `include_deleted: true` for the deleted+archived case).

---

## Errors

Two layers, used per the protocols they belong to:

1. **JSON-RPC / transport layer** — connection, protocol, auth-transport, and gateway failures (including standard JSON-RPC error codes from intermediaries). Clients MUST handle these; they are not domain outcomes.
2. **Tool-execution layer** — domain errors travel in the tool result (`isError: true`) with a structured payload:

```json
{
  "code": "namespaced.string",
  "message": "human-readable",
  "meta": { "retry_after?": seconds, "card?": Card }
}
```

Reserved common codes (extensible; vendors namespace their own, e.g. `claunker.quota_exceeded`):

`not_found` · `conflict` (meta carries current card) · `validation_failed` · `unauthorized` · `column_unknown` · `rate_limited` (meta carries retry_after) · `payload_too_large` · `schema_unsupported` · `sync_token_expired` (client response: full fetch) · `invalid_sync_token` (token is malformed or foreign, not merely old; client response: discard token, full fetch, and surface a diagnostic, since this indicates a bug or a backend switch rather than normal aging)

Unknown codes MUST be treated as non-retryable failures and surfaced, not swallowed, EXCEPT that clients MUST honor `meta.retry_after` whenever present on any code, known or vendor-defined.

Note on deletion: `card_delete` deliberately has no `force`. Deletion always requires the current version; on `conflict`, re-read and retry. This asymmetry is intentional, destructive operations do not get a bypass.

---

## Transport & CORS

Transport is MCP Streamable HTTP. Browser clients are first-class; servers intending browser use MUST send (origins adjusted):

```
Access-Control-Allow-Origin: <client origin>
Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS
Access-Control-Allow-Headers: Content-Type,Authorization,mcp-session-id,mcp-protocol-version,Accept,Last-Event-ID
Access-Control-Expose-Headers: mcp-session-id
```

Notes from verified implementation: GET serves the server→client SSE stream and DELETE the session teardown, so both are required even for polling-only clients. `Expose-Headers: mcp-session-id` is load-bearing — the session id travels in a response header and is invisible to browser JS without it. `Content-Type` and `Accept` trip preflight because the transport sends non-safelisted values.

---

## Auth (v1)

Bearer token on the HTTP transport: `Authorization: Bearer <token>`.

**This is a documented deviation from MCP's OAuth 2.1 authorization model**, accepted for the private-draft phase. OAuth 2.1 is the v2 path and a gating item for public release.

Client handling:
- Token held **in memory by default**. Persisting to localStorage is an explicit opt-in ("remember this server") with the XSS exposure acknowledged: any script execution in the page can read it. CSP remains the practical defense.
- Servers SHOULD issue short-lived tokens.
- 401 surfaces as a settings error with a token prompt — never a silent fallback to LocalProvider.

---

## Configuration

`localStorage['kanbantt_config']`:

```json
{
  "data_source": "local | mcp | auto",
  "mcp": {
    "url": "https://server.example.com",
    "remember_token": false,
    "auth_token": "present only if remember_token",
    "last_connected": "ISO 8601",
    "server_name": "cached from initialize"
  },
  "auto_detect": true,
  "poll_interval_ms": 5000
}
```

`auto` pings the configured server on load (3s timeout) and falls back to LocalProvider with a visible `Local (MCP unavailable)` indicator. Manual modes disable auto-detection.

---

## Explicitly Out of Scope for v1 (reserved, not forgotten)

- **Pagination** — `cursor` reserved; complete-or-error is the v1 rule.
- **Realtime** — resources + `resources/subscribe`; polling until then.
- **Batch operations** — `card_batch` as a future optional tool.
- **OAuth 2.1** — release-gating item.
- **Attachment transfer** — schema shape reserved; no transfer tools.
- **Audit log API** — actor fields make it buildable server-side, and `card_retier` / `card_archive` / `card_unarchive` now WRITE append-only tier- and archive-audit ledgers; a generic card-edit audit ledger also now WRITES on every `due`, `effort`, `impact`, `depends_on` set/change/clear via `card_update`; there is still no protocol READ surface for any of these (record now, render later — a history tool is a later version).
- **CRDT / collaborative editing** — version tokens + fractional ordering cover current scenarios; CRDT is the escalation path only if live co-editing becomes a goal.

---

## Relationship to Claunker

Claunker implements this specification as its primary board interface; its MCP server is the reference implementation. The reference implementation additionally carries these implementation obligations not visible in the protocol: replace in-memory session storage before production, derive actor identity from authenticated context, and enforce tombstone retention.

Kanbantt is not a Claunker product. Any MCP server implementing the required tool set is a first-class backend.

---

*This document is the canonical reference for the Kanbantt MCP Specification and a corpus document in the Claunker knowledge system.*
