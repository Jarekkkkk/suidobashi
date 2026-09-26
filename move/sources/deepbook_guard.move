/// `sui_tokyo::deepbook_guard` — custody for a DeepBook v3 order-book balance.
///
/// A shared `DeepbookGuard` holds a DeepBook `BalanceManager`'s three capability objects
/// and its id. Whoever the guard names as `agent` may trade against the bound pool; the
/// agent never holds a cap, so it cannot reach DeepBook except through this module. The
/// `maker` — the wallet that created the guard — keeps every path that moves capital.
///
/// Why this module exists at all, rather than handing the agent a `TradeCap`: a TradeCap
/// bounds which **functions** its holder may call, not how much or at what price. DeepBook's
/// delegation model therefore lets a delegated trader market-sell the entire balance. It
/// already gives away the "orders only, never withdrawal" half of the job — `DepositCap` and
/// `WithdrawCap` are separate capabilities — but it has no per-order size bound, no price
/// band, no cumulative budget, and no pause. Those live here, checked before any order is
/// forwarded.
///
/// Creation is permissionless: any wallet holding a BalanceManager and its three caps can
/// create a guard for any pool. No whitelist, no deploy per user. Holding the caps **is** the
/// permission — they are owned objects, and only their owner can hand them over.
///
/// The BalanceManager is shared rather than stored inside the guard, deliberately. That
/// keeps two exits open which do not run through this code, both of them DeepBook's own:
/// withdrawing as the BalanceManager's owner, which needs no capability at all, and
/// `revoke_trade_cap`, which takes only the cap's id. A bug in this module cannot trap
/// capital.
module sui_tokyo::deepbook_guard;

use deepbook::balance_manager::{BalanceManager, DepositCap, TradeCap, WithdrawCap};
use sui::event;

/// Shared custody wrapper over one DeepBook v3 `BalanceManager`.
///
/// The coin parameters are phantom: they exist so every order path is typed to its pool's
/// `Base`/`Quote` pair. The pool's identity is the recorded `pool_id`, asserted on each call.
public struct DeepbookGuard<phantom Base, phantom Quote> has key {
    id: UID,
    /// The wallet that created the guard — the only caller of the capital paths.
    maker: address,
    /// The only address allowed to call the order paths.
    agent: address,
    /// The market this guard is bound to. Checked on every order.
    pool_id: ID,
    /// The BalanceManager the guard acts for. Shared, so its owner keeps an exit.
    balance_manager_id: ID,
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

/// Create a guard. Permissionless.
///
/// The BalanceManager is taken by value and shared here, so it ends up independently
/// reachable — the maker's exit route. The three caps are taken by value and stored, so
/// after this call nothing outside this module holds them, and the agent has nothing to
/// hold at all.
///
/// The caller is recorded as `maker`, which is what makes this permissionless and safe at
/// once: no external gate is needed, because the only way to reach this function with usable
/// capabilities is to already own them.
public fun create<Base, Quote>(
    pool_id: ID,
    balance_manager: BalanceManager,
    deposit_cap: DepositCap,
    withdraw_cap: WithdrawCap,
    trade_cap: TradeCap,
    agent: address,
    ctx: &mut TxContext,
): ID {
    let balance_manager_id = object::id(&balance_manager);
    // `public_share_object`, not `share_object`: the BalanceManager is DeepBook's type, and
    // the private form is restricted to its own module. It has `store`, so this is the
    // permitted path — and sharing is what lets the agent's transaction reference a
    // BalanceManager it does not own.
    transfer::public_share_object(balance_manager);

    let guard = DeepbookGuard<Base, Quote> {
        id: object::new(ctx),
        maker: ctx.sender(),
        agent,
        pool_id,
        balance_manager_id,
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

public fun pool_id<Base, Quote>(guard: &DeepbookGuard<Base, Quote>): ID {
    guard.pool_id
}

public fun balance_manager_id<Base, Quote>(guard: &DeepbookGuard<Base, Quote>): ID {
    guard.balance_manager_id
}

/// The ids of the capabilities this guard holds.
///
/// Exposed so a maker can name the guard's `TradeCap` to DeepBook's `revoke_trade_cap`, which
/// is the kill switch that does not depend on this module. A stored object's id is otherwise
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
