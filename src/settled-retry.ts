/*
 * Retry a build while a just-settled order is not yet visible.
 *
 * THE FAILURE THIS EXISTS FOR, which really happened on mainnet: a settlement executed, the
 * fill reported success, and the burn was built moments later. The node answering the
 * resolution had not caught up, so the order still carried funds, and `order::burn` aborted
 * with ENotSettled at its funds check — reading a pre-settlement version of the object. The
 * swap had filled and the money had moved; only the cleanup was early.
 *
 * "Executed" and "visible to the next reader" are different claims, and anything acting on a
 * settled order acts on the second one.
 *
 * WHY RETRY RATHER THAN WAIT LONGER UPSTREAM: a wait can only guess how long is enough. The
 * burn is idempotent and re-simulating costs nothing, so retrying is strictly better than
 * failing — and it works regardless of WHY the read lagged, which a fixed delay cannot.
 *
 * WHY MATCH ON THE ERROR NAME: that is the only signal a build failure carries. Treating
 * every failure as retryable would hide real errors behind a delay, which is worse than the
 * race it fixes.
 *
 * `sleep` is injectable so a check can exercise the retry without waiting.
 */

/** The one failure worth waiting out. Anything else is a real error and is rethrown. */
const TOO_EARLY = /ENotSettled|has not been settled/i;

export async function buildWithSettledRetry(
  build: () => Promise<Uint8Array>,
  { attempts = 8, delayMs = 400, sleep }: {
    attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const wait = sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; i <= attempts; i++) {
    try {
      return await build();
    } catch (e) {
      const tooEarly = TOO_EARLY.test(String((e as any)?.message ?? e));
      if (!tooEarly || i === attempts) throw e;
      await wait(delayMs);
    }
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  throw new Error('buildWithSettledRetry exhausted without returning or throwing');
}
