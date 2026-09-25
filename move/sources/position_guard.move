/// `sui_tokyo::position_guard` — custody for a Cetus CLMM position.
///
/// A shared `PositionGuard` owns a Cetus LP position NFT. The agent may
/// rebalance it and collect its fees; it may never extract it.
///
/// The rule that matters, and the one the widely-copied Cetus vault template
/// gets wrong: **no function returns the position, or a mutable reference to
/// it.** Templates that publish `borrow_position` / `borrow_mut_position` /
/// `take_position` hand out the very thing the wrapper exists to protect —
/// a caller holding `&mut Position` can call Cetus directly and drain it,
/// bypassing every check here. Those borrows stay module-private, and only
/// whole operations are exposed.
///
/// Second rule: every value output goes to `destination`, never to the caller.
/// A rebalance frees both coins mid-operation; they are consumed by the new
/// position's receipt inside this module and the remainder is routed to the
/// owner. The agent chooses parameters, never dispositions.
///
/// Authority is the vault's `OwnerCap`, the same single credential used
/// elsewhere, checked against the recorded vault binding.
///
/// Cetus's liquidity operations are receipt-based, exactly like its swaps:
/// `add_liquidity` computes what is owed and returns a receipt with no `drop`,
/// which forces settlement in the same transaction. Repayment asserts exact
/// equality, so each side is split to precisely the required figure and any
/// remainder is returned rather than stranded.
module sui_tokyo::position_guard;

use cetus_clmm::config::GlobalConfig;
use cetus_clmm::pool::{Self as cetus_pool, Pool};
use cetus_clmm::position::{Self as cetus_position, Position};
use cetus_clmm::rewarder::RewarderGlobalVault;
use sui_tokyo::spend_vault::OwnerCap;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin;
use sui::dynamic_object_field;
use sui::event;

#[error]
const ENotAgent: vector<u8> = "caller is not the authorised agent";
#[error]
const ESuspended: vector<u8> = "guard is suspended";
#[error]
const EWrongOwnerCap: vector<u8> = "OwnerCap does not match the guard's vault";
#[error]
const EWrongPool: vector<u8> = "pool does not match the guard's position";
#[error]
const ETickWidthOutOfBounds: vector<u8> = "requested tick width is outside policy bounds";
#[error]
const ETickRangeInverted: vector<u8> = "tick lower must be below tick upper";
#[error]
const ENoLiquidity: vector<u8> = "position holds no liquidity to remove";

/// Dynamic-object-field key under which the Position is embedded.
public struct PositionKey has copy, drop, store {}

/// Shared custody wrapper. Owns the position; exposes operations, never the asset.
public struct PositionGuard<phantom CoinTypeA, phantom CoinTypeB> has key {
    id: UID,
    /// The vault whose OwnerCap governs this guard. One credential, as elsewhere.
    admin_vault_id: ID,
    /// The only address allowed to call the agent paths.
    agent: address,
    /// Where every value output goes. A sink, not an authority.
    destination: address,
    suspended: bool,
    pool_id: ID,
    position_id: ID,
    /// Policy bounds on the range the agent may choose, in ticks.
    min_tick_width: u32,
    max_tick_width: u32,
}

/// Emitted whenever the agent changes the range.
public struct Rebalanced has copy, drop {
    guard_id: ID,
    pool_id: ID,
    old_position_id: ID,
    new_position_id: ID,
    tick_lower: u32,
    tick_upper: u32,
}

/// Emitted when fees are collected.
public struct FeesCollected has copy, drop {
    guard_id: ID,
    pool_id: ID,
    position_id: ID,
    amount_a: u64,
    amount_b: u64,
    destination: address,
}

/// Emitted on admin changes.
public struct GuardUpdated has copy, drop {
    guard_id: ID,
    agent: address,
    destination: address,
    suspended: bool,
}

/// Open a position and place it under a new guard. Owner-gated.
///
/// The position is created by this call and embedded immediately, so no caller
/// ever holds it — not even the owner.
public fun create<CoinTypeA, CoinTypeB>(
    config: &GlobalConfig,
    pool: &mut Pool<CoinTypeA, CoinTypeB>,
    admin_vault_id: ID,
    owner_cap: &OwnerCap,
    agent: address,
    destination: address,
    tick_lower: u32,
    tick_upper: u32,
    min_tick_width: u32,
    max_tick_width: u32,
    ctx: &mut TxContext,
): ID {
    assert!(owner_cap_vault_id_matches(owner_cap, admin_vault_id), EWrongOwnerCap);
    assert!(tick_lower < tick_upper, ETickRangeInverted);

    let position: Position = cetus_pool::open_position<CoinTypeA, CoinTypeB>(
        config, pool, tick_lower, tick_upper, ctx,
    );
    let position_id = object::id(&position);

    let mut guard = PositionGuard<CoinTypeA, CoinTypeB> {
        id: object::new(ctx),
        admin_vault_id,
        agent,
        destination,
        suspended: false,
        pool_id: object::id(pool),
        position_id,
        min_tick_width,
        max_tick_width,
    };
    let guard_id = object::id(&guard);

    dynamic_object_field::add(&mut guard.id, PositionKey {}, position);
    transfer::share_object(guard);

    event::emit(GuardUpdated { guard_id, agent, destination, suspended: false });
    guard_id
}

// === Buyer-supplied liquidity (owner deploys capital) ===

/// Add liquidity by liquidity amount. Owner-gated.
///
/// Superseded by `deposit_liquidity_fix`, which takes a fixed coin amount so the
/// caller does not have to compute CLMM liquidity off-chain. Kept because an
/// upgrade cannot remove a function, and it remains correct for callers that
/// already hold a liquidity figure.
public fun deposit_liquidity<CoinTypeA, CoinTypeB>(
    guard: &mut PositionGuard<CoinTypeA, CoinTypeB>,
    config: &GlobalConfig,
    pool: &mut Pool<CoinTypeA, CoinTypeB>,
    owner_cap: &OwnerCap,
    delta_liquidity: u128,
    clock: &Clock,
    funds_a: Balance<CoinTypeA>,
    funds_b: Balance<CoinTypeB>,
    ctx: &mut TxContext,
) {
    assert_binding(guard, owner_cap);
    assert_pool(guard, pool);

    let destination = guard.destination;
    let position = borrow_position(guard);

    let receipt = cetus_pool::add_liquidity<CoinTypeA, CoinTypeB>(
        config, pool, position, delta_liquidity, clock,
    );
    let (need_a, need_b) = cetus_pool::add_liquidity_pay_amount<CoinTypeA, CoinTypeB>(&receipt);

    pay_and_repay<CoinTypeA, CoinTypeB>(
        config, pool, receipt, funds_a, funds_b, need_a, need_b, destination, ctx,
    );
}

/// Add liquidity using coins supplied by the caller. Owner-gated, because this
/// is capital deployment rather than routine operation.
///
/// Takes a FIXED COIN AMOUNT on one side rather than a liquidity figure, so the
/// caller does not have to compute CLMM liquidity off-chain from sqrt prices.
/// Cetus derives the liquidity and tells us what both sides owe; whatever is
/// left of the supplied balances goes to `destination`.
public fun deposit_liquidity_fix<CoinTypeA, CoinTypeB>(
    guard: &mut PositionGuard<CoinTypeA, CoinTypeB>,
    config: &GlobalConfig,
    pool: &mut Pool<CoinTypeA, CoinTypeB>,
    owner_cap: &OwnerCap,
    amount: u64,
    fix_amount_a: bool,
    clock: &Clock,
    funds_a: Balance<CoinTypeA>,
    funds_b: Balance<CoinTypeB>,
    ctx: &mut TxContext,
) {
    assert_binding(guard, owner_cap);
    assert_pool(guard, pool);

    let destination = guard.destination;
    let position = borrow_position(guard);

    let receipt = cetus_pool::add_liquidity_fix_coin<CoinTypeA, CoinTypeB>(
        config, pool, position, amount, fix_amount_a, clock,
    );
    let (need_a, need_b) = cetus_pool::add_liquidity_pay_amount<CoinTypeA, CoinTypeB>(&receipt);

    pay_and_repay<CoinTypeA, CoinTypeB>(
        config, pool, receipt, funds_a, funds_b, need_a, need_b, destination, ctx,
    );
}

// === Agent paths ===

/// Collect accrued fees and route both coins to the owner. Agent-gated.
///
/// `collect_fee` takes the position by immutable reference, so this path never
/// needs a mutable borrow and cannot disturb the position's state.
public fun collect_fees<CoinTypeA, CoinTypeB>(
    guard: &mut PositionGuard<CoinTypeA, CoinTypeB>,
    config: &GlobalConfig,
    pool: &mut Pool<CoinTypeA, CoinTypeB>,
    ctx: &mut TxContext,
) {
    assert_caller_is_agent(guard, ctx);
    assert_pool_matches(guard, pool);

    // Copy what the event needs before taking the mutable borrow below.
    let destination = guard.destination;
    let guard_id = object::id(guard);
    let pool_id = guard.pool_id;
    let position_id = guard.position_id;

    let position = borrow_position(guard);

    let (fees_a, fees_b) =
        cetus_pool::collect_fee<CoinTypeA, CoinTypeB>(config, pool, position, true);

    let amount_a = fees_a.value();
    let amount_b = fees_b.value();

    send(fees_a, destination, ctx);
    send(fees_b, destination, ctx);

    event::emit(FeesCollected {
        guard_id,
        pool_id,
        position_id,
        amount_a,
        amount_b,
        destination,
    });
}

/// Move the position to a new tick range. Agent-gated.
///
/// Superseded by `rebalance_with_rewards`, which also collects the pool's reward.
/// Kept because a function cannot be removed by an upgrade, and this remains
/// correct for pools that pay no rewards. On a reward-bearing pool Cetus refuses
/// the close with `EPositionIsNotEmpty`.
public fun rebalance<CoinTypeA, CoinTypeB>(
    guard: &mut PositionGuard<CoinTypeA, CoinTypeB>,
    config: &GlobalConfig,
    pool: &mut Pool<CoinTypeA, CoinTypeB>,
    new_tick_lower: u32,
    new_tick_upper: u32,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_caller_is_agent(guard, ctx);
    assert_pool_matches(guard, pool);
    assert_range_in_bounds(guard, new_tick_lower, new_tick_upper);

    let destination = guard.destination;
    let old_position_id = guard.position_id;

    let mut position: Position =
        dynamic_object_field::remove<PositionKey, Position>(&mut guard.id, PositionKey {});

    let liquidity = cetus_position::liquidity(&position);
    assert!(liquidity > 0, ENoLiquidity);

    let (proceeds_a, proceeds_b) =
        cetus_pool::remove_liquidity<CoinTypeA, CoinTypeB>(
            config, pool, &mut position, liquidity, clock,
        );
    let (fee_a, fee_b) =
        cetus_pool::collect_fee<CoinTypeA, CoinTypeB>(config, pool, &position, true);

    let funds_a = combine(proceeds_a, fee_a);
    let funds_b = combine(proceeds_b, fee_b);

    cetus_pool::close_position<CoinTypeA, CoinTypeB>(config, pool, position);

    let mut new_position: Position = cetus_pool::open_position<CoinTypeA, CoinTypeB>(
        config, pool, new_tick_lower, new_tick_upper, ctx,
    );

    let receipt = cetus_pool::add_liquidity<CoinTypeA, CoinTypeB>(
        config, pool, &mut new_position, liquidity, clock,
    );
    let (need_a, need_b) = cetus_pool::add_liquidity_pay_amount<CoinTypeA, CoinTypeB>(&receipt);

    pay_and_repay<CoinTypeA, CoinTypeB>(
        config, pool, receipt, funds_a, funds_b, need_a, need_b, destination, ctx,
    );

    let new_position_id = object::id(&new_position);
    guard.position_id = new_position_id;
    dynamic_object_field::add(&mut guard.id, PositionKey {}, new_position);

    event::emit(Rebalanced {
        guard_id: object::id(guard),
        pool_id: guard.pool_id,
        old_position_id,
        new_position_id,
        tick_lower: new_tick_lower,
        tick_upper: new_tick_upper,
    });
}

/// Move the position to a new tick range in one atomic transaction, collecting
/// the pool's reward on the way. Agent-gated.
///
/// Everything happens inside this module: remove all liquidity, collect fees and
/// rewards, close the old position, open a new one, and repay the new position's
/// receipt with the balances just freed. The freed value never becomes a
/// transaction value the caller could redirect — it is consumed here.
///
/// `RewardType` must name the pool's reward coin. Cetus's `close_position`
/// refuses while any reward is still owed (`EPositionIsNotEmpty`), and Move
/// cannot iterate runtime types — so the reward type is a parameter. A pool with
/// more than one rewarder would need more parameters; this is a known limit, not
/// a general solution.
public fun rebalance_with_rewards<CoinTypeA, CoinTypeB, RewardType>(
    guard: &mut PositionGuard<CoinTypeA, CoinTypeB>,
    config: &GlobalConfig,
    pool: &mut Pool<CoinTypeA, CoinTypeB>,
    rewarder_vault: &mut RewarderGlobalVault,
    new_tick_lower: u32,
    new_tick_upper: u32,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_caller_is_agent(guard, ctx);
    assert_pool_matches(guard, pool);

    assert_range_in_bounds(guard, new_tick_lower, new_tick_upper);

    let destination = guard.destination;
    let old_position_id = guard.position_id;

    // Take the position out of the field so it can be consumed and replaced.
    let mut position: Position =
        dynamic_object_field::remove<PositionKey, Position>(&mut guard.id, PositionKey {});

    let liquidity = cetus_position::liquidity(&position);
    assert!(liquidity > 0, ENoLiquidity);

    // 1. Withdraw everything, then collect what the withdrawal does not include.
    let (proceeds_a, proceeds_b) =
        cetus_pool::remove_liquidity<CoinTypeA, CoinTypeB>(
            config, pool, &mut position, liquidity, clock,
        );
    let (fee_a, fee_b) =
        cetus_pool::collect_fee<CoinTypeA, CoinTypeB>(config, pool, &position, true);

    // Rewards must be collected too, or `close_position` refuses: a position is
    // only empty when liquidity, both fee sides, and every reward read zero.
    let rewards: Balance<RewardType> = cetus_pool::collect_reward<
        CoinTypeA, CoinTypeB, RewardType,
    >(config, pool, &position, rewarder_vault, true, clock);

    let funds_a = combine(proceeds_a, fee_a);
    let funds_b = combine(proceeds_b, fee_b);
    send(rewards, destination, ctx);

    // 2. Retire the old position and open the new range.
    cetus_pool::close_position<CoinTypeA, CoinTypeB>(config, pool, position);

    let mut new_position: Position = cetus_pool::open_position<CoinTypeA, CoinTypeB>(
        config, pool, new_tick_lower, new_tick_upper, ctx,
    );

    // 3. Redeploy at least what came out. Add first, then settle the receipt
    //    with the freed balances, splitting each side to exactly what is owed
    //    and routing the remainder to the owner.
    //
    //    The added liquidity is derived from the freed side, so this is a
    //    full redeploy of the withdrawn amount.
    let redeploy = liquidity;
    let receipt = cetus_pool::add_liquidity<CoinTypeA, CoinTypeB>(
        config, pool, &mut new_position, redeploy, clock,
    );
    let (need_a, need_b) = cetus_pool::add_liquidity_pay_amount<CoinTypeA, CoinTypeB>(&receipt);

    pay_and_repay<CoinTypeA, CoinTypeB>(
        config, pool, receipt, funds_a, funds_b, need_a, need_b, destination, ctx,
    );

    // 4. Put the new position back under the same guard and record it.
    let new_position_id = object::id(&new_position);
    guard.position_id = new_position_id;
    dynamic_object_field::add(&mut guard.id, PositionKey {}, new_position);

    event::emit(Rebalanced {
        guard_id: object::id(guard),
        pool_id: guard.pool_id,
        old_position_id,
        new_position_id,
        tick_lower: new_tick_lower,
        tick_upper: new_tick_upper,
    });
}

/// Exit entirely: remove everything, collect fees, close the position, route all
/// value to the owner's destination. Cap-holder gated.
///
/// Superseded by `redeem_with_rewards` on any pool that pays rewards — the close
/// there fails `EPositionIsNotEmpty`. Kept because a function cannot be removed
/// by an upgrade.
public fun redeem<CoinTypeA, CoinTypeB>(
    guard: &mut PositionGuard<CoinTypeA, CoinTypeB>,
    config: &GlobalConfig,
    pool: &mut Pool<CoinTypeA, CoinTypeB>,
    owner_cap: &OwnerCap,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_binding(guard, owner_cap);
    assert_pool(guard, pool);

    let destination = guard.destination;
    let mut position: Position =
        dynamic_object_field::remove<PositionKey, Position>(&mut guard.id, PositionKey {});

    let liquidity = cetus_position::liquidity(&position);
    if (liquidity > 0) {
        let (proceeds_a, proceeds_b) =
            cetus_pool::remove_liquidity<CoinTypeA, CoinTypeB>(
                config, pool, &mut position, liquidity, clock,
            );
        send(proceeds_a, destination, ctx);
        send(proceeds_b, destination, ctx);
    };

    let (fee_a, fee_b) =
        cetus_pool::collect_fee<CoinTypeA, CoinTypeB>(config, pool, &position, true);
    send(fee_a, destination, ctx);
    send(fee_b, destination, ctx);

    cetus_pool::close_position<CoinTypeA, CoinTypeB>(config, pool, position);
}

/// Exit entirely: remove everything, collect fees and rewards, close the
/// position, route all value to the owner's destination. Cap-holder gated.
/// After this the guard holds nothing. Needs the pool's reward type for the same
/// reason `rebalance_with_rewards` does.
public fun redeem_with_rewards<CoinTypeA, CoinTypeB, RewardType>(
    guard: &mut PositionGuard<CoinTypeA, CoinTypeB>,
    config: &GlobalConfig,
    pool: &mut Pool<CoinTypeA, CoinTypeB>,
    owner_cap: &OwnerCap,
    rewarder_vault: &mut RewarderGlobalVault,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_binding(guard, owner_cap);
    assert_pool(guard, pool);

    let destination = guard.destination;
    let mut position: Position =
        dynamic_object_field::remove<PositionKey, Position>(&mut guard.id, PositionKey {});

    let liquidity = cetus_position::liquidity(&position);
    if (liquidity > 0) {
        let (proceeds_a, proceeds_b) =
            cetus_pool::remove_liquidity<CoinTypeA, CoinTypeB>(
                config, pool, &mut position, liquidity, clock,
            );
        send(proceeds_a, destination, ctx);
        send(proceeds_b, destination, ctx);
    };

    let (fee_a, fee_b) =
        cetus_pool::collect_fee<CoinTypeA, CoinTypeB>(config, pool, &position, true);
    send(fee_a, destination, ctx);
    send(fee_b, destination, ctx);

    let rewards: Balance<RewardType> = cetus_pool::collect_reward<
        CoinTypeA, CoinTypeB, RewardType,
    >(config, pool, &position, rewarder_vault, true, clock);
    send(rewards, destination, ctx);

    cetus_pool::close_position<CoinTypeA, CoinTypeB>(config, pool, position);
}

// === Admin (OwnerCap holder) ===

public fun set_agent<CoinTypeA, CoinTypeB>(
    guard: &mut PositionGuard<CoinTypeA, CoinTypeB>,
    owner_cap: &OwnerCap,
    new_agent: address,
) {
    assert_binding(guard, owner_cap);
    guard.agent = new_agent;
    emit_updated(guard);
}

public fun set_destination<CoinTypeA, CoinTypeB>(
    guard: &mut PositionGuard<CoinTypeA, CoinTypeB>,
    owner_cap: &OwnerCap,
    new_destination: address,
) {
    assert_binding(guard, owner_cap);
    guard.destination = new_destination;
    emit_updated(guard);
}

public fun set_suspended<CoinTypeA, CoinTypeB>(
    guard: &mut PositionGuard<CoinTypeA, CoinTypeB>,
    owner_cap: &OwnerCap,
    suspended: bool,
) {
    assert_binding(guard, owner_cap);
    guard.suspended = suspended;
    emit_updated(guard);
}

/// Tighten or loosen the range the agent may choose. This is the main economic
/// guardrail: without it a compromised agent can select a ruinous range.
public fun set_tick_bounds<CoinTypeA, CoinTypeB>(
    guard: &mut PositionGuard<CoinTypeA, CoinTypeB>,
    owner_cap: &OwnerCap,
    min_tick_width: u32,
    max_tick_width: u32,
) {
    assert_binding(guard, owner_cap);
    guard.min_tick_width = min_tick_width;
    guard.max_tick_width = max_tick_width;
    emit_updated(guard);
}

// === Internals ===

/// Split each side to exactly what is owed, repay, and route the remainder to
/// the destination. Exact equality is asserted by Cetus, so a naive repayment
/// with the full balance aborts when it is even one unit over.
fun pay_and_repay<CoinTypeA, CoinTypeB>(
    config: &GlobalConfig,
    pool: &mut Pool<CoinTypeA, CoinTypeB>,
    receipt: cetus_pool::AddLiquidityReceipt<CoinTypeA, CoinTypeB>,
    mut funds_a: Balance<CoinTypeA>,
    mut funds_b: Balance<CoinTypeB>,
    need_a: u64,
    need_b: u64,
    destination: address,
    ctx: &mut TxContext,
) {
    let pay_a = funds_a.split(need_a);
    let pay_b = funds_b.split(need_b);

    cetus_pool::repay_add_liquidity<CoinTypeA, CoinTypeB>(
        config, pool, pay_a, pay_b, receipt,
    );

    send(funds_a, destination, ctx);
    send(funds_b, destination, ctx);
}

fun combine<C>(a: Balance<C>, b: Balance<C>): Balance<C> {
    let mut a = a;
    a.join(b);
    a
}

/// Borrow the embedded position mutably. Deliberately private, and the only
/// borrow in this module — publishing it would hand out the asset the guard
/// exists to protect, and a caller holding `&mut Position` can reach Cetus
/// directly and bypass every check here.
fun borrow_position<CoinTypeA, CoinTypeB>(
    guard: &mut PositionGuard<CoinTypeA, CoinTypeB>,
): &mut Position {
    dynamic_object_field::borrow_mut<PositionKey, Position>(&mut guard.id, PositionKey {})
}

fun send<C>(b: Balance<C>, to: address, ctx: &mut TxContext) {
    if (b.value() > 0) {
        transfer::public_transfer(coin::from_balance(b, ctx), to);
    } else {
        balance::destroy_zero(b);
    };
}

/// Who may call, and whether the guard is live. Separated from the pool check so
/// both halves are reachable without a live pool.
fun assert_caller_is_agent<CoinTypeA, CoinTypeB>(
    guard: &PositionGuard<CoinTypeA, CoinTypeB>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == guard.agent, ENotAgent);
    assert!(!guard.suspended, ESuspended);
}

fun assert_pool_matches<CoinTypeA, CoinTypeB>(
    guard: &PositionGuard<CoinTypeA, CoinTypeB>,
    pool: &Pool<CoinTypeA, CoinTypeB>,
) {
    assert!(object::id(pool) == guard.pool_id, EWrongPool);
}

/// The economic guardrail. Without a width bound a compromised agent can pick a
/// ruinous range; the bounds are the owner's ceiling on that.
fun assert_range_in_bounds<CoinTypeA, CoinTypeB>(
    guard: &PositionGuard<CoinTypeA, CoinTypeB>,
    tick_lower: u32,
    tick_upper: u32,
) {
    assert!(tick_lower < tick_upper, ETickRangeInverted);
    let width = tick_upper - tick_lower;
    assert!(
        width >= guard.min_tick_width && width <= guard.max_tick_width,
        ETickWidthOutOfBounds,
    );
}

fun assert_pool<CoinTypeA, CoinTypeB>(
    guard: &PositionGuard<CoinTypeA, CoinTypeB>,
    pool: &Pool<CoinTypeA, CoinTypeB>,
) {
    assert!(object::id(pool) == guard.pool_id, EWrongPool);
}

fun assert_binding<CoinTypeA, CoinTypeB>(
    guard: &PositionGuard<CoinTypeA, CoinTypeB>,
    owner_cap: &OwnerCap,
) {
    assert!(
        owner_cap_vault_id_matches(owner_cap, guard.admin_vault_id),
        EWrongOwnerCap,
    );
}

fun owner_cap_vault_id_matches(owner_cap: &OwnerCap, vault_id: ID): bool {
    sui_tokyo::spend_vault::owner_cap_vault_id(owner_cap) == vault_id
}

fun emit_updated<CoinTypeA, CoinTypeB>(guard: &PositionGuard<CoinTypeA, CoinTypeB>) {
    event::emit(GuardUpdated {
        guard_id: object::id(guard),
        agent: guard.agent,
        destination: guard.destination,
        suspended: guard.suspended,
    });
}

// === Read-only accessors ===

public fun guard_id<CoinTypeA, CoinTypeB>(guard: &PositionGuard<CoinTypeA, CoinTypeB>): ID {
    object::id(guard)
}

public fun position_id<CoinTypeA, CoinTypeB>(guard: &PositionGuard<CoinTypeA, CoinTypeB>): ID {
    guard.position_id
}

public fun pool_id<CoinTypeA, CoinTypeB>(guard: &PositionGuard<CoinTypeA, CoinTypeB>): ID {
    guard.pool_id
}

public fun agent<CoinTypeA, CoinTypeB>(guard: &PositionGuard<CoinTypeA, CoinTypeB>): address {
    guard.agent
}

public fun destination<CoinTypeA, CoinTypeB>(
    guard: &PositionGuard<CoinTypeA, CoinTypeB>,
): address {
    guard.destination
}

public fun is_suspended<CoinTypeA, CoinTypeB>(
    guard: &PositionGuard<CoinTypeA, CoinTypeB>,
): bool {
    guard.suspended
}

public fun tick_bounds<CoinTypeA, CoinTypeB>(
    guard: &PositionGuard<CoinTypeA, CoinTypeB>,
): (u32, u32) {
    (guard.min_tick_width, guard.max_tick_width)
}

// === Test-only hooks ===
//
// The guard's operations need a live Cetus pool and a real position, which a
// unit test cannot construct. These expose the gates that do NOT need one, so
// the authorisation and the economic bound are actually covered rather than
// assumed.

/// Build a guard with no position embedded, for exercising the gates.
#[test_only]
public fun create_for_testing<CoinTypeA, CoinTypeB>(
    admin_vault_id: ID,
    owner_cap: &OwnerCap,
    agent: address,
    destination: address,
    min_tick_width: u32,
    max_tick_width: u32,
    ctx: &mut TxContext,
): ID {
    assert!(owner_cap_vault_id_matches(owner_cap, admin_vault_id), EWrongOwnerCap);

    let guard = PositionGuard<CoinTypeA, CoinTypeB> {
        id: object::new(ctx),
        admin_vault_id,
        agent,
        destination,
        suspended: false,
        pool_id: object::id_from_address(@0x0),
        position_id: object::id_from_address(@0x0),
        min_tick_width,
        max_tick_width,
    };
    let guard_id = object::id(&guard);
    transfer::share_object(guard);
    guard_id
}

#[test_only]
public fun check_caller_for_testing<CoinTypeA, CoinTypeB>(
    guard: &PositionGuard<CoinTypeA, CoinTypeB>,
    ctx: &TxContext,
) {
    assert_caller_is_agent(guard, ctx)
}

#[test_only]
public fun check_range_for_testing<CoinTypeA, CoinTypeB>(
    guard: &PositionGuard<CoinTypeA, CoinTypeB>,
    tick_lower: u32,
    tick_upper: u32,
) {
    assert_range_in_bounds(guard, tick_lower, tick_upper)
}
