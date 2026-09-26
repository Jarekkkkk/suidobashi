/*
 * DeepBook v3, for `deepbook_guard`.
 *
 * Three things live here: the DeepBook constants this project pins to, the arithmetic that turns a
 * human grid into the integers DeepBook wants, and the checks that refuse a grid before the chain
 * does. The Move side is `move/sources/deepbook_guard.move`; this is the caller's half.
 *
 * What is deliberately NOT here: the order paths (`buy`/`sell`/`cancel`). They call into our guard
 * module, and that module is not published yet — builders for it would be dead code that cannot be
 * run even once. They belong in the same change as the publish. What IS here runs today: creating
 * the BalanceManager and its three capabilities touches only DeepBook's published package.
 *
 * Units are the trap in this file. DeepBook takes integers, so every human price and quantity has
 * to be scaled, and the scale is where a thousandfold error hides. See `priceScale` for what was
 * measured off the live pool and `quantityScale` for what could not be.
 */
import { Transaction } from '@mysten/sui/transactions';

/** DeepBook v3, version 8 — the version live on mainnet. */
export const DEEPBOOK_PACKAGE =
  '0x0e735f8c93a95722efd73521aca7a7652c0bb71ed1daf41b26dfd7d1ff71f748';

/**
 * The mainnet SUI/USDC book.
 *
 * `Pool<SUI, USDC>` — base SUI, quote USDC. Note this is the OPPOSITE order from this project's
 * Cetus pool, which is `Pool<USDC, SUI>`; reusing `POOL_TYPE_ARGS` from `addresses.ts` would name
 * the wrong pool and abort. A `buy` here spends USDC to acquire SUI, i.e. `is_bid = true`.
 */
export const DEEPBOOK_POOL_ID =
  '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';

/** The clock, for every call that needs a timestamp. */
export const CLOCK_ID = '0x6';

/** DeepBook's order types. A resting grid wants one of the two that can rest. */
export const ORDER_TYPE = {
  NO_RESTRICTION: 0,
  IMMEDIATE_OR_CANCEL: 1,
  FILL_OR_KILL: 2,
  POST_ONLY: 3,
} as const;

/**
 * DeepBook's fixed-point scale. Prices and quantities are integers, normalised against this.
 */
export const FLOAT_SCALING_EXP = 9;

/**
 * This pool's tick size, in raw price units. Measured, not assumed: a live level-2 read returns
 * bid levels 1_159_960 / 1_159_530 / 1_159_500 / 1_159_320 / 1_159_200, whose gaps (430, 30, 180,
 * 120) are all multiples of 10, and the contract table lists 0.00001 for SUI/USDC — which is 10 at
 * this pool's 1e6 price scale. Checked against the chain by `src/verify-deepbook.js` on every run.
 */
export const DEEPBOOK_TICK_SIZE = 10n;

/**
 * Price is quote-per-base, normalised to an integer:
 *
 *     price_raw = price_human * 10^(quoteDecimals - baseDecimals + 9)
 *
 * For SUI/USDC that is 10^(6 - 9 + 9) = 1e6, and one measurement on mainnet agrees rather than
 * merely not contradicting it: a live `get_level2_ticks_from_mid` read returns a best bid of
 * 1_159_960 and a best ask of 1_160_080, which is 1.16 USDC per SUI — the price of SUI — with a
 * 12-unit spread and gaps between levels that are all multiples of 10.
 *
 * So for this pool: price scale 1e6, and tick size 10 raw, which is the 0.00001 the contract table
 * lists. `scripts/verify-deepbook.js` re-checks both against the chain on every run, because a
 * scale that drifts silently is exactly the failure this comment cannot prevent.
 */
export function priceScale(baseDecimals: number, quoteDecimals: number): bigint {
  return 10n ** BigInt(quoteDecimals - baseDecimals + FLOAT_SCALING_EXP);
}

/**
 * Quantity, in base-asset units:
 *
 *     quantity_raw = quantity_human * 10^baseDecimals
 *
 * NOT VERIFIED, and said plainly rather than buried: a live level-2 read returns per-level
 * quantities that are NOT multiples of this pool's documented lot size (0.1 SUI) under this scale,
 * nor under any other scale tried. The two readings cannot both be right, and which one is wrong
 * is not knowable from a read-only query.
 *
 * So: do not place a real order whose size depends on this function until one real order has
 * settled the question. The evidence and the open question are in NOTES.md. The grid arithmetic
 * below does not care — it works in raw integers and takes the scale as an argument.
 */
export function quantityScale(baseDecimals: number): bigint {
  return 10n ** BigInt(baseDecimals);
}

/** A grid level, in the pool's own raw integers. */
export type GridLevel = { price: bigint; quantity: bigint };

/**
 * Prices for a ladder inside a band, ascending, each a whole number of ticks.
 *
 * The band is the maker's, the tick is the pool's, and the result is what the agent may quote —
 * the guard on chain re-checks every level against the band anyway, so this is convenience and a
 * readable refusal rather than the enforcement.
 *
 * A band too narrow to hold `levels` whole ticks returns FEWER levels rather than duplicate prices:
 * two orders at one price is not a ladder, and DeepBook would treat them as one level. Silent
 * truncation would be the wrong call here, so callers can compare `.length` against what they
 * asked for.
 */
export function gridLevels(opts: {
  lower: bigint;
  upper: bigint;
  levels: number;
  tick: bigint;
  quantity: bigint;
}): GridLevel[] {
  const { lower, upper, levels, tick, quantity } = opts;
  if (levels < 1) throw new Error('a grid needs at least one level');
  if (tick <= 0n) throw new Error('tick size must be positive');
  if (upper < lower) throw new Error('grid band is inverted');

  // Snap the band inward to whole ticks, so every level is quotable.
  const low = ceilTo(lower, tick);
  const high = floorTo(upper, tick);
  if (high < low) return [];

  const span = high - low;
  // One level sits at the band edge; the rest are spaced across it, at least one tick apart.
  const rawStep = levels === 1 ? 0n : span / BigInt(levels - 1);
  const step = rawStep < tick ? tick : floorTo(rawStep, tick);

  const out: GridLevel[] = [];
  let seen = -1n;
  for (let i = 0; i < levels; i++) {
    const price = low + step * BigInt(i);
    if (price > high) break;
    if (price === seen) continue;
    seen = price;
    out.push({ price: floorTo(price, tick), quantity });
  }
  return out;
}

/**
 * The maker's limits, as the guard holds them. Used to refuse a grid here rather than have the
 * chain refuse it, and each check names the Move assert it mirrors so the two cannot drift apart
 * without the name giving it away.
 */
export type GuardLimits = {
  priceMin: bigint;
  priceMax: bigint;
  maxQty: bigint;
  budget: bigint;
};

/** `null` when the grid is acceptable, otherwise the reason, in the maker's terms. */
export function refusalFor(levels: GridLevel[], limits: GuardLimits): string | null {
  if (levels.length === 0) return 'the band holds no whole ticks, so there is nothing to quote';

  const total = levels.reduce((sum, l) => sum + l.quantity, 0n);
  const outOfBand = levels.filter((l) => l.price < limits.priceMin || l.price > limits.priceMax);
  if (outOfBand.length > 0) {
    // deepbook_guard::EPriceOutOfBand
    return `${outOfBand.length} level(s) sit outside the guard's band`;
  }

  const tooBig = levels.filter((l) => l.quantity > limits.maxQty);
  if (tooBig.length > 0) {
    // deepbook_guard::EQuantityAboveBound
    return `${tooBig.length} level(s) ask for more than the per-order bound`;
  }

  if (total > limits.budget) {
    // deepbook_guard::EBudgetExceeded. The budget counts what the agent ASKS FOR and is never
    // refunded, so a ladder is charged once, whole — not per fill.
    return `the ladder totals ${total} against a budget of ${limits.budget}`;
  }

  return null;
}

function floorTo(value: bigint, step: bigint): bigint {
  return value - (value % step);
}

function ceilTo(value: bigint, step: bigint): bigint {
  const rem = value % step;
  return rem === 0n ? value : value + (step - rem);
}

/**
 * Create a BalanceManager and one of each capability, all owned by `owner`.
 *
 * Touches only DeepBook's published package, so this runs today — no publish needed. The maker
 * keeps the BalanceManager owned here; `deepbook_guard::create` takes it by value and shares it,
 * which is the moment it becomes referenceable by the agent's transaction.
 *
 * `new` is used rather than `new_with_custom_owner_caps_v2`: the latter also needs the DeepBook
 * registry object and an `App` witness type, for capabilities this does not want.
 */
export function buildCreateAccount(owner: string): {
  tx: Transaction;
  balanceManager: () => ReturnType<Transaction['moveCall']>;
  tradeCap: () => ReturnType<Transaction['moveCall']>;
} {
  const tx = new Transaction();
  const target = (fn: string) => `${DEEPBOOK_PACKAGE}::balance_manager::${fn}`;

  const balanceManager = tx.moveCall({ target: target('new'), arguments: [] });
  const tradeCap = tx.moveCall({ target: target('mint_trade_cap'), arguments: [balanceManager] });

  tx.transferObjects([balanceManager], owner);
  tx.transferObjects([tradeCap], owner);

  return {
    tx,
    balanceManager: () => balanceManager,
    tradeCap: () => tradeCap,
  };
}
