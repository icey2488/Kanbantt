## PURPOSE
Extend the failureTruth snap-back convergence core to the save/update, retier, and archive mutation paths. Move and delete already converge; do not alter their behavior except where the shared core forces it.

## PRECONDITION GATES (all must hold; violation = STOP-AND-REPORT)
- git status --short: clean or pre-existing-untracked only (app-feature.patch untracked is expected noise; leave it). Other tracked changes present: STOP.
- git log contains "docs: real README + BYO-SPINE implementer field guide" AND 002664f is an ancestor of HEAD. Absent: STOP and report.

## CONTEXT (verify, don't assume)
- Optimistic mutation state lives in App.jsx handlers; the provider layer is a stateless RPC client.
- Move and delete handlers already: capture pre-action state, apply optimistically, on conflict spread the server's returned card over local state.
- Save/update, retier, and archive handlers lack conflict convergence. Verify exact handler names in App.jsx; if a named mutation doesn't exist as an MCP path, report what actually exists instead of inventing.
- The provider remaps wire conflict payload meta.card -> meta.current around src/lib/spine-mcp-provider.js:116-121. Verify this remap covers ALL mutating tools' conflict errors; if it is move/delete-specific, generalize it.

## DESIGN RULES (treat as fixed input to this job)
R1. On conflict, converge unconditionally to the server's entity from the conflict payload. Never restore captured pre-action coordinates on a conflict; the server's current state wins: column_id, order, all fields, and the opaque version token, adopted verbatim. Clients never mint or parse tokens.
R2. Capture-based rollback remains CORRECT and REQUIRED for transport/unknown failures where no server entity is available (network error, timeout, non-conflict tool error). Two failure classes, two recoveries: conflict -> adopt server entity; transport -> rollback to capture. Do not remove the capture mechanism; only ensure it is never used to override server truth on a conflict.
R3. Tombstone routing before adoption: inspect deleted_at on the returned entity. Non-null: remove the card from active board state (converge to the tombstone per the app's existing tombstone/archived rendering rules), adopt its version token. Null: adopt wholesale.
R4. Per-action, non-blocking notices, action named in every notice:
- save/update conflict, live entity: "This card changed elsewhere; your save was undone."
- retier conflict, live entity: "This card changed elsewhere; your retier was undone."
- archive conflict, live entity: "This card changed elsewhere; your archive was undone."
- any of the three, tombstoned entity: "This card was deleted elsewhere; your <action> was cancelled."
- FLAGGED PARITY DECISION (surface in the report either way): archive-on-tombstone may additionally resolve as SUCCESS by parity with the delete-on-tombstone rule (converging on an already-gone target is a successful outcome; no rejected promise, no error-boundary path). Implement as success ONLY if the existing delete-on-tombstone success shape extends cleanly; otherwise leave it cancelled and report.
R5. Never auto-retry a conflicted mutation; never send force. Asserted by ABSENCE in tests.

## TESTS (red-on-violation)
For EACH of save/retier/archive: (a) conflict with live entity -> server adoption, PLUS a red-contrast asserting pre-action capture is NOT restored over server truth; (b) conflict with tombstoned entity -> card leaves active state, version adopted; (c) transport failure -> capture rollback fires; (d) force/auto-retry asserted ABSENT. Full suite green before merge; exact counts before/after; output untruncated, never piped through head.

## SCOPE
Defect-scoped: the three handlers + shared core + provider remap generalization if needed. No API changes to card-store/drive-sync beyond this. No edit-dialog lifecycle changes. Declare any trims.

## GIT
Per the GIT DECISION above: branch, one-purpose commits, PR, self-merge, verify main, push. Never print tokens. NEVER restart spine or bridge.

## DELIVER
Report under 4KB: gate results, handler names found, remap-coverage verdict, the archive-on-tombstone flag, test counts before/after, branch/PR/merge SHAs.
