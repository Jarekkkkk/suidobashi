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
  /** Which side the ladder sits on. A bid ladder needs quote funds; an ask ladder needs base. */
  side: 'bid' | 'ask';
  /** Levels to place, ascending. Empty when nothing is needed — including when refused. */
  place: GridLevel[];
  /** Order ids to cancel, because they are no longer on the ladder. */
  cancel: bigint[];
  /** Why nothing is planned, when nothing is. `null` when the runner is live on this guard. */
  refused: string | null;
};

/** A plan that does nothing, for the several ways a runner should stand down. */
function stoodDown(side: 'bid' | 'ask', reason: string, cancel: bigint[] = []): Plan {
  return { side, place: [], cancel, refused: reason };
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
  /**
   * Defaults to a bid ladder. An ask ladder exists because an account holds one side and not the
   * other: DeepBook pays an order out of the BalanceManager, so a bid needs quote funds and an ask
   * needs base. A runner that could only bid cannot act on an account funded in SUI.
   */
  side?: 'bid' | 'ask';
}): Plan {
  const { guard, book, open, operator, levels, quantity } = opts;
  const side = opts.side ?? 'bid';

  if (guard.paused) return stoodDown(side, 'the guard is paused, so nothing may be quoted');
  if (guard.agent.toLowerCase() !== operator.toLowerCase()) {
    return stoodDown(side, 'this runner does not hold the seat on this guard');
  }

  // Never cross, in EITHER direction, and leave a TICK of margin while doing it. A bid must sit
  // below the best ask and an ask above the best bid; capping at the same side's own best price is
  // what guarantees that. The margin is because a level2 read and the placement are two different
  // moments: the market moved between them on the first live ladder, and a POST_ONLY order that
  // crosses ABORTS — `order_info::assert_execution`, code 5, EPOSTOrderCrossesOrderbook — rather
  // than clamping. Move has no try/catch, so a runner that prices exactly at the touch dies on a
  // tick. One tick of room costs a slightly worse fill and removes that failure entirely.
  // TEN ticks of margin on an ask, not one. One tick was tried live and the order crossed anyway:
  // the level-2 read and the placement are about a second apart, and SUI/USDC moves further than
  // 0.00001 USDC in that second. A wider margin costs a slightly worse fill; a narrow one costs a
  // failed transaction that reads like a bug. The bid side still sits AT the touch because the
  // assertions pin it there — a known asymmetry, and the next live failure will say if it matters.
  const floor = side === 'bid'
    ? guard.priceMin
    : max(guard.priceMin, book.bestAsk + 10n * book.tick);
  const ceiling = side === 'bid'
    ? min(guard.priceMax, book.bestBid)
    : guard.priceMax;
  if (ceiling < floor) {
    return stoodDown(
      side,
      side === 'bid'
        ? 'the market is below the band, so no level in it can rest'
        : 'the market is above the band, so no level in it can rest',
    );
  }

  const desired = gridLevels({
    lower: floor,
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
    return stoodDown(side, refusal, ordersOffTheLadder(open, [], side));
  }

  const cancel = ordersOffTheLadder(open, desired, side);
  // Placing only what is missing is what makes a pass idempotent. A price that already has an order
  // is left alone — including one the runner itself placed a minute ago.
  const place = desired.filter((l) => !open.some((o) => o.price === l.price));

  return { side, place, cancel, refused: null };
}

/**
 * Orders to cancel: everything resting on this plan's side that is not a ladder price.
 *
 * The other side is left alone, deliberately. A bid ladder never places asks, so an ask that exists
 * belongs to somebody else's decision — a maker unwinding by hand, say — and cancelling it would be
 * this runner reaching outside its brief.
 *
 * NOTE the reader's limit: `src/run-grid.ts` reads open orders WITHOUT their side, so it marks them
 * all as bids. A bid ladder therefore cancels correctly, and an ask ladder cannot yet tell its own
 * orders from a bid's. Reading each order's side and price is the fix, and it is not written.
 */
function ordersOffTheLadder(open: OpenOrder[], desired: GridLevel[], side: 'bid' | 'ask'): bigint[] {
  const onLadder = new Set(desired.map((l) => String(l.price)));
  const mine = side === 'bid';
  return open.flatMap((o) => (o.isBid === mine && !onLadder.has(String(o.price)) ? [o.orderId] : []));
}

/** BigInt comparison, because `Math.min` is typed for numbers and these are raw integers. */
function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
