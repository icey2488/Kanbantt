# Bringing your own spine

The board is a client. Any MCP server that implements the Kanbantt board contract ([kanbantt-mcp-spec.md](kanbantt-mcp-spec.md)) can serve it. The spec is the contract. This document is the field guide: the parts implementers get wrong first, because they only fail once a real browser client connects.

## Transport in one paragraph

MCP Streamable HTTP at a single endpoint (`https://your-host/mcp`). The board POSTs one JSON-RPC 2.0 message per request with `Accept: application/json, text/event-stream` and `Content-Type: application/json`. Your endpoint must also answer GET (serve an SSE stream, or return 405 if you don't stream) and DELETE (session teardown). Implement all three verbs even if two are minimal; a browser client will exercise them.

## The five walls, in the order you'll hit them

**1. CORS preflight.** The browser sends OPTIONS before anything else. `Access-Control-Allow-Headers` must include at least `authorization, content-type, mcp-protocol-version, mcp-session-id`; allow `POST, GET, DELETE, OPTIONS`; set `Access-Control-Allow-Origin` for the board's origin. Miss any of these and nothing works, with only a console CORS error to show for it.

**2. The session-id echo.** Your initialize response carries an `Mcp-Session-Id` header. Browsers cannot read that header unless you also send `Access-Control-Expose-Headers: mcp-session-id`. This is the single most common failure mode: the server looks healthy, initialize succeeds, and every subsequent call fails because the client never saw the session id. The board echoes `Mcp-Session-Id` on every request after initialize. Validate it, and reject unknown or expired sessions with 404 so the client knows to re-initialize.

**3. Auth.** Plain `Authorization: Bearer <token>` on every request, including initialize. Wrong or missing token: return a real 401, not a 500. (This is a documented deviation from MCP's OAuth 2.1 baseline, deliberate for personal servers with no identity provider.) The board treats 401 as a distinct auth-rejected state: it stops retrying and tells the user to fix the token. Honest status codes make your server debuggable from the other side.

**4. The structuredContent envelope.** Tool results return `structuredContent` as an object, never a bare array: `{"tasks": [...]}`, not `[...]`. Wrap everything, including single-item and empty results.

**5. Version tokens.** Every entity carries an opaque `version` token your server mints fresh on every write. Clients treat tokens as equality-only: never parsed, never ordered, so any unique string works. Every mutation requires `expected_version`; on mismatch, return the `conflict` error with the current entity in `meta.card` so the client can converge to your truth. `force: true` exists on some mutations to skip the check; never require it and never default it. Tombstoned (deleted) entities are immutable: a mutation against one is also a `conflict`, carrying the tombstone.

## Semantics that bite later

- **Complete results or refuse.** Return the full result set or the `payload_too_large` error. Never silently truncate. Clients trust complete-or-error.
- **Polling, not push.** v1 clients poll (the board's default cadence is ~5s). Don't wait for subscription traffic that never comes; resources and subscriptions are a later-version concern.
- **Columns are yours; reserved ids carry semantics.** Serve whatever columns model your domain. The spec's reserved column ids carry cross-client meaning for routing card state; use them where they fit so generic clients can reason about your board.
- **Order strings are client-minted.** The board sends fractional (LexoRank-style) `order` strings on moves. Store and return them verbatim; sort lexicographically. Don't renumber.

## How the board tells you what's wrong

- **Connection pill:** `LOCAL` (no spine configured) · `MCP: <NAME>` in green (connected; shows your server's name) · `LOCAL (MCP UNAVAILABLE · RETRYING…)` (transport unreachable; the board backs off and retries) · `LOCAL (MCP AUTH REJECTED)` (your server returned 401; the board stops retrying and prompts for a new token).
- A 404 on connect usually means the URL is missing its `/mcp` path suffix; the Connection settings hint says the same.
- Tool-execution errors surface in the UI with their error code. `conflict` specifically triggers the board's convergence behavior: it adopts the entity you returned in `meta.card`.

## Smoke checklist

A conforming spine, tested from a real browser, should pass all seven:

1. OPTIONS preflight returns clean with the headers above
2. initialize succeeds AND the client can read `Mcp-Session-Id` (Expose-Headers set)
3. tools/list returns the board tool set from the spec
4. A read tool returns an object-enveloped `structuredContent`
5. A mutation without `expected_version` is rejected
6. A mutation with a stale `expected_version` returns `conflict` with the current entity in `meta.card`
7. A bad Bearer token gets a 401 (and the board's pill says AUTH REJECTED, not UNAVAILABLE)

If all seven pass, the board will connect and stay connected.
