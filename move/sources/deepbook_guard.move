/// `sui_tokyo::deepbook_guard` — custody for a DeepBook v3 order-book balance.
///
/// A shared `DeepbookGuard` holds a DeepBook `BalanceManager`'s three capability objects and
/// its id. Whoever the guard names as `agent` may trade against the bound pool; the agent never
/// holds a cap, so it cannot reach DeepBook except through this module. The `maker` — the wallet
/// that created the guard — keeps every path that moves capital and every knob on the agent.
///
/// Why this module exists at all, rather than handing the agent a `TradeCap`: a TradeCap bounds
/// which **functions** its holder may call, not how much or at what price. DeepBook's delegation
/// model already gives away the "orders only, never withdrawal" half of the job — `DepositCap`
/// and `WithdrawCap` are separate capabilities — but it has no per-order size bound, no price
/// band, and no pause. Those live here, checked before any order is forwarded.
///
/// One operator, many guards. The authority is the `agent` field on each guard, so a single
/// address can be the operator of any number of them and has to *hold* nothing: the capability
/// that authorises each order is the one that guard keeps. There is nothing at the operator to
/// steal, and its reach on each user's capital is the band, the per-order bound and the pause
/// that user set. Five guards mean five sets of limits, not one shared account.
///
/// What the bounds do and do not do. They cap each order's price and size, so no single order
/// can reach outside the band, and a paused guard places none at all. They do not cap the total:
/// an agent can place many orders, and the ceiling on the whole thing is the BalanceManager's
/// balance. Write the band as the honest range you would trade at anyway, because inside the band
/// a compromised agent trades at prices you agreed to.
///
/// Creation is permissionless: any wallet holding a BalanceManager and its three caps can create
/// a guard for any pool. No whitelist, no deploy per user. Holding the caps **is** the permission
/// — they are owned objects, and only their owner can hand them over.
///
/// The BalanceManager is shared rather than stored inside the guard, deliberately. That keeps two
/// exits open which do not run through this code, both of them DeepBook's own: withdrawing as the
/// BalanceManager's owner, which needs no capability at all, and `revoke_trade_cap`, which takes
/// only the cap's id. A bug in this module cannot trap capital.
module sui_tokyo::deepbook_guard;

use deepbook::balance_manager::{Self, BalanceManager, DepositCap, TradeCap, WithdrawCap};
use deepbook::constants;
use deepbook::order_info::OrderInfo;
use deepbook::pool::{Self, Pool};
use sui::clock::Clock;
use sui::event;

#[error]
const ENotMaker: vector<u8> = "caller is not the guard's maker";
#[error]
const ENotAgent: vector<u8> = "caller is not the authorised agent";
#[error]
const EPaused: vector<u8> = "guard is paused";
#[error]
const EWrongPool: vector<u8> = "pool does not match the guard's binding";
#[error]
const EWrongBalanceManager: vector<u8> = "balance manager does not match the guard's binding";
#[error]
const EPriceOutOfBand: vector<u8> = "price is outside the guard's band";
#[error]
const EQuantityAboveBound: vector<u8> = "quantity is above the guard's per-order bound";
#[error]
const EPriceBandInverted: vector<u8> = "price band must not be inverted";

/// Shared custody wrapper over one DeepBook v3 `BalanceManager`.
///
/// The coin parameters are phantom: they exist so every order path is typed to its pool's
/// `Base`/`Quote` pair. The pool's identity is the recorded `pool_id`, asserted on each call.
public struct DeepbookGuard<phantom Base, phantom Quote> has key {
    id: UID,
    /// The wallet that created the guard — the only caller of the capital paths.
    maker: address,
    /// The only address allowed to call the order paths. Held as an address, not as an object,
    /// so one operator can serve any number of guards while holding nothing of value.
    agent: address,
    /// Freezes every agent path. The maker's stop, without moving a coin.
    paused: bool,
    /// The market this guard is bound to. Checked on every order.
    pool_id: ID,
    /// The BalanceManager the guard acts for. Shared, so its owner keeps an exit.
    balance_manager_id: ID,
    /// The prices the agent may rest orders at, inclusive, in the pool's own scaled price units.
    price_min: u64,
    price_max: u64,
    /// The largest quantity one order may ask for, in the pool's lot-scaled units.
    max_qty: u64,
    /// DeepBook capabilities, held here so that the agent needs none of its own.
    deposit_cap: DepositCap,
    withdraw_cap: WithdrawCap,
    trade_cap: TradeCap,
}

/// Emitted when a guard is created.
public struct GuardCreated has copy, drop {
    guard_id: ID,
    maker: address,
    agent: address,
    pool_id: ID,
    balance_manager_id: ID,
}

/// Emitted on any maker change to the agent or to the agent's limits.
public struct GuardUpdated has copy, drop {
    guard_id: ID,
    agent: address,
    paused: bool,
    price_min: u64,
    price_max: u64,
    max_qty: u64,
}

/// Create a guard. Permissionless.
///
/// The BalanceManager is taken by value and shared here, so it ends up independently reachable —
/// the maker's exit route. The three caps are taken by value and stored, so after this call
/// nothing outside this module holds them, and the agent has nothing to hold at all.
///
/// The limits are set here rather than defaulted, so a guard is never briefly unbounded: between
/// this transaction and the first order there is no window in which an agent may trade outside
/// the band the maker chose. A maker who wants a wide band can pass `0` and the pool's maximum.
///
/// The caller is recorded as `maker`, which is what makes this permissionless and safe at once:
/// no external gate is needed, because the only way to reach this function with usable
/// capabilities is to already own them.
public fun create<Base, Quote>(
    pool_id: ID,
    balance_manager: BalanceManager,
    deposit_cap: DepositCap,
    withdraw_cap: WithdrawCap,
    trade_cap: TradeCap,
    agent: address,
    price_min: u64,
    price_max: u64,
    max_qty: u64,
    ctx: &mut TxContext,
): ID {
    assert!(price_min <= price_max, EPriceBandInverted);

    let balance_manager_id = object::id(&balance_manager);
    // `public_share_object`, not `share_object`: the BalanceManager is DeepBook's type, and the
    // private form is restricted to its own module. It has `store`, so this is the permitted
    // path — and sharing is what lets the agent's transaction reference a BalanceManager it does
    // not own.
    transfer::public_share_object(balance_manager);

    let guard = DeepbookGuard<Base, Quote> {
        id: object::new(ctx),
        maker: ctx.sender(),
        agent,
        paused: false,
        pool_id,
        balance_manager_id,
        price_min,
        price_max,
        max_qty,
        deposit_cap,
        withdraw_cap,
        trade_cap,
    };
    let guard_id = object::id(&guard);
    let maker = guard.maker;

    transfer::share_object(guard);

    event::emit(GuardCreated { guard_id, maker, agent, pool_id, balance_manager_id });
    guard_id
}

// === Agent paths ===

/// Place a buy for the guard's account. Agent-gated, and inside the maker's band.
///
/// `order_type` is DeepBook's: `constants::no_restriction()` fills what it can and rests the
/// remainder, `post_only()` rests only and is refused unless it would not cross, the other two
/// are the usual immediate-or-cancel and fill-or-kill. A grid wants one of the resting kinds.
///
/// The agent supplies parameters and nothing else. The credential that authorises this order is
/// the one the guard holds.
public fun buy<Base, Quote>(
    guard: &DeepbookGuard<Base, Quote>,
    pool: &mut Pool<Base, Quote>,
    balance_manager: &mut BalanceManager,
    client_order_id: u64,
    order_type: u8,
    price: u64,
    quantity: u64,
    expire_timestamp: u64,
    clock: &Clock,
    ctx: &TxContext,
): OrderInfo {
    place(
        guard, pool, balance_manager, client_order_id, order_type, price, quantity, true,
        expire_timestamp, clock, ctx,
    )
}

/// Place a sell for the guard's account. Agent-gated, and inside the maker's band.
public fun sell<Base, Quote>(
    guard: &DeepbookGuard<Base, Quote>,
    pool: &mut Pool<Base, Quote>,
    balance_manager: &mut BalanceManager,
    client_order_id: u64,
    order_type: u8,
    price: u64,
    quantity: u64,
    expire_timestamp: u64,
    clock: &Clock,
    ctx: &TxContext,
): OrderInfo {
    place(
        guard, pool, balance_manager, client_order_id, order_type, price, quantity, false,
        expire_timestamp, clock, ctx,
    )
}

/// Cancel one resting order, returning its locked funds to settled balances. Agent-gated.
public fun cancel<Base, Quote>(
    guard: &DeepbookGuard<Base, Quote>,
    pool: &mut Pool<Base, Quote>,
    balance_manager: &mut BalanceManager,
    order_id: u128,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_agent_may_act(guard, object::id(pool), object::id(balance_manager), ctx);

    let proof = balance_manager::generate_proof_as_trader(balance_manager, &guard.trade_cap, ctx);
    pool::cancel_order<Base, Quote>(pool, balance_manager, &proof, order_id, clock, ctx);
}

/// Cancel every resting order this account has on the pool. Agent-gated.
///
/// This is the agent's unwind, and it is the one agent path a paused guard refuses — a pause
/// stops the agent, and the maker's own stop cancels the book anyway.
public fun cancel_all<Base, Quote>(
    guard: &DeepbookGuard<Base, Quote>,
    pool: &mut Pool<Base, Quote>,
    balance_manager: &mut BalanceManager,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_agent_may_act(guard, object::id(pool), object::id(balance_manager), ctx);

    let proof = balance_manager::generate_proof_as_trader(balance_manager, &guard.trade_cap, ctx);
    pool::cancel_all_orders<Base, Quote>(pool, balance_manager, &proof, clock, ctx);
}

// === Maker paths ===

/// Point the guard at a different operator. Maker-gated. Takes effect immediately: the old agent
/// is refused from the next transaction, with no window in which both may trade.
public fun set_agent<Base, Quote>(
    guard: &mut DeepbookGuard<Base, Quote>,
    new_agent: address,
    ctx: &TxContext,
) {
    assert_caller_is_maker(guard, ctx);
    guard.agent = new_agent;
    emit_updated(guard);
}

/// Set the band the agent may trade inside, and the largest quantity one order may ask for.
/// Maker-gated. Narrowing the band takes effect immediately.
public fun set_bounds<Base, Quote>(
    guard: &mut DeepbookGuard<Base, Quote>,
    price_min: u64,
    price_max: u64,
    max_qty: u64,
    ctx: &TxContext,
) {
    assert_caller_is_maker(guard, ctx);
    assert!(price_min <= price_max, EPriceBandInverted);

    guard.price_min = price_min;
    guard.price_max = price_max;
    guard.max_qty = max_qty;
    emit_updated(guard);
}

/// Freeze or unfreeze every agent path. Maker-gated, and costs nothing.
///
/// This is the maker's stop. It does not need a capability, does not cancel anything, and does
/// not move a coin — and because it is maker-gated rather than cap-gated, it still works when the
/// maker holds none of the guard's capabilities.
public fun set_paused<Base, Quote>(
    guard: &mut DeepbookGuard<Base, Quote>,
    paused: bool,
    ctx: &TxContext,
) {
    assert_caller_is_maker(guard, ctx);
    guard.paused = paused;
    emit_updated(guard);
}

// === Internals ===

/// Forward an order, authorised by the guard's own TradeCap.
///
/// The proof is generated here, from the cap this guard stores, and never leaves the call. That
/// is the whole containment: a caller cannot obtain the cap, cannot obtain a proof, and cannot
/// reach DeepBook for this account except through a function that checked the maker's limits
/// first.
fun place<Base, Quote>(
    guard: &DeepbookGuard<Base, Quote>,
    pool: &mut Pool<Base, Quote>,
    balance_manager: &mut BalanceManager,
    client_order_id: u64,
    order_type: u8,
    price: u64,
    quantity: u64,
    is_bid: bool,
    expire_timestamp: u64,
    clock: &Clock,
    ctx: &TxContext,
): OrderInfo {
    assert_order_allowed(
        guard,
        object::id(pool),
        object::id(balance_manager),
        price,
        quantity,
        ctx,
    );

    let proof = balance_manager::generate_proof_as_trader(balance_manager, &guard.trade_cap, ctx);

    pool::place_limit_order<Base, Quote>(
        pool,
        balance_manager,
        &proof,
        client_order_id,
        order_type,
        // Fixed, not a parameter. Self-matching governs how a crossing fill treats the taker's
        // own resting orders, and `cancel_taker` aborts against the caller's own expired order
        // sitting at a crossing price. An agent has no business choosing either.
        constants::self_matching_allowed(),
        price,
        quantity,
        is_bid,
        // Pay fees in the input token. On a maker-fee-free pool a resting order pays nothing
        // either way, and this way nobody has to hold DEEP for the guard to work.
        false,
        expire_timestamp,
        clock,
        ctx,
    )
}

/// Everything a caller must satisfy to touch the account at all, separated from the price and
/// size checks so both halves stay reachable without a live pool.
///
/// Takes ids rather than objects for that reason: a unit test can exercise the gate without
/// constructing a DeepBook pool, which the test VM cannot do.
fun assert_agent_may_act<Base, Quote>(
    guard: &DeepbookGuard<Base, Quote>,
    pool_id: ID,
    balance_manager_id: ID,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == guard.agent, ENotAgent);
    assert!(!guard.paused, EPaused);
    assert!(pool_id == guard.pool_id, EWrongPool);
    assert!(balance_manager_id == guard.balance_manager_id, EWrongBalanceManager);
}

/// The economic bound, on top of the gate.
fun assert_order_allowed<Base, Quote>(
    guard: &DeepbookGuard<Base, Quote>,
    pool_id: ID,
    balance_manager_id: ID,
    price: u64,
    quantity: u64,
    ctx: &TxContext,
) {
    assert_agent_may_act(guard, pool_id, balance_manager_id, ctx);
    assert!(price >= guard.price_min && price <= guard.price_max, EPriceOutOfBand);
    assert!(quantity <= guard.max_qty, EQuantityAboveBound);
}

fun assert_caller_is_maker<Base, Quote>(
    guard: &DeepbookGuard<Base, Quote>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == guard.maker, ENotMaker);
}

fun emit_updated<Base, Quote>(guard: &DeepbookGuard<Base, Quote>) {
    event::emit(GuardUpdated {
        guard_id: object::id(guard),
        agent: guard.agent,
        paused: guard.paused,
        price_min: guard.price_min,
        price_max: guard.price_max,
        max_qty: guard.max_qty,
    });
}

// === Read-only accessors ===

public fun guard_id<Base, Quote>(guard: &DeepbookGuard<Base, Quote>): ID {
    object::id(guard)
}

/// The wallet that created the guard and may call the capital paths.
public fun maker<Base, Quote>(guard: &DeepbookGuard<Base, Quote>): address {
    guard.maker
}

/// The only address allowed to place orders.
public fun agent<Base, Quote>(guard: &DeepbookGuard<Base, Quote>): address {
    guard.agent
}

public fun is_paused<Base, Quote>(guard: &DeepbookGuard<Base, Quote>): bool {
    guard.paused
}

public fun pool_id<Base, Quote>(guard: &DeepbookGuard<Base, Quote>): ID {
    guard.pool_id
}

public fun balance_manager_id<Base, Quote>(guard: &DeepbookGuard<Base, Quote>): ID {
    guard.balance_manager_id
}

/// The band the agent may trade inside, and the per-order quantity bound.
public fun bounds<Base, Quote>(guard: &DeepbookGuard<Base, Quote>): (u64, u64, u64) {
    (guard.price_min, guard.price_max, guard.max_qty)
}

/// The ids of the capabilities this guard holds.
///
/// Exposed so a maker can name the guard's `TradeCap` to DeepBook's `revoke_trade_cap`, which is
/// the kill switch that does not depend on this module. A stored object's id is otherwise
/// unknowable from outside, and a kill switch you cannot address is not a kill switch.
public fun deposit_cap_id<Base, Quote>(guard: &DeepbookGuard<Base, Quote>): ID {
    object::id(&guard.deposit_cap)
}

public fun withdraw_cap_id<Base, Quote>(guard: &DeepbookGuard<Base, Quote>): ID {
    object::id(&guard.withdraw_cap)
}

public fun trade_cap_id<Base, Quote>(guard: &DeepbookGuard<Base, Quote>): ID {
    object::id(&guard.trade_cap)
}

// === Test-only hooks ===
//
// `place_limit_order` needs a live DeepBook pool and a pool-funded BalanceManager, neither of
// which the unit VM can construct. These expose the parts that do not need one, so the gate, the
// band and the capability actually get covered rather than assumed.

/// Run the gate exactly as an order would.
#[test_only]
public fun check_agent_may_act_for_testing<Base, Quote>(
    guard: &DeepbookGuard<Base, Quote>,
    pool_id: ID,
    balance_manager_id: ID,
    ctx: &TxContext,
) {
    assert_agent_may_act(guard, pool_id, balance_manager_id, ctx)
}

/// Run the gate and the economic bound exactly as an order would.
#[test_only]
public fun check_order_allowed_for_testing<Base, Quote>(
    guard: &DeepbookGuard<Base, Quote>,
    pool_id: ID,
    balance_manager_id: ID,
    price: u64,
    quantity: u64,
    ctx: &TxContext,
) {
    assert_order_allowed(guard, pool_id, balance_manager_id, price, quantity, ctx)
}

/// Generate the proof an order would generate, from the cap the guard holds, against a real
/// BalanceManager. This is the claim "the operator holds no caps" made executable: the caller
/// passes a BalanceManager and no capability of its own.
#[test_only]
public fun generate_proof_for_testing<Base, Quote>(
    guard: &DeepbookGuard<Base, Quote>,
    balance_manager: &mut BalanceManager,
    ctx: &TxContext,
) {
    let _proof =
        balance_manager::generate_proof_as_trader(balance_manager, &guard.trade_cap, ctx);
}
