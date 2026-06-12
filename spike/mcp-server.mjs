/* ============================================================
   DISPOSABLE MCP SPIKE SERVER  — delete with the rest of spike/
   ------------------------------------------------------------
   Minimal Model Context Protocol server over the Streamable HTTP
   transport, listening on localhost:3001 at POST/GET/DELETE /mcp.
   Exposes one tool, `card_list`, returning a hardcoded list of
   cards as structured content.

   NOT production code: no auth, in-memory session map, and CORS is
   opened wide to the Vite dev origin so the browser client spike
   can reach it. Touches nothing in src/.
   ============================================================ */
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const PORT = 3001;
const ORIGIN = 'http://localhost:5173'; // Vite dev server

// Hardcoded payload. structuredContent must be a JSON *object* at the top
// level per the MCP spec, so the array of cards lives under `cards`.
const CARDS = [
  { id: 'card-1', title: 'Wire up the MCP spike', column_id: 'doing' },
  { id: 'card-2', title: 'Render structured content', column_id: 'todo' },
];

function buildServer() {
  const server = new McpServer({ name: 'kanbantt-spike', version: '0.0.0' });
  server.registerTool(
    'card_list',
    {
      title: 'List cards',
      description: 'Returns a hardcoded list of board cards.',
      inputSchema: {}, // no required input
      outputSchema: {
        cards: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            column_id: z.string(),
          }),
        ),
      },
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ cards: CARDS }, null, 2) }],
      structuredContent: { cards: CARDS },
    }),
  );
  return server;
}

const app = express();

// CORS for the browser client. The Streamable HTTP browser transport sends
// `mcp-session-id` on every request after initialize and reads it back off the
// initialize response, so it must be both allowed (request) and exposed
// (response). `mcp-protocol-version`, `Accept`, and `Last-Event-ID` are also
// sent by the transport and trip preflight, so they are allowed too.
app.use(
  cors({
    origin: ORIGIN,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'mcp-session-id', 'mcp-protocol-version', 'Accept', 'Last-Event-ID'],
    exposedHeaders: ['mcp-session-id'],
  }),
);
app.use(express.json());

// Stateful sessions: sessionId -> transport. In-memory, dies with the process.
const transports = {};

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    await buildServer().connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: no valid session ID' },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// GET = server->client SSE notification stream; DELETE = terminate session.
const handleSessionRequest = async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await transports[sessionId].handleRequest(req, res);
};
app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[mcp-spike] listening on http://localhost:${PORT}/mcp (CORS origin ${ORIGIN})`);
});
