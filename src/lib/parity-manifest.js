/**
 * C1 — MANIFEST UNION. Pure diff logic over two already-fetched tool-name
 * lists (parity-wire-step.js's listTools is the only wire-facing half; this
 * module never itself calls a target). A tool present on one side only is a
 * violation by construction — there is no equivalence class here, ever: the
 * register (parity-register.js) tolerates value-shape divergences on a SHARED
 * tool, never "this tool doesn't exist on one side".
 */

// The reference spine's documented, wire-confirmed advertised tool count
// (spine_server/server.py's own docstring: "Advertises ELEVEN tools"). A
// floor, not a pin: real growing past 11 is fine; dropping BELOW it, or an
// empty/truncated list, must never pass vacuously.
export const REAL_TOOL_COUNT_FLOOR = 11;

/** Never throws. `toolsA`/`toolsB` are the sorted name arrays `listTools`
 * returns. `union` is every name seen on EITHER side; `onlyA`/`onlyB` are the
 * single-side sets that make the union diff RED. `floorOk` is evaluated
 * against `toolsB` (the real side, by this module's calling convention:
 * A = mock, B = real) — a caller diffing two mocks passes `floorTarget`
 * explicitly instead. */
export function diffToolManifest(toolsA, toolsB, { floor = REAL_TOOL_COUNT_FLOOR, floorTarget = 'b' } = {}) {
  const setA = new Set(toolsA);
  const setB = new Set(toolsB);
  const union = [...new Set([...toolsA, ...toolsB])].sort();
  const onlyA = toolsA.filter((t) => !setB.has(t));
  const onlyB = toolsB.filter((t) => !setA.has(t));
  const floorCount = (floorTarget === 'a' ? toolsA : toolsB).length;
  return {
    union,
    onlyA,
    onlyB,
    ok: onlyA.length === 0 && onlyB.length === 0,
    floorOk: floorCount >= floor,
    floorCount,
  };
}
