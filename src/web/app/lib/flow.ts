/*
 * build → sign → submit, in one place.
 *
 * THE SEQUENCE IS THE POINT, not an implementation detail:
 *
 *   build    bytes, held server-side under an id
 *   sign     in the wallet, by the user
 *   submit   the signature paired with THOSE bytes, by id
 *
 * The server never holds a key and the browser never chooses the transaction, so neither side
 * can do the whole thing alone. Any refactor that collapses these into one call has thrown
 * away the property the design exists for.
 *
 * It lives here rather than inside the chat because the left pane's reclaim and revoke need
 * exactly this too, and a second copy would be the fourth time this project has fixed an
 * instance instead of the thing that made copies possible.
 */
import { api, type Event, type BuildResult, type SubmitResult } from './api';
import { wallet } from './wallet';

export type Say = (e: Event) => void;
export type OnTerms = (t: Record<string, unknown> | null) => void;

/**
 * Returns the digest, or null if the build was refused.
 *
 * A refusal is NOT an error: the gate did its job, and it has already said why in an event.
 * A thrown error is reserved for things that went wrong — a declined signature, a dead
 * server — which is why the caller's catch reads as an ending rather than a refusal.
 */
export async function signAndSubmit(
  kind: string,
  body: Record<string, unknown>,
  say: Say,
  onTerms: OnTerms,
): Promise<string | null> {
  const built = await api<BuildResult>('/api/build', { kind, ...body });
  (built.events ?? []).forEach(say);
  // Reported before the signature is requested, so a pane can show what is about to be
  // authorised while there is still a decision to make.
  onTerms(built.proposal ?? null);

  if (built.error || !built.bytes || !built.id) {
    if (!built.events?.length) {
      say({
        kind: 'build',
        source: 'pipeline',
        text: built.error ?? built.refused?.validation?.reason ?? 'could not build it',
        terminal: true,
      });
    }
    return null;
  }

  const w = wallet();
  if (!w) {
    say({ kind: 'wallet', source: 'pipeline', text: 'the wallet has not loaded', terminal: true });
    return null;
  }

  // Emitted because this is the moment the flow waits on a PERSON, and nothing else would
  // mark it: the signing happens inside the extension, outside this app.
  say({
    kind: 'signing',
    source: 'pipeline',
    text: 'waiting for the wallet to sign…',
    terminal: false,
  });

  // The wallet call is wrapped so a failure inside it is ATTRIBUTABLE. An error thrown here
  // carries no context otherwise — "Cannot read properties of undefined (reading 'owner')"
  // says nothing about which step produced it, and the only way to find out was to reason
  // about it. Naming the step, and carrying the first stack frame, makes the next report
  // answer the question instead of prompting another guess.
  let signed;
  try {
    signed = await w.sign(built.bytes);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const frame = (err.stack ?? '').split('\n')[1]?.trim() ?? 'no stack';
    throw new Error(`the wallet refused to sign: ${err.message} — ${frame}`);
  }

  const out = await api<SubmitResult>('/api/submit', { id: built.id, signature: signed.signature });
  (out.events ?? []).forEach(say);
  return out.digest ?? null;
}
