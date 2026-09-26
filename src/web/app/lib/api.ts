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
};

export type SubmitResult = {
  digest?: string;
  status?: string;
  output?: string;
  error?: string;
  events?: Event[];
};

/** Format an integer string of base units as a decimal, without floating point. */
export function units(raw: string | number | undefined, decimals: number): string {
  const s = String(raw ?? '0').padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}
