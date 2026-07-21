/**
 * Uniform conflict snap-back — the ONE reconciliation core for a failed
 * optimistic board write in MCP mode (the Pass 2b move/delete paths).
 *
 * Every MCP write follows CAPTURE → OPTIMISTIC → call → RECONCILE / SNAP-BACK.
 * Before this module, the two structural writes reconciled a FAILURE with three
 * different idioms: move spread `meta.current` over the entry (leaving a
 * tombstoned entry in the model on a deleted-card conflict — a shape the polls
 * never produce, since they fetch include_deleted:false), delete branched
 * tombstone/live/transport by hand, and a `not_found` fell through BOTH ops'
 * generic revert — restoring a ghost card the server does not know, which every
 * later write on it can only fail against.
 *
 * The uniform rule: converge on what the failure PROVES about the server.
 *
 *   'stale'   — conflict carrying a LIVE meta.current: the card exists with
 *               fresh state → ADOPT it (merge over the entry, or re-insert over
 *               the captured prior if the optimistic change removed it). Merge,
 *               not replace: client-side annotations the poll composes onto the
 *               model (the escalation badge) survive until the next poll.
 *   'gone'    — conflict carrying a TOMBSTONED meta.current, or not_found: the
 *               card no longer exists server-side → REMOVE it from the model.
 *               Polls never deliver tombstones, so removal IS convergence.
 *   'unknown' — anything else (transport, an in-band domain error with no
 *               current, a schema reject): the write never landed and the
 *               server's truth is unproven → RESTORE the captured prior,
 *               version-guarded: if the entry's version moved while the call
 *               was in flight, a poll delivered fresher truth — leave it.
 *
 * Pure and side-effect free — the board wires it as
 *   setSpineModel((m) => ({ ...m, cards: snapBackCards(m.cards, { id, error, prior }) }))
 * and pairs a known-truth outcome with the same backstop poll a success gets.
 */

/** What a failed write's error PROVES about the card's server-side truth:
 *  'stale' (exists, fresh state under meta.current), 'gone' (tombstoned or
 *  not_found — no longer exists), or 'unknown' (nothing proven; never landed). */
export function failureTruth(error) {
  if (error?.code === 'conflict' && error.meta?.current) {
    return error.meta.current.deleted_at ? 'gone' : 'stale';
  }
  if (error?.code === 'not_found') return 'gone';
  return 'unknown';
}

/**
 * Reconcile a cards array after a failed optimistic write on card `id`.
 *
 * @param {Array<object>} cards  the model's cards (spineModel.cards)
 * @param {object} opts
 * @param {string} opts.id      the card the failed write targeted
 * @param {object} opts.error   the thrown provider error ({ code, meta })
 * @param {object} opts.prior   the FULL model card as captured BEFORE the
 *        optimistic apply — restore source for 'unknown', re-insert base for
 *        'stale'. Must carry the pre-write `version` (the guard's pivot).
 * @returns {Array<object>} the reconciled cards array (new array on change)
 */
export function snapBackCards(cards, { id, error, prior }) {
  const truth = failureTruth(error);
  if (truth === 'gone') return cards.filter((c) => c.id !== id);
  if (truth === 'stale') {
    const current = error.meta.current;
    return cards.some((c) => c.id === id)
      ? cards.map((c) => (c.id === id ? { ...c, ...current } : c))
      : [...cards, { ...prior, ...current }];
  }
  // 'unknown' — restore the captured prior. The optimistic apply never touches
  // `version`, so an entry whose version differs from prior's was refreshed by a
  // mid-flight poll: its truth is newer than the capture — leave it standing.
  const entry = cards.find((c) => c.id === id);
  if (!entry) return [...cards, prior];
  if (entry.version !== prior.version) return cards;
  return cards.map((c) => (c.id === id ? prior : c));
}
