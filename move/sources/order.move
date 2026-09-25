/// `sui_tokyo::order` — escrowed swaps with a maker-committed minimum.
///
/// A second swap path beside the vault one. The maker escrows the input in an
/// `Order`, commits the least output they will accept, and the agent fills it. The
/// difference from the vault path is not a stricter check, it is WHERE THE FUNDS
/// ARE: inside the order, reachable only by settling, and settling asserts the
/// minimum. That is what makes the commitment non-bypassable — the older
/// `policy::swap_and_route` stays callable, but it cannot reach funds held here.
///
/// This exists because the vault path could not bound the price. `swap_and_route`
/// takes `sqrt_price_limit` from the caller, so the AGENT chose its own tolerance,
/// and the `max_slippage_bps` added later is bypassable by naming an older package
/// id. Here the MAKER sets the floor and the funds enforce it.
///
/// See docs/ORDER-ESCROW.md.
module sui_tokyo::order;

use cetus_clmm::config::GlobalConfig;
use cetus_clmm::pool::Pool;
use sui_tokyo::policy::{Self, Policy};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;

#[error]
const ENotAgent: vector<u8> = "caller is not the policy's agent";
#[error]
const EPoolNotAllowed: vector<u8> = "pool is not on the policy allowlist";
#[error]
const EWrongPool: vector<u8> = "pool does not match the order";
#[error]
const EOrderExpired: vector<u8> = "order has expired";
#[error]
const ENotExpired: vector<u8> = "order has not expired yet";
#[error]
const EBelowMinimum: vector<u8> = "output is below the maker's minimum";
#[error]
const EZeroMinOut: vector<u8> = "min_out must be greater than zero";
#[error]
const EZeroAmount: vector<u8> = "amount_in must be greater than zero";

/// A maker's swap commitment: funds escrowed, minimum committed, expiring.
///
/// **NO `drop`.** That is the enforcement, not a style choice. A value without the
/// drop ability cannot be discarded, so the order can only leave the system by being
/// consumed — and both consuming functions assert the maker's terms first.
///
/// An object rather than a hot potato on purpose: a hot potato must be consumed
/// WITHIN one transaction, which cannot bind a flow where the maker commits in one
/// transaction and the agent settles in a later one. `key + store` without `drop`
/// gives the same non-discardable property across transactions.
/// `CoinType` is `phantom` because it appears only inside `Balance<CoinType>`, whose
/// own parameter is phantom. That is not a detail: a struct with the `key` ability
/// normally requires every type argument to have `store`, and `phantom` is what
/// exempts it. Without the annotation `Order<SUI>` does not compile.
public struct Order<phantom CoinType> has key, store {
    id: UID,
    /// Who committed. Refunds go here.
    maker: address,
    /// Where the output goes. Fixed at creation; the settler cannot change it.
    destination: address,
    /// The escrowed input. This field is the whole design.
    funds: Balance<CoinType>,
    /// The pool the swap must use. Checked against the pool actually passed.
    pool_id: ID,
    /// The least the maker will accept. Asserted at settlement.
    min_out: u64,
    /// After this, anyone may refund. No order can hold funds forever.
    expires_at_ms: u64,
}

public struct OrderCreated has copy, drop {
    order_id: ID,
    maker: address,
    destination: address,
    pool_id: ID,
    amount_in: u64,
    min_out: u64,
    expires_at_ms: u64,
}

public struct OrderSettled has copy, drop {
    order_id: ID,
    maker: address,
    settler: address,
    pool_id: ID,
    amount_in: u64,
    amount_out: u64,
    min_out: u64,
    destination: address,
}

public struct OrderRefunded has copy, drop {
    order_id: ID,
    maker: address,
    amount: u64,
    refunded_by: address,
}

// === Maker side ===

/// Escrow a coin against a minimum and share the order.
///
/// Ungated: this is the maker's own commitment, and escrowing your own funds needs
/// no permission. The maker is `ctx.sender()`, so no caller can commit on behalf of
/// someone else.
public fun create<CoinType>(
    coin: Coin<CoinType>,
    pool_id: ID,
    min_out: u64,
    expires_at_ms: u64,
    destination: address,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    let amount_in = coin.value();
    assert!(amount_in > 0, EZeroAmount);
    // A zero floor is not a commitment; it would let a settler deliver nothing.
    assert!(min_out > 0, EZeroMinOut);
    // An order created already expired could never be settled, only refunded.
    assert!(expires_at_ms > clock.timestamp_ms(), EOrderExpired);

    let maker = ctx.sender();
    let order = Order<CoinType> {
        id: object::new(ctx),
        maker,
        destination,
        funds: coin.into_balance(),
        pool_id,
        min_out,
        expires_at_ms,
    };
    let order_id = object::id(&order);

    event::emit(OrderCreated {
        order_id, maker, destination, pool_id, amount_in, min_out, expires_at_ms,
    });
    transfer::share_object(order);
    order_id
}

/// Reclaim after expiry. Anyone may trigger it, and the funds always go to the maker.
///
/// Permissionless on purpose: an order nobody settles must not be able to sit with
/// dead funds just because the maker went quiet. Since the destination is the maker
/// and not the caller, a stranger triggering it can only help.
public fun refund<CoinType>(order: Order<CoinType>, clock: &Clock, ctx: &mut TxContext) {
    let Order<CoinType> {
        id, maker, destination: _, funds, pool_id: _, min_out: _, expires_at_ms,
    } = order;
    assert!(clock.timestamp_ms() >= expires_at_ms, ENotExpired);

    let amount = funds.value();
    // Read the id BEFORE deleting the UID: delete consumes it.
    let order_id = id.to_inner();
    object::delete(id);
    transfer::public_transfer(coin::from_balance(funds, ctx), maker);

    event::emit(OrderRefunded { order_id, maker, amount, refunded_by: ctx.sender() });
}

// === Settler side ===
//
// Two entry points rather than one, because Move is statically typed and the
// direction is determined by which side of the pool the order's coin sits on. An
// order holding side A can only go A->B; one holding side B can only go B->A. A
// single function cannot express both, and inferring it is not possible.

/// Fill an order whose coin is side A of the pool. Agent-gated.
public fun settle_a2b<A, B>(
    policy: &Policy,
    order: Order<A>,
    config: &GlobalConfig,
    pool: &mut Pool<A, B>,
    sqrt_price_limit: u128,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_settleable(policy, order.pool_id, object::id(pool), order.expires_at_ms, clock, ctx);
    let (funds, destination, min_out, order_id, maker) = unpack(order);
    let amount_in = funds.value();

    let (remainder, output) = policy::swap_balance_a2b<A, B>(
        funds, config, pool, amount_in, sqrt_price_limit, clock,
    );
    let amount_out = output.value();
    assert!(amount_out >= min_out, EBelowMinimum);

    // Both sides to the maker's destination: the output, and any input the pool did
    // not consume. Nothing is left in this module.
    transfer::public_transfer(coin::from_balance(remainder, ctx), destination);
    transfer::public_transfer(coin::from_balance(output, ctx), destination);

    event::emit(OrderSettled {
        order_id, maker, settler: ctx.sender(), pool_id: object::id(pool),
        amount_in, amount_out, min_out, destination,
    });
}

/// Fill an order whose coin is side B of the pool. Agent-gated.
public fun settle_b2a<A, B>(
    policy: &Policy,
    order: Order<B>,
    config: &GlobalConfig,
    pool: &mut Pool<A, B>,
    sqrt_price_limit: u128,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_settleable(policy, order.pool_id, object::id(pool), order.expires_at_ms, clock, ctx);
    let (funds, destination, min_out, order_id, maker) = unpack(order);
    let amount_in = funds.value();

    let (remainder, output) = policy::swap_balance_b2a<A, B>(
        funds, config, pool, amount_in, sqrt_price_limit, clock,
    );
    let amount_out = output.value();
    assert!(amount_out >= min_out, EBelowMinimum);

    transfer::public_transfer(coin::from_balance(remainder, ctx), destination);
    transfer::public_transfer(coin::from_balance(output, ctx), destination);

    event::emit(OrderSettled {
        order_id, maker, settler: ctx.sender(), pool_id: object::id(pool),
        amount_in, amount_out, min_out, destination,
    });
}

// === Internals ===

/// The gates a settlement must pass, in order. Kept in one place so both directions
/// cannot drift apart.
fun assert_settleable(
    policy: &Policy,
    order_pool_id: ID,
    pool_id: ID,
    expires_at_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == policy::agent(policy), ENotAgent);
    assert!(policy::is_pool_allowed(policy, pool_id), EPoolNotAllowed);
    // The settler chooses which Pool object to pass, so the order's own pool id has
    // to be checked. Without this a settler could swap against a pool the maker
    // never named -- the same class of mistake as the venue allowlist, one layer
    // down.
    assert!(pool_id == order_pool_id, EWrongPool);
    assert!(clock.timestamp_ms() < expires_at_ms, EOrderExpired);
}

/// The gates, exposed so they can be tested without a live Cetus pool. The real
/// entry points take a `&mut Pool`, which the unit VM cannot construct — but the
/// gates take only IDs, so the part that can be tested is tested here.
#[test_only]
public fun assert_settleable_for_testing(
    policy: &Policy,
    order_pool_id: ID,
    pool_id: ID,
    expires_at_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_settleable(policy, order_pool_id, pool_id, expires_at_ms, clock, ctx)
}

/// Consume the order and hand back what the caller needs. The destructuring is the
/// point: it is only possible once, so a settled order cannot be settled again.
fun unpack<CoinType>(order: Order<CoinType>): (Balance<CoinType>, address, u64, ID, address) {
    let Order<CoinType> {
        id, maker, destination, funds, pool_id: _, min_out, expires_at_ms: _,
    } = order;
    let order_id = id.to_inner();
    object::delete(id);
    (funds, destination, min_out, order_id, maker)
}

// === Read-only accessors ===

public fun maker<CoinType>(order: &Order<CoinType>): address { order.maker }
public fun destination<CoinType>(order: &Order<CoinType>): address { order.destination }
public fun amount_in<CoinType>(order: &Order<CoinType>): u64 { order.funds.value() }
public fun min_out<CoinType>(order: &Order<CoinType>): u64 { order.min_out }
public fun pool_id<CoinType>(order: &Order<CoinType>): ID { order.pool_id }
public fun expires_at_ms<CoinType>(order: &Order<CoinType>): u64 { order.expires_at_ms }
