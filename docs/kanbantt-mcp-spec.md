# Kanbantt MCP Specification

**Version:** 0.2.3 **Date:** 2026-06-11 **Author:** Erick M. Gonzales **Schema Version:** 1 **Status:** Private draft — breaking changes permitted until public release **Supersedes:** kanbantt-provider-spec.md v0.1.0 (REST contract, retired) **Parent Doc:** claunker-foundation.md **MCP Revision Pinned:** 2025-06-18 (verify latest before public release)

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

{

  "id": "uuid",

  "title": "string",

  "description": "string",

  "column\_id": "string",

  "order": "string",

  "tags": \["tag-id"\],

  "checklist": \[{ "text": "string", "done": false }\],

  "due": "ISO 8601 | null",

  "priority": "low | med | high",

  "effort": "low | med | high | null",

  "impact": "low | med | high | null",

  "version": "opaque string",

  "deleted\_at": "ISO 8601 | null",

  "created\_at": "ISO 8601",

  "updated\_at": "ISO 8601",

  "created\_by": { "type": "human | agent", "id": "string" },

  "updated\_by": { "type": "human | agent", "id": "string" },

  "attachments": \[{ "id": "string", "ref": "string" }\]

}

Field rules:

- **`id`** — client-minted UUIDv4. Servers MUST accept client ids. See `card_create` for duplicate semantics.  
- **`order`** — lexicographic fractional position (LexoRank-style string). Inserting between `"a"` and `"c"` mints `"b"`. No integer cascades; reordering one card touches one card. Clients mint positions; the minting algorithm is client-internal but MUST produce strings that sort correctly under ordinal comparison. On an exact `order` collision (possible under concurrent offline minting), clients MUST break the tie by sorting on `id` so rendering is stable.  
- **`version`** — opaque token minted by the authority (server, or LocalProvider) on every mutation. Clients MUST NOT generate, parse, or compare these except for equality. This is the sole concurrency primitive.  
- **`deleted_at`** — non-null marks a tombstone. Tombstoned cards are soft-deleted; hard deletion is server housekeeping outside this protocol (see Tombstones).  
- **`created_at` / `updated_at`** — display metadata ONLY. MUST NOT be used for synchronization, conflict detection, or ordering decisions.  
- **`created_by` / `updated_by`** — stamped by the authority on mutation. Servers SHOULD derive actor identity from the authenticated context; agents SHOULD identify with a stable id.  
- **`attachments`** — reserved shape, optional in v1. Large objects live in external storage; the blob carries references only. No v1 tool operates on attachments beyond round-tripping the field.

### Board

{

  "schema\_version": 1,

  "columns": \[{ "id": "string", "name": "string", "color": "string", "order": "string" }\],

  "tags": \[{ "id": "string", "name": "string", "color": "string" }\]

}

Theme is device-local and not part of the board (not synced, not in the blob).

### Escalation (optional capability)

{

  "id": "string",

  "card\_id": "string",

  "question": "string",

  "status": "pending | resolved",

  "resolution": "string | null",

  "resolved\_at": "ISO 8601 | null"

}

### Artifact (optional capability)

{

  "id": "string",

  "card\_id": "string",

  "output": "string",

  "type": "code | text | file | error",

  "timestamp": "ISO 8601"

}

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
2. **`tools/list`** — feature gating keys off advertised tool names. The escalations column renders iff `escalation_list` and `escalation_resolve` are advertised. Column-mutation tools absent ⇒ server board config is read-only to the client and column edits stay local.  
3. `board_get` returns `kanbantt_schema_version` — the data schema version, deliberately separate from the MCP protocol revision.

Connection flow and indicators (`Local`, `MCP: <name>`, `Local (MCP unavailable)` with retry) carry over from v0.1.0 unchanged.

---

## Tool Contract (v1)

Tools-only. No resources or subscriptions in v1; clients poll. Resources \+ `resources/subscribe` are the v2 realtime path.

All tool results use `structuredContent` with a **top-level object wrapper** (MCP requires an object, not an array). All output schemas are **normative and enforced**: a result that fails its output schema is a server bug, full stop.

### Required Tools

| Tool | Input | Output (structuredContent) |
| :---- | :---- | :---- |
| `board_get` | — | `{ "board": Board, "kanbantt_schema_version": 1 }` |
| `card_list` | `{ "updated_since?": sync_token, "column_id?": string, "tag?": string, "include_deleted?": bool }` | `{ "cards": [Card], "sync_token": string }` |
| `card_get` | `{ "id": string }` | `{ "card": Card }` |
| `card_create` | `{ "card": CardInput }` | `{ "card": Card }` |
| `card_update` | `{ "id": string, "patch": object, "expected_version": string, "force?": bool }` | `{ "card": Card }` |
| `card_move` | `{ "id": string, "column_id": string, "order": string, "expected_version": string, "force?": bool }` | `{ "card": Card }` |
| `card_delete` | `{ "id": string, "expected_version": string }` | `{ "card": Card }` (the tombstone) |

### Optional Tools (gate features on advertisement)

| Tool | Input | Output |
| :---- | :---- | :---- |
| `escalation_list` | `{ "status?": "pending" | "resolved" }` | `{ "escalations": [Escalation] }` |
| `escalation_resolve` | `{ "id": string, "resolution": string }` | `{ "escalation": Escalation }` |
| `artifact_list` | `{ "card_id": string }` | `{ "artifacts": [Artifact] }` |

Escalations and artifacts referencing a **tombstoned** card remain valid and retrievable (deleted work still has an audit trail). A `card_id` the server has never known returns `not_found`. | `column_create` / `column_update` | column shape / patch | `{ "board": Board }` | | `column_delete` | `{ "id": string, "orphan_destination_column_id": string }` | `{ "board": Board }` |

`column_delete`: servers MUST move every card in the deleted column to `orphan_destination_column_id`, minting a new `version` for each moved card. Cascade-deleting cards via `column_delete` is forbidden. If the destination column does not exist, fail with `column_unknown` and delete nothing.

### Semantics

**Synchronization (`card_list`):**

- `sync_token` is opaque, server-minted. Clients echo it verbatim into the next poll's `updated_since`. Clients never construct one.  
- If the server cannot honor an `updated_since` token (event log truncated, server state reset), it MUST fail with `sync_token_expired`. On receiving it, the client MUST discard its token and perform a full fetch. Clients MUST NOT retry an expired token.  
- When `updated_since` is provided, the response MUST include tombstones matching the window unconditionally — `include_deleted` is ignored for delta queries. `include_deleted` governs full fetches (no `updated_since`) only.  
- Servers MUST return complete results for any query, or fail with `payload_too_large`. **Capping or truncating a successful response is non-conforming.** A `cursor` parameter is reserved for v2 pagination.

**Full Fetch Semantics (no `updated_since`):**

- A full fetch response is the authoritative server state. A local card absent from it MUST be purged **if and only if the client holds a server-minted `version` for it** (the server once knew it; its absence means hard deletion after tombstone retention).  
- Cards with only local provenance (never accepted by this server) are sync candidates, never purge candidates.  
- A card with unsynced local edits whose id is absent from a full fetch MUST surface as user-visible reconciliation, never a silent purge and never a silent re-create.

**Create (`card_create`):**

- `CardInput` is a Card minus the authority-owned fields: no `version`, `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at`. Required: `id`, `title`, `column_id`, `order`. All other fields optional with documented defaults (`priority: "med"`, empty collections, nulls). Authority-owned fields supplied by a client MUST be ignored, not errored.  
- If the id already exists (including tombstoned), the server returns the existing card as success. Create is safe to retry.  
- **The card returned by `card_create` is canonical.** The client MUST adopt it wholesale — including its `version` — replacing local state. This single rule covers retry replays, concurrent-edit races, and local→server migration (where the client discards the LocalProvider-minted version in favor of the server's).

**Concurrency (`card_update`, `card_move`, `card_delete`):**

- `expected_version` is REQUIRED. On mismatch the server returns a `conflict` error carrying the current card so the client can re-merge without an extra round trip.  
- `force: true` (update/move only) skips the version check. Clients MUST NOT default to force.  
- **Tombstoned cards are immutable.** Any `card_update`, `card_move`, or `card_delete` targeting a tombstone MUST fail with `conflict` (meta carries the tombstone), even with `force: true`. There is no undelete in v1; resurrection, if ever supported, is a v2 tool with its own semantics.

**Deletion:**

- Soft-delete only at the protocol level: `card_delete` sets `deleted_at` and mints a new `version`.  
- Servers MUST retain tombstones ≥ 30 days. A client returning from a longer offline gap MUST treat local-only cards as requiring user-visible reconciliation, never silent re-create.

---

## Errors

Two layers, used per the protocols they belong to:

1. **JSON-RPC / transport layer** — connection, protocol, auth-transport, and gateway failures (including standard JSON-RPC error codes from intermediaries). Clients MUST handle these; they are not domain outcomes.  
2. **Tool-execution layer** — domain errors travel in the tool result (`isError: true`) with a structured payload:

{

  "code": "namespaced.string",

  "message": "human-readable",

  "meta": { "retry\_after?": seconds, "card?": Card }

}

Reserved common codes (extensible; vendors namespace their own, e.g. `claunker.quota_exceeded`):

`not_found` · `conflict` (meta carries current card) · `validation_failed` · `unauthorized` · `column_unknown` · `rate_limited` (meta carries retry\_after) · `payload_too_large` · `schema_unsupported` · `sync_token_expired` (client response: full fetch) · `invalid_sync_token` (token is malformed or foreign, not merely old; client response: discard token, full fetch, and surface a diagnostic, since this indicates a bug or a backend switch rather than normal aging)

Unknown codes MUST be treated as non-retryable failures and surfaced, not swallowed, EXCEPT that clients MUST honor `meta.retry_after` whenever present on any code, known or vendor-defined.

Note on deletion: `card_delete` deliberately has no `force`. Deletion always requires the current version; on `conflict`, re-read and retry. This asymmetry is intentional, destructive operations do not get a bypass.

---

## Transport & CORS

Transport is MCP Streamable HTTP. Browser clients are first-class; servers intending browser use MUST send (origins adjusted):

Access-Control-Allow-Origin: \<client origin\>

Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS

Access-Control-Allow-Headers: Content-Type,Authorization,mcp-session-id,mcp-protocol-version,Accept,Last-Event-ID

Access-Control-Expose-Headers: mcp-session-id

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

{

  "data\_source": "local | mcp | auto",

  "mcp": {

    "url": "https://server.example.com",

    "remember\_token": false,

    "auth\_token": "present only if remember\_token",

    "last\_connected": "ISO 8601",

    "server\_name": "cached from initialize"

  },

  "auto\_detect": true,

  "poll\_interval\_ms": 5000

}

`auto` pings the configured server on load (3s timeout) and falls back to LocalProvider with a visible `Local (MCP unavailable)` indicator. Manual modes disable auto-detection.

---

## Explicitly Out of Scope for v1 (reserved, not forgotten)

- **Pagination** — `cursor` reserved; complete-or-error is the v1 rule.  
- **Realtime** — resources \+ `resources/subscribe`; polling until then.  
- **Batch operations** — `card_batch` as a future optional tool.  
- **OAuth 2.1** — release-gating item.  
- **Attachment transfer** — schema shape reserved; no transfer tools.  
- **Audit log API** — actor fields make it buildable server-side; no protocol surface yet.  
- **CRDT / collaborative editing** — version tokens \+ fractional ordering cover current scenarios; CRDT is the escalation path only if live co-editing becomes a goal.

---

## Relationship to Claunker

Claunker implements this specification as its primary board interface; its MCP server is the reference implementation. The reference implementation additionally carries these implementation obligations not visible in the protocol: replace in-memory session storage before production, derive actor identity from authenticated context, and enforce tombstone retention.

Kanbantt is not a Claunker product. Any MCP server implementing the required tool set is a first-class backend.

---

*This document is the canonical reference for the Kanbantt MCP Specification and a corpus document in the Claunker knowledge system.*  
