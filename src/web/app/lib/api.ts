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

/**
 * Every call carries the token. Without it the server answers 403.
 *
 * The method is explicit for anything that is not a read or a create: `body ? 'POST' : 'GET'`
 * cannot express PATCH or DELETE, and both of those take no body — so inferring from one would
 * send the wrong verb for a request that looked perfectly reasonable at the call site.
 */
export async function api<T = unknown>(
  path: string,
  body?: unknown,
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE',
): Promise<T> {
  const res = await fetch(path, {
    method: method ?? (body ? 'POST' : 'GET'),
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
 * The operator listing: what a maker can point a guard at, and whether they can yet.
 *
 * A typed mirror of the server's `src/strategies.ts`, which is the same treatment `State` and
 * `BuildResult` get — the app depends on the API's shape, not on the server's modules.
 *
 * `blocked` is the server's reason to offer nothing, and it is data rather than a message the pane
 * decides on: the same field goes null when the guard module is published, so the page starts
 * offering the action without a UI change.
 */
export type StrategyListing = {
  strategies: Array<{
    id: string;
    name: string;
    /** The address the operator signs as. Printed in full, because it is meant to be checked. */
    operator: string;
    summary: string;
    bandUsdc: { low: number; high: number };
    levels: number;
    perLevelSui: number;
    budgetSui: number;
    everySeconds: number;
    /** What it will not do. The edge a maker is actually deciding about. */
    willNot: string;
  }>;
  guardPackageId: string | null;
  blocked: string | null;
};

/**
 * Amount formatting lives in src/web/units.js — the same module the CLI scripts use.
 *
 * It used to live here too, which is how the same fee printed as "0.01" in a refusal and
 * "0.010000" in the chat: two implementations, two spellings, one value. Re-exported rather
 * than reimplemented, so there is still one place to change and no second copy to drift.
 */
export { fromUnits } from '../../units';
