import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * D1 — WIRE STEP half of the two-step-category split: issued IDENTICALLY
 * against either target kind (mock or real — indistinguishable from here on),
 * ALWAYS diffed. This module imports no spawn/reset logic and receives only an
 * already-live target handle ({ url, fetchFn?, token? }) — a lifecycle action
 * physically cannot happen here, and this is the ONLY module that produces a
 * StepResult ({ status, contentType, body }), the sole shape parity-differ.js
 * accepts. Session (MCP initialize) is opened lazily per target and reused
 * across calls; it is transport plumbing, not itself a diffed wire step.
 */

const sessions = new WeakMap();

/** Wrap a target's fetch so every underlying HTTP round trip is captured (raw
 * status + content-type) without altering the Response the SDK transport
 * itself goes on to parse. */
function capturingFetch(baseFetch, capture) {
  return async (url, init) => {
    const response = await baseFetch(url, init);
    capture.status = response.status;
    capture.contentType = response.headers.get('content-type') || '';
    return response;
  };
}

async function openSession(target) {
  if (sessions.has(target)) return sessions.get(target);
  const capture = {};
  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    ...(target.token ? { requestInit: { headers: { Authorization: `Bearer ${target.token}` } } } : {}),
    fetch: capturingFetch(target.fetchFn || fetch, capture),
  });
  const client = new Client({ name: 'parity-probe', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  const session = { client, capture };
  sessions.set(target, session);
  return session;
}

/** Execute ONE MCP tool call identically against `target` and return a
 * StepResult. `result.isError` collapses onto `{ isError: true, ...meta }` so
 * both the schema-layer shape (no structuredContent at all) and the domain-
 * error shape ({code,message,meta}) survive into the diff untouched — the
 * differ, not this function, decides whether that shape matches the other
 * side. */
export async function sendWireStep(target, toolName, args = {}) {
  const { client, capture } = await openSession(target);
  const result = await client.callTool({ name: toolName, arguments: args });
  return {
    status: capture.status,
    contentType: capture.contentType,
    body: result.isError
      ? { isError: true, ...(result.structuredContent || {}) }
      : (result.structuredContent ?? {}),
  };
}

/** C1 — the manifest half: MCP `tools/list` against `target`, over the wire,
 * via the SAME session `sendWireStep` uses (never a second, divergent
 * connection). Returns the bare sorted tool-name array; the caller (parity-
 * manifest.js) owns everything downstream of "what names did this target
 * advertise". */
export async function listTools(target) {
  const { client } = await openSession(target);
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

export async function closeSession(target) {
  const session = sessions.get(target);
  if (session) {
    await session.client.close();
    sessions.delete(target);
  }
}
