# Kanbantt

A client-side kanban board with four views and three storage modes. No accounts, no backend required.

- **Board / Calendar / Timeline / Matrix** — four views over the same cards
- **Local mode** (default): all data lives in your browser's localStorage; works offline, zero setup
- **Google Drive sync** (optional): convergent sync across devices and browsers via your own Drive
- **MCP mode** (optional): the board becomes a live client of any MCP server implementing the Kanbantt board contract

Live instance: https://kanbantt.icehunter.net

## Quickstart (dev)

```
npm install
npm run dev
```

Tests: `npm test` · Lint: `npm run lint` · Production build: `npm run build`

## Storage modes

**Local.** The default. One localStorage blob per browser profile. Nothing leaves your machine. No connection required, ever.

**Google Drive sync.** Click Connect Google in the toolbar. Uses the `drive.file` scope, so the app can only see the file it creates. Concurrent edits from multiple devices merge convergently; a genuine same-card conflict surfaces as a blocking choice in the UI, never a silent auto-merge.

**MCP.** Point the board at an MCP server (a "spine") in Connection settings: server URL plus Bearer token. The board polls the server and renders its state as the source of truth; Local mode remains available as a fallback if the server is unreachable.

## Bring your own spine (MCP mode)

The board speaks a documented MCP contract: [docs/kanbantt-mcp-spec.md](docs/kanbantt-mcp-spec.md). Any server that conforms can drive the board.

Implementing a server? Start with [docs/BYO-SPINE.md](docs/BYO-SPINE.md): the short list of requirements that make a spec-conformant server actually work from a browser client (CORS, session headers, version tokens), plus how the board reports failures while you debug.

## Token handling

Bearer tokens are held in memory by default and forgotten on reload. "Remember on this device" is opt-in and stores the token in this browser's localStorage. Tokens are only ever sent to the spine URL you configured.
