/*
 * An example operator: the "strategy runner" for flavor (b), one operator serving many guards.
 *
 * This is the decision half, deliberately separated from the submission half. Given one guard's
 * state, the book, and the orders that guard already has open, it returns what to place and what
 * to cancel — and nothing else. It holds no key, builds no transaction, and knows no guard ids.
 * Submission is a loop the caller writes, which is what makes this testable at all: no guard has to
 * exist on chain for the policy to be checked.
 *
 * The policy is a long grid, and it is small on purpose. Keep resting BIDS on the ladder inside the
 * guard's band; cancel any bid that is no longer on the ladder. It re-derives the whole ladder from
 * the book every pass and diffs against what is open, so it is idempotent — running it twice places
 * nothing the second time. A runner that is polled cannot be allowed to accumulate duplicates.
 *
 * What it deliberately does not do: the sell side. A fuller grid places a take-profit above each
 * fill, which means detecting fills — an order that vanished plus a balance that grew — and that is
 * a bigger policy than an example should carry. The guard does not care either way; it takes
 * `sell` exactly as it takes `buy` (see `deepbook_guard::sell`).
 *
 * Nothing here is the enforcement. The guard on chain re-checks the band, the per-order bound, the
 * budget and the pause, so a runner that is wrong loses its own money in ways it agreed to, not
 * anyone else's.
 */
import { gridLevels, refusalFor, type GridLevel } from './deepbook.js';

/** A guard, as its accessors report it. Nothing secret: this is all public chain state. */
export type GuardView = {
  guardId: string;
  maker: string;
  agent: string;
  paused: boolean;
  priceMin: bigint;
  priceMax: bigint;
  maxQty: bigint;
  budget: bigint;
  committed: bigint;
};

export type BookView = {
  bestBid: bigint;
  bestAsk: bigint;
  tick: bigint;
};

/** One resting order, as DeepBook reports the account's open orders. */
export type OpenOrder = {
  orderId: bigint;
  price: bigint;
  isBid: boolean;
};

export type Plan = {
  /** Bids to place, ascending. Empty when nothing is needed — including when the plan was refused. */
  place: GridLevel[];
  /** Order ids to cancel, because they are no longer on the ladder. */
  cancel: bigint[];
  /** Why nothing is planned, when nothing is. `null` when the runner is live on this guard. */
  refused: string | null;
};

/** A plan that does nothing, for the several ways a runner should stand down. */
function stoodDown(reason: string, cancel: bigint[] = []): Plan {
  return { place: [], cancel, refused: reason };
}

/**
 * Work out one pass over one guard.
 *
 * `operator` is the address the runner signs as. A guard whose `agent` is somebody else is not
 * this runner's business, and the check is here rather than left to the chain because a managed
 * operator polls many guards and needs to skip the ones it does not hold cheaply.
 */
export function planGrid(opts: {
  guard: GuardView;
  book: BookView;
  open: OpenOrder[];
  operator: string;
  levels: number;
  quantity: bigint;
}): Plan {
  const { guard, book, open, operator, levels, quantity } = opts;

  if (guard.paused) return stoodDown('the guard is paused, so nothing may be quoted');
  if (guard.agent.toLowerCase() !== operator.toLowerCase()) {
    return stoodDown('this runner does not hold the seat on this guard');
  }

  // A bid at or above the best ask crosses, and a crossing order pays taker fees and can fill
  // immediately at a price the grid did not choose. Capping the ladder at the best BID — never the
  // ask — is what keeps every level a maker order. The band can still be wider; the market decides
  // which part of it is quotable right now.
  const ceiling = min(guard.priceMax, book.bestBid);
  if (ceiling < guard.priceMin) {
    return stoodDown('the market is below the band, so no level in it can rest');
  }

  const desired = gridLevels({
    lower: guard.priceMin,
    upper: ceiling,
    levels,
    tick: book.tick,
    quantity,
  });

  // The chain's budget counts everything the agent has ever asked for, so what is left to spend is
  // the difference. Refusing here means the runner stops before the chain does.
  const remaining = guard.budget > guard.committed ? guard.budget - guard.committed : 0n;
  const refusal = refusalFor(desired, {
    priceMin: guard.priceMin,
    priceMax: guard.priceMax,
    maxQty: guard.maxQty,
    budget: remaining,
  });
  // Orders already open are still cancelled when a fresh ladder is refused — a ladder that cannot
  // be placed is a reason to stand down, not a reason to leave stale quotes resting.
  if (refusal !== null) {
    return stoodDown(refusal, bidsOffTheLadder(open, []));
  }

  const onLadder = new Set(desired.map((l) => String(l.price)));
  const cancel = bidsOffTheLadder(open, desired);
  // Placing only what is missing is what makes a pass idempotent. A price that already has a bid is
  // left alone — including one the runner itself placed a minute ago.
  const place = desired.filter((l) => !open.some((o) => o.isBid && o.price === l.price));

  return { place, cancel, refused: null };
}

/**
 * Bids to cancel: everything resting that is not a ladder price.
 *
 * Sells are left alone, deliberately. The example runner never places one, so any sell that exists
 * belongs to somebody else's decision — the maker unwinding by hand, say — and cancelling it would
 * be this runner reaching outside its brief.
 */
function bidsOffTheLadder(open: OpenOrder[], desired: GridLevel[]): bigint[] {
  const onLadder = new Set(desired.map((l) => String(l.price)));
  return open.flatMap((o) => (o.isBid && !onLadder.has(String(o.price)) ? [o.orderId] : []));
}

/** BigInt comparison, because `Math.min` is typed for numbers and these are raw integers. */
function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
