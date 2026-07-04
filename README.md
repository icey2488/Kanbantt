# Kanbantt

Local-first kanban board with calendar, timeline, Gantt, and matrix views. All board data lives in the browser; Google Drive JSON sync is available as an opt-in persistence layer. An MCP spine can be connected to use any conforming remote server as the backend instead.

## Views

| View | Description |
|------|-------------|
| Board | Drag-and-drop columns with quick-add and card filtering |
| Calendar | Monthly/weekly/daily layout with due dates |
| Timeline | Rolling agenda |
| Gantt | Duration bars over a scrollable date axis |
| Matrix | Effort × impact quadrant (Do/Schedule/Delegate/Drop) |

## Storage

**Local (default).** Cards, columns, and tags are stored in `localStorage` as a versioned blob (`kanbantt:v1`). No account or server required.

**Google Drive sync.** Sign in with Google from the header. The board blob is stored as a JSON file in your Drive and synced on a configurable interval. Conflict resolution is deterministic and CRDTish (last-write-wins on a per-card basis with a content hash for identical-state fast-path).

## MCP spine (BYO backend)

Open **Settings → Connection** and enter the URL of any MCP server that implements the Kanbantt card contract. The contract is defined in [`docs/kanbantt-mcp-spec.md`](docs/kanbantt-mcp-spec.md) (v0.4.0). Any server speaking that protocol can serve as the backend — the UI has no dependency on a specific implementation.

Capabilities are negotiated at connection time; the UI degrades gracefully when a server advertises a subset (e.g. read-only, no archive support).

## Dev commands

```sh
npm install        # install dependencies
npm run dev        # Vite dev server (http://localhost:5173)
npm test           # Node test runner — src/lib/*.test.js
npm run build      # production build → dist/
npm run lint       # ESLint
npm run preview    # preview the production build locally
```

## Deployment

Deployed on Cloudflare Pages. The `functions/api/auth/exchange.js` Pages Function handles the Google OAuth authorization-code exchange server-side (PKCE, keeps the client secret off the browser). Set the `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` environment variables in the Cloudflare Pages dashboard.

The `public/_headers` file configures the Content Security Policy and security headers; it is copied into the build output as `/_headers` by Vite's `publicDir` passthrough.

Build command: `npm run build`. Output directory: `dist`.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Non-commercial use only. Contact for commercial licensing.
