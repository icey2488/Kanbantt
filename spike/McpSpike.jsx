/* ============================================================
   DISPOSABLE MCP SPIKE UI  — delete with the rest of spike/
   ------------------------------------------------------------
   Throwaway component: a Connect button that drives the SDK's
   browser client over the Streamable HTTP transport against the
   spike server (spike/mcp-server.mjs), then dumps the raw JSON of
   tools/list and card_list. Mounted from src/App.jsx behind
   ?spike=1. Pulls in nothing from the real app.
   ============================================================ */
import { useState } from 'react';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const SERVER_URL = 'http://localhost:3001/mcp';

export default function McpSpike() {
  const [status, setStatus] = useState('idle');
  const [toolsResult, setToolsResult] = useState(null);
  const [cardListResult, setCardListResult] = useState(null);
  const [error, setError] = useState(null);

  const connect = async () => {
    setStatus('connecting');
    setError(null);
    setToolsResult(null);
    setCardListResult(null);
    try {
      const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL));
      const client = new Client({ name: 'kanbantt-spike-client', version: '0.0.0' });

      await client.connect(transport); // performs the initialize handshake

      setStatus('tools/list');
      const tools = await client.listTools();
      setToolsResult(tools);

      setStatus('tools/call card_list');
      const cards = await client.callTool({ name: 'card_list', arguments: {} });
      setCardListResult(cards);

      setStatus('done');
    } catch (e) {
      setError(String(e?.stack || e?.message || e));
      setStatus('error');
    }
  };

  const pre = {
    background: '#0a101c',
    color: '#e4e9f2',
    border: '1px solid #1f2a3d',
    borderRadius: 8,
    padding: 16,
    fontSize: 12,
    fontFamily: 'ui-monospace, monospace',
    overflow: 'auto',
    margin: 0,
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#070b14',
        color: '#e4e9f2',
        fontFamily: 'ui-monospace, monospace',
        padding: '40px 32px',
        maxWidth: 920,
        margin: '0 auto',
      }}
    >
      <h1 style={{ fontSize: 20, marginTop: 0 }}>MCP Streamable HTTP spike</h1>
      <p style={{ color: '#8b95a8', fontSize: 13 }}>
        Browser client → <code>{SERVER_URL}</code>. Run <code>npm run spike:server</code> first.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0' }}>
        <button
          onClick={connect}
          disabled={status === 'connecting'}
          style={{
            background: '#7dd3fc',
            color: '#070b14',
            border: 'none',
            borderRadius: 8,
            padding: '10px 18px',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Connect
        </button>
        <span style={{ color: '#8b95a8', fontSize: 13 }}>status: {status}</span>
      </div>

      {error && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, color: '#fb7185' }}>error</h2>
          <pre style={{ ...pre, borderColor: '#fb7185' }}>{error}</pre>
        </div>
      )}

      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, color: '#7dd3fc' }}>tools/list</h2>
        <pre style={pre}>{toolsResult ? JSON.stringify(toolsResult, null, 2) : '—'}</pre>
      </div>

      <div>
        <h2 style={{ fontSize: 14, color: '#6ee7b7' }}>card_list</h2>
        <pre style={pre}>{cardListResult ? JSON.stringify(cardListResult, null, 2) : '—'}</pre>
      </div>
    </div>
  );
}
