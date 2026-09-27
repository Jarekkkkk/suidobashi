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
import type { TransactionObjectArgument } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { DEEPBOOK_GUARD_PACKAGE, SUI_TYPE, USDC_TYPE } from './addresses.js';

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

/**
 * The guard's type arguments for this pool: `[Base, Quote]`.
 *
 * NOT `POOL_TYPE_ARGS` from `addresses.ts`. That one is `[USDC, SUI]` for this project's Cetus
 * pool, which is the OPPOSITE order — and `Pool<USDC, SUI>` is a different type from
 * `Pool<SUI, USDC>`, so a reused constant would not compile against the right pool, it would name
 * the wrong one. Spelled out rather than derived, so the difference is visible where it matters.
 */
export const DEEPBOOK_POOL_TYPE_ARGS = [SUI_TYPE, USDC_TYPE] as const;

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
 * VERIFIED on mainnet, by refusal rather than by a successful order: a probe simulated sell
 * quantities through the guard and bracketed DeepBook's own checks. Below 0.8 SUI it aborts
 * `EOrderBelowMinimumSize` (code 1); at 1 SUI and above it passes input validation and fails only on
 * the account's balance. Since these are base-asset units, that boundary IS 1 SUI — the pool's
 * minimum order — and no other scale puts a round minimum there. The same run bracketed the minimum
 * to between 0.8 and 1 SUI, which is the number a deposit has to clear.
 *
 * What was misleading, and why this file used to say UNVERIFIED: a live level-2 READ returns
 * per-level quantities that are not multiples of the pool's documented 0.1 SUI lot under this scale.
 * That is a question about what a read reports, not about what an order means, and the two are not
 * the same number. An order's quantity is raw base units; the level-2 figures are something else.
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
 * Add a BalanceManager and the one capability a guard needs to `tx`, and return both.
 *
 * NOTHING IS TRANSFERRED, and that is the point: the caller composes this with `createGuardTx` in
 * the SAME transaction. Sui refuses to share an object that an earlier transaction created, and
 * `create` shares the BalanceManager — so an account and its guard are born together or not at all.
 * There is no "create the account now, guard it later": simulated on mainnet, that second
 * transaction aborts inside `transfer::share_object_impl`, and it does so even when the share is
 * Sui's own `public_share_object` with none of this code in the path.
 *
 * The sender becomes the owner and stays the owner — DeepBook has no function that changes one.
 * Only a trade capability is minted: a deposit or withdraw capability would be dead, because
 * DeepBook's owner paths for those take no capability at all.
 *
 * `new` is used rather than `new_with_custom_owner_caps_v2`: the latter also needs the DeepBook
 * registry object and an `App` witness type, for capabilities this does not want.
 */
export function createAccountTx(tx: Transaction): {
  balanceManager: TransactionObjectArgument;
  tradeCap: TransactionObjectArgument;
} {
  const target = (fn: string) => `${DEEPBOOK_PACKAGE}::balance_manager::${fn}`;
  const balanceManager = tx.moveCall({ target: target('new'), arguments: [] });
  const tradeCap = tx.moveCall({ target: target('mint_trade_cap'), arguments: [balanceManager] });
  return { balanceManager, tradeCap };
}

/**
 * An owned object argument: an id for the client to resolve, or a reference to something created
 * earlier in this same transaction.
 *
 * Both are needed because a guard cannot be built from a previous transaction's account, so the
 * account arrives as a create result rather than as an id.
 */
type ObjectArg = TransactionObjectArgument | string;

function ownedArg(tx: Transaction, v: ObjectArg): TransactionObjectArgument {
  return typeof v === 'string' ? tx.object(v) : v;
}

// === Shared objects, named explicitly ===

/**
 * A shared object, referenced the way this repo references them.
 *
 * `tx.object(id)` would do, but it RESOLVES the object through the client at build time. Naming the
 * initial shared version instead removes that lookup, and more to the point makes the version the
 * transaction is built against something this file can see and a caller can check.
 */
export type SharedRef = { objectId: string; initialSharedVersion: number; mutable: boolean };

/**
 * Read a shared object's initial version.
 *
 * The access shape is `settle-order.ts`'s, which is proven on this same client: the owner is a
 * tagged union and a shared one carries `Shared.initialSharedVersion`. A missing value throws rather
 * than defaulting, because a guard built against the wrong shared version fails at execution with
 * an error that points at the object rather than at this function.
 */
export async function sharedVersionOf(client: SuiGrpcClient, objectId: string): Promise<number> {
  const res = await client.getObject({ objectId });
  const obj = res.object ?? res;
  const initial = obj?.owner?.Shared?.initialSharedVersion;
  if (initial === undefined || initial === null) {
    throw new Error(`${objectId} is not shared — its owner is ${JSON.stringify(obj?.owner)}`);
  }
  return Number(initial);
}

/** The four shared objects every order path needs, resolved once per transaction. */
export type OrderRefs = {
  guard: SharedRef;
  pool: SharedRef;
  balanceManager: SharedRef;
  clock: SharedRef;
};

function orderRefs(tx: Transaction, refs: OrderRefs) {
  return {
    guard: tx.sharedObjectRef(refs.guard),
    pool: tx.sharedObjectRef(refs.pool),
    balanceManager: tx.sharedObjectRef(refs.balanceManager),
    clock: tx.sharedObjectRef(refs.clock),
  };
}

// === The caller's half of the guard ===
//
// These build the calls; they do not resolve, sign or submit. Everything a caller would otherwise
// have to get right by hand — the argument order, the type arguments, which capability authorises
// the order — is fixed here once, and the move-side signature is the only thing that can change it.

/**
 * Create a guard over an account. `create` takes the BalanceManager BY VALUE, sharing it as a side
 * effect, so this is the transaction after which an agent can reference it.
 *
 * `poolId` is a plain id rather than a pool reference, deliberately: the guard stores the binding
 * and every order asserts it, so a caller cannot pass a pool object whose type arguments disagree
 * with the guard's own.
 */
export function createGuardTx(
  tx: Transaction,
  opts: {
    poolId: string;
    balanceManager: ObjectArg;
    tradeCap: ObjectArg;
    agent: string;
    priceMin: bigint;
    priceMax: bigint;
    maxQty: bigint;
    budget: bigint;
  },
) {
  if (!DEEPBOOK_GUARD_PACKAGE) throw new Error('the guard module is not published');
  return tx.moveCall({
    target: `${DEEPBOOK_GUARD_PACKAGE}::deepbook_guard::create`,
    typeArguments: [...DEEPBOOK_POOL_TYPE_ARGS],
    arguments: [
      tx.pure.id(opts.poolId),
      ownedArg(tx, opts.balanceManager),
      ownedArg(tx, opts.tradeCap),
      tx.pure.address(opts.agent),
      tx.pure.u64(opts.priceMin),
      tx.pure.u64(opts.priceMax),
      tx.pure.u64(opts.maxQty),
      tx.pure.u64(opts.budget),
    ],
  });
}

// === The maker's knobs ===
//
// The guard's own settings, reachable from here because the walkthrough creates a guard with a
// DELIBERATELY loose budget — a first order should not be blocked by a number nobody has measured —
// and a loose budget is not a limit. Replacing it with one worth having is the maker's job, and that
// job needs a route from this file to the module.

/** The total quantity the agent may ever ask for, across every order. Maker-gated. */
export function setBudgetTx(tx: Transaction, guardId: string, budget: bigint) {
  if (!DEEPBOOK_GUARD_PACKAGE) throw new Error('the guard module is not published');
  return tx.moveCall({
    target: `${DEEPBOOK_GUARD_PACKAGE}::deepbook_guard::set_budget`,
    typeArguments: [...DEEPBOOK_POOL_TYPE_ARGS],
    arguments: [tx.object(guardId), tx.pure.u64(budget)],
  });
}

/** Freeze or unfreeze every agent path. Maker-gated, and the reversible stop. */
export function setPausedTx(tx: Transaction, guardId: string, paused: boolean) {
  if (!DEEPBOOK_GUARD_PACKAGE) throw new Error('the guard module is not published');
  return tx.moveCall({
    target: `${DEEPBOOK_GUARD_PACKAGE}::deepbook_guard::set_paused`,
    typeArguments: [...DEEPBOOK_POOL_TYPE_ARGS],
    arguments: [tx.object(guardId), tx.pure.bool(paused)],
  });
}

/**
 * The default expiry: an hour out, in milliseconds.
 *
 * NOT zero. The contract table says expiry `0` means "no expiration", and version 8 disagrees:
 * `order_info::validate_inputs` asserts `timestamp <= expire_timestamp`, so a zero is refused with
 * `EInvalidExpireTimestamp` (code 3) — discovered by a live probe, after ten quantities were
 * checked and this, not the quantity, turned out to be what every one of them was failing on.
 * "No expiry" is a timestamp far in the future, not an absent one.
 */
function defaultExpireMs(): bigint {
  return BigInt(Date.now() + 3_600_000);
}

/** Place a bid. Agent-gated on chain; the agent supplies parameters and nothing else. */
export function buyTx(
  tx: Transaction,
  refs: OrderRefs,
  opts: { clientOrderId: bigint; orderType: number; price: bigint; quantity: bigint; expireMs?: bigint },
) {
  if (!DEEPBOOK_GUARD_PACKAGE) throw new Error('the guard module is not published');
  const r = orderRefs(tx, refs);
  return tx.moveCall({
    target: `${DEEPBOOK_GUARD_PACKAGE}::deepbook_guard::buy`,
    typeArguments: [...DEEPBOOK_POOL_TYPE_ARGS],
    arguments: [
      r.guard, r.pool, r.balanceManager,
      tx.pure.u64(opts.clientOrderId),
      tx.pure.u8(opts.orderType),
      tx.pure.u64(opts.price),
      tx.pure.u64(opts.quantity),
      tx.pure.u64(opts.expireMs ?? defaultExpireMs()),
      r.clock,
    ],
  });
}

/** Place an ask. Identical to `buy` but for `is_bid`, which is the whole difference on chain. */
export function sellTx(
  tx: Transaction,
  refs: OrderRefs,
  opts: { clientOrderId: bigint; orderType: number; price: bigint; quantity: bigint; expireMs?: bigint },
) {
  if (!DEEPBOOK_GUARD_PACKAGE) throw new Error('the guard module is not published');
  const r = orderRefs(tx, refs);
  return tx.moveCall({
    target: `${DEEPBOOK_GUARD_PACKAGE}::deepbook_guard::sell`,
    typeArguments: [...DEEPBOOK_POOL_TYPE_ARGS],
    arguments: [
      r.guard, r.pool, r.balanceManager,
      tx.pure.u64(opts.clientOrderId),
      tx.pure.u8(opts.orderType),
      tx.pure.u64(opts.price),
      tx.pure.u64(opts.quantity),
      tx.pure.u64(opts.expireMs ?? defaultExpireMs()),
      r.clock,
    ],
  });
}

/** Cancel one resting order, returning its locked funds to settled balances. */
export function cancelTx(tx: Transaction, refs: OrderRefs, orderId: bigint) {
  if (!DEEPBOOK_GUARD_PACKAGE) throw new Error('the guard module is not published');
  const r = orderRefs(tx, refs);
  return tx.moveCall({
    target: `${DEEPBOOK_GUARD_PACKAGE}::deepbook_guard::cancel`,
    typeArguments: [...DEEPBOOK_POOL_TYPE_ARGS],
    arguments: [r.guard, r.pool, r.balanceManager, tx.pure.u128(orderId), r.clock],
  });
}

/**
 * Fund the account, by DeepBook's OWN owner path rather than ours.
 *
 * `balance_manager::deposit` is owner-gated and needs no capability, and the maker is always the
 * account's owner — which is why the guard has no deposit function. The coin comes from splitting
 * gas, so a caller needs no coin object to hand.
 */
export function depositSuiTx(tx: Transaction, balanceManager: SharedRef, amountMist: bigint) {
  const coin = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
  return tx.moveCall({
    target: `${DEEPBOOK_PACKAGE}::balance_manager::deposit`,
    typeArguments: [SUI_TYPE],
    arguments: [tx.sharedObjectRef(balanceManager), coin],
  });
}

/**
 * Empty ONE asset out of the account, back to an address, by DeepBook's owner path — the exit that
 * needs no capability, no guard, and no cooperation from this module or the agent.
 *
 * By coin TYPE rather than SUI alone. A ladder leaves behind whichever asset it was not quoting: an
 * ask ladder sells SUI and leaves USDC, a bid ladder does the reverse. A withdrawal that knows only
 * SUI therefore strands half of every account it drains, which is not a theoretical problem — it
 * stranded this one. The owner can always take it on chain; the point of the flag is taking it here.
 */
export function withdrawAllTx(
  tx: Transaction,
  balanceManager: SharedRef,
  coinType: string,
  recipient: string,
) {
  const coin = tx.moveCall({
    target: `${DEEPBOOK_PACKAGE}::balance_manager::withdraw_all`,
    typeArguments: [coinType],
    arguments: [tx.sharedObjectRef(balanceManager)],
  });
  tx.transferObjects([coin], tx.pure.address(recipient));
  return coin;
}
