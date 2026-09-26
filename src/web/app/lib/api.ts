/*
 * The server API, typed.
 *
 * Ported from page.js, and the shape is deliberately identical: the server is unchanged
 * by this migration, so anything that differs here is a porting mistake rather than a
 * design choice.
 *
 * The token rides on the body tag as a data attribute, injected by the server on every
 * page load. It is read once here rather than threaded through components.
 */

/** The pipeline event, as the server emits it. */
export type Event = {
  kind: string;
  /** `model` is advisory, `pipeline` is unconfirmed, `chain` is authoritative. */
  source: 'model' | 'pipeline' | 'chain';
  text: string;
  terminal: boolean;
  data?: Record<string, unknown>;
};

export const TOKEN = document.body.dataset.token ?? '';

/** Every call carries the token. Without it the server answers 403. */
export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body
      ? { 'Content-Type': 'application/json', 'x-agent-token': TOKEN }
      : { 'x-agent-token': TOKEN },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json() as Promise<T>;
}

export type State = {
  vaultSuiMist: string;
  walletSuiMist: string;
  usdc: string;
  cetus: string;
  vaultId: string;
  packageId: string;
};

export type BuildResult = {
  id?: string;
  bytes?: string;
  error?: string;
  refused?: { validation?: { reason?: string } };
  events?: Event[];
  /**
   * The terms of what is about to be signed, as the server describes them.
   *
   * Shape varies by action — an escrow carries `escrowSui`, `minOutUsdc` and `feeOutUsdc`,
   * while a burn carries only `orderId` — so it is read as display pairs rather than a
   * typed struct. Values arrive as strings, already decimal rather than in base units.
   */
  proposal?: Record<string, unknown>;
};

export type SubmitResult = {
  digest?: string;
  status?: string;
  output?: string;
  error?: string;
  events?: Event[];
};

/**
 * Amount formatting lives in src/web/units.js — the same module the CLI scripts use.
 *
 * It used to live here too, which is how the same fee printed as "0.01" in a refusal and
 * "0.010000" in the chat: two implementations, two spellings, one value. Re-exported rather
 * than reimplemented, so there is still one place to change and no second copy to drift.
 */
export { fromUnits } from '../../units';
