/*
 * The pipeline's event vocabulary.
 *
 * A CLOSED SET, because the chat renders these and a free-text log would drift. The
 * client has to style a guess differently from a confirmed transaction, and it cannot
 * do that from prose.
 *
 * Each event carries a SOURCE, and that is the part that matters:
 *
 *   model     the assistant's words. ADVISORY — a 0.6B model can be wrong.
 *   pipeline  our own progress. Not yet confirmed by anything.
 *   chain     read from the chain. AUTHORITATIVE.
 *
 * The distinction is the whole intent layer in one field: the model proposes, the
 * pipeline reports, the chain decides. A UI that renders all three identically is
 * telling the user that a guess and a settled transaction are the same kind of thing.
 *
 * A failed flow is a TERMINAL kind like any other. With a one-minute window and a
 * self-funding refund, "nobody filled it" is routine rather than exceptional, and
 * wording it as an error would make a working system feel broken.
 */

/** The closed set. Adding one is a deliberate act, not an inline string somewhere. */
export const EVENT_KINDS = [
  'extracting',          // the local model is running
  'proposed',            // the deterministic gate allowed it
  'refused',             // the gate declined it, with a reason
  'building',            // constructing the transaction
  'awaiting-signature',  // the wallet has been asked
  'submitting',          // bytes plus signature, on their way
  'notified',            // the filler has been told about the order
  'filling',             // the filler is working
  'filled',              // settled, and the output has arrived
  'expired',             // the window closed with nobody taking it
  'revoking',            // the server is taking the escrow back
  'revoked',             // the escrow is back with the maker
];

export const SOURCES = ['model', 'pipeline', 'chain'];

/** Kinds after which the flow has stopped and no further event will follow. */
export const TERMINAL_KINDS = ['refused', 'filled', 'expired', 'revoked'];

/**
 * Build one event. Throws on an unknown kind or source rather than emitting something
 * the client will not know how to render — a typo should fail here, not in a browser.
 */
export function event(kind, source, text, data = null) {
  if (!EVENT_KINDS.includes(kind)) throw new Error(`unknown event kind "${kind}"`);
  if (!SOURCES.includes(source)) throw new Error(`unknown event source "${source}"`);
  return { kind, source, text, terminal: TERMINAL_KINDS.includes(kind), ...(data ? { data } : {}) };
}

/**
 * How the states a flow can END in are worded.
 *
 * Kept together and kept neutral on purpose. The failure states are not failures: a
 * short window means an unfilled order is a normal outcome, and the money comes back
 * either way. Words like "failed" or "error" would be wrong about what happened and
 * would train the user to distrust a system that is working.
 */
const ENDING = {
  filled: (d) => `filled — you received ${d.received}`,
  expired: () => 'the window closed before anyone filled it, and your escrow came back',
  // "Revoked", not "refunded". A refund reads as paying someone out; this is the maker taking
  // their own escrow back. The action is called `revoke` everywhere a user sees it, and a
  // terminal message using a different word for the same thing is the drift that makes an
  // interface feel unreliable.
  revoked: () => 'revoked — your escrow is back in your wallet',
  refused: (d) => `refused — ${d.reason}`,
};

/** The wording for a terminal kind, or null if the kind does not end a flow. */
export function endingFor(kind, data = {}) {
  return typeof ENDING[kind] === 'function' ? ENDING[kind](data) : null;
}
