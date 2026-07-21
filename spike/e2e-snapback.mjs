/**
 * E2E: uniform conflict snap-back against a REAL dev spine instance.
 *
 * Proves the three failure-truth classes AS THE REAL SPINE EMITS THEM — stale
 * (conflict + live meta.card), gone (conflict + tombstone / not_found), and the
 * provider's remap of each — feed snapBackCards (src/lib/spine-snapback.js) to
 * convergence with the server's own card_list truth. The in-process harness
 * proves the same classes against the CONFORMING mock; this proves them against
 * the FastMCP/pydantic wire.
 *
 * DEV-ONLY BY CONSTRUCTION: refuses the live service (spine.icehunter.net /
 * the live :8848 default). Run a scratch instance, e.g.:
 *
 *   CLAUNKER_SPINE_TOKEN=e2e CLAUNKER_SPINE_DB=C:\tmp\snapback-e2e\spine.db \
 *   CLAUNKER_SPINE_PORT=8899 python -m spine_server.server
 *
 * with one seeded project (spine.Spine.create_project), then:
 *
 *   SPINE_E2E_URL=http://127.0.0.1:8899/mcp SPINE_E2E_TOKEN=e2e node spike/e2e-snapback.mjs
 */
import { randomUUID } from 'node:crypto';

import { createMCPProvider } from '../src/lib/spine-mcp-provider.js';
import { snapBackCards, failureTruth } from '../src/lib/spine-snapback.js';

const url = process.env.SPINE_E2E_URL;
const token = process.env.SPINE_E2E_TOKEN;
if (!url || !token) {
  console.error('SPINE_E2E_URL and SPINE_E2E_TOKEN are required (a DEV spine, never the live service).');
  process.exit(2);
}
if (/icehunter\.net|:8848\b/.test(url)) {
  console.error(`REFUSED: ${url} looks like the LIVE spine. Point SPINE_E2E_URL at a scratch dev instance.`);
  process.exit(2);
}

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures += 1;
};
const expectThrow = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

const provider = createMCPProvider({ baseUrl: url, authToken: token, name: 'snapback-e2e' });
await provider.connect();
const caps = provider.getCapabilities();
console.log(`connected: ${caps.server.name} (schema ${caps.server.schema_version})`);

const projects = await provider.projectList();
check('a seeded project exists to target', projects.length >= 1);
const projectId = projects[0].id;

const serverCard = async (id) =>
  (await provider.list({ includeDeleted: false })).cards.find((c) => c.id === id) || null;
const mkCard = async (title) => {
  const id = randomUUID();
  return provider.cardCreate({ id, title, column_id: 'created', order: 'm' }, { project_id: projectId });
};

/* ── stale MOVE: another writer bumped the version first ─────────────────── */
{
  const a = await mkCard('snapback-e2e stale-move');
  await provider.cardUpdate(a.id, { title: 'renamed by another client', expected_version: a.version });
  const model = [{ ...a, column_id: 'tiered' }]; // our doomed optimistic move
  const e = await expectThrow(() => provider.cardMove(a.id, 'tiered', { order: 'x', expected_version: a.version }));
  check('stale move throws conflict', e?.code === 'conflict', String(e?.code || e));
  check('stale move classifies stale', failureTruth(e) === 'stale');
  const out = snapBackCards(model, { id: a.id, error: e, prior: a });
  const truth = await serverCard(a.id);
  const c = out.find((x) => x.id === a.id);
  check('snap-back adopted the server card', !!c && c.title === 'renamed by another client' && c.version === truth.version);
  check('snap-back kept the server position, not the optimistic one', c?.column_id === truth.column_id);
}

/* ── gone MOVE: the target was deleted under our feet ────────────────────── */
{
  const b = await mkCard('snapback-e2e gone-move');
  await provider.cardDelete(b.id, { expected_version: b.version });
  const model = [{ ...b, column_id: 'tiered' }];
  const e = await expectThrow(() => provider.cardMove(b.id, 'tiered', { order: 'x', expected_version: b.version }));
  check('move of a tombstoned card throws conflict', e?.code === 'conflict', String(e?.code || e));
  check('meta.current carries the tombstone', !!e?.meta?.current?.deleted_at);
  check('gone-move classifies gone', failureTruth(e) === 'gone');
  check('snap-back dropped the card', snapBackCards(model, { id: b.id, error: e, prior: b }).length === 0);

  /* gone DELETE on the same tombstone: stays removed, never resurrected */
  const e2 = await expectThrow(() => provider.cardDelete(b.id, { expected_version: b.version }));
  check('delete of a tombstoned card throws conflict/gone', e2?.code === 'conflict' && failureTruth(e2) === 'gone', String(e2?.code || e2));
  check('snap-back leaves it removed', snapBackCards([], { id: b.id, error: e2, prior: b }).length === 0);
}

/* ── not_found on BOTH ops: a card the server never knew ─────────────────── */
{
  const ghost = { id: randomUUID(), title: 'ghost', column_id: 'created', order: 'm', version: '1:0' };
  const em = await expectThrow(() => provider.cardMove(ghost.id, 'tiered', { order: 'x', expected_version: ghost.version }));
  check('move of an unknown id throws not_found', em?.code === 'not_found', String(em?.code || em));
  check('not_found move classifies gone; ghost dropped', failureTruth(em) === 'gone' && snapBackCards([ghost], { id: ghost.id, error: em, prior: ghost }).length === 0);
  const ed = await expectThrow(() => provider.cardDelete(ghost.id, { expected_version: ghost.version }));
  check('delete of an unknown id throws not_found', ed?.code === 'not_found', String(ed?.code || ed));
  check('not_found delete stays removed', snapBackCards([], { id: ghost.id, error: ed, prior: ghost }).length === 0);
}

/* ── stale DELETE: the card lives on with fresh state → re-insert it ─────── */
{
  const c = await mkCard('snapback-e2e stale-delete');
  await provider.cardUpdate(c.id, { title: 'still alive', expected_version: c.version });
  const e = await expectThrow(() => provider.cardDelete(c.id, { expected_version: c.version }));
  check('stale delete throws conflict/stale', e?.code === 'conflict' && failureTruth(e) === 'stale', String(e?.code || e));
  const out = snapBackCards([], { id: c.id, error: e, prior: c }); // model after optimistic removal
  const truth = await serverCard(c.id);
  const re = out.find((x) => x.id === c.id);
  check('snap-back re-inserted the SERVER card', !!re && re.title === 'still alive' && re.version === truth.version);
}

await provider.disconnect();
console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failures} E2E CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
