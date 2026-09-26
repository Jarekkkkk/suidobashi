/*
 * Types for events.js, which stays plain JavaScript because ui.js imports it directly and
 * the server is not (yet) part of the TypeScript program.
 *
 * THIS IS THE FILE THAT WOULD HAVE CAUGHT THE CRASH. A route emitted `event('revoking', …)`
 * after `revoking` was missing from EVENT_KINDS; `event()` threw on the unknown kind, the
 * throw was inside a request handler, and the whole server died. The browser saw only
 * ERR_CONNECTION_REFUSED.
 *
 * With `EventKind` as a union, that is a COMPILE error rather than a runtime one — and the
 * vocabulary stops being a list somebody has to keep in step with the code.
 *
 * The runtime check stays. Types are erased, so a caller that ignores them still gets the
 * throw; this makes the mistake visible earlier, not impossible later.
 */

/** The closed set. Adding one is a deliberate act, not an inline string somewhere. */
export type EventKind =
  | 'extracting'          // the local model is running
  | 'proposed'            // the deterministic gate allowed it
  | 'refused'             // the gate declined it, with a reason
  | 'building'            // constructing the transaction
  | 'awaiting-signature'  // the wallet has been asked
  | 'submitting'          // bytes plus signature, on their way
  | 'notified'            // the filler has been told about the order
  | 'filling'             // the filler is working
  | 'filled'              // settled, and the output has arrived
  | 'expired'             // the window closed with nobody taking it
  | 'revoking'            // the server is taking the escrow back
  | 'revoked';            // the escrow is back with the maker

/** Where an event came from. Advisory, unconfirmed, and authoritative — not the same thing. */
export type EventSource = 'model' | 'pipeline' | 'chain';

export declare const EVENT_KINDS: EventKind[];
export declare const SOURCES: EventSource[];

/** Kinds after which the flow has stopped and no further event will follow. */
export declare const TERMINAL_KINDS: EventKind[];

/**
 * Build one event. Throws on an unknown kind or source rather than emitting something the
 * client will not know how to render — a typo should fail at the source, not in a browser.
 */
export declare function event(
  kind: EventKind,
  source: EventSource,
  text: string,
  data?: Record<string, unknown> | null,
): {
  kind: EventKind;
  source: EventSource;
  text: string;
  terminal: boolean;
  data?: Record<string, unknown>;
};

/**
 * The neutral wording for a flow that has ended, or null for a kind that does not end one.
 *
 * Endings are deliberately not worded as failures: with a one-minute window and a
 * self-funding refund, "nobody filled it" is routine, and calling it an error makes a
 * working system feel broken.
 */
export declare function endingFor(
  kind: EventKind,
  detail?: Record<string, unknown>,
): string | null;
