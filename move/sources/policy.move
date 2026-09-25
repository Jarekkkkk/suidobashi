/// `sui_tokyo::policy` — the purpose gate.
///
/// Custodies an OpenZeppelin `SpenderCap` inside a shared `Policy` object and
/// exposes a deliberately tiny surface to an authorised agent. The cap is a
/// BEARER instrument per the OZ docs: whoever can present `&SpenderCap` to
/// `spend` exercises every budget that cap keys. So the cap never leaves this
/// module, and every function that touches it is sender-gated.
///
/// Authority model — one credential, no split brain:
///   * The holder of the vault's `OwnerCap` is the owner. Admin functions are
///     gated on that cap plus the vault-binding check, never on a stored
///     address. Since the `OwnerCap` already confers `withdraw_all` and
///     `destroy` over the vault, gating policy admin on it introduces no new
///     trust assumption, and transferring the cap transfers admin cleanly.
///   * `destination` is where value is routed. It is NOT an authority field —
///     it is a sink, settable only by the cap holder.
///   * `allowed_pools` constrains *which venue* the agent may trade against. A
///     pool the owner never approved is refused, which closes the
///     attacker-authored-pool vector: a hostile pool cannot be used to skim
///     value out of a legitimate swap.
///
/// Design rules enforced here:
///   1. No function returns the cap, or any borrow of it.
///   2. The agent-callable paths carry no recipient parameter. Value leaves only
///      to `destination`, so a leaked agent key cannot steal — the worst case is
///      moving the owner's own funds to the owner's own address while consuming
///      budget and gas.
///   3. Budgets, windows, and expiry live in the OZ ledger. This module adds only
///      routing, venue allowlisting, and authorisation — never a re-implementation
///      of limits.
module sui_tokyo::policy;

use cetus_clmm::config::GlobalConfig;
use cetus_clmm::pool::{Self as cetus_pool, Pool};
use sui_tokyo::spend_vault::{Self, OwnerCap, SpenderCap, Vault};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin;
use sui::dynamic_field;
use sui::dynamic_object_field;
use sui::event;
use sui::vec_set::{Self, VecSet};

#[error]
const ENotAgent: vector<u8> = "caller is not the authorised agent";
#[error]
const ESuspended: vector<u8> = "policy is suspended";
#[error]
const EWrongVault: vector<u8> = "vault does not match policy binding";
#[error]
const EWrongOwnerCap: vector<u8> = "OwnerCap does not match policy vault";
#[error]
const EPoolNotAllowed: vector<u8> = "pool is not on the policy allowlist";
#[error]
const ESlippageOutOfBound: vector<u8> = "the price limit moves the price further than this policy allows";
#[error]
const ESlippageTooLoose: vector<u8> = "slippage bound is above the ceiling this policy allows";

/// Ceiling on the owner's slippage bound, in basis points of PRICE. 500 bps is 5%,
/// already far looser than any sane swap, so this exists only to stop a
/// fat-fingered value from quietly switching the bound off.
const MAX_SLIPPAGE_BPS_CEILING: u64 = 500;

/// Dynamic-field key under which the slippage bound is stored.
///
/// A dynamic field rather than a `Policy` field, and that is forced: a compatible
/// upgrade cannot change an existing struct's layout, only add new structs and
/// functions. Anything the policy needs to carry from here on arrives this way.
public struct SlippageKey has copy, drop, store {}

/// Dynamic-object-field key under which the SpenderCap is embedded.
public struct CapKey has copy, drop, store {}

/// Shared purpose gate. Holds the cap; carries no budget of its own.
public struct Policy has key {
    id: UID,
    /// The OZ vault this policy spends from.
    vault_id: ID,
    /// Where routed value goes. A sink, not an authority.
    destination: address,
    /// The only address allowed to call the agent paths.
    agent: address,
    /// Owner-controlled kill switch, independent of the OZ ledger.
    suspended: bool,
    /// Venues the agent may trade against. Empty means no venue is approved.
    allowed_pools: VecSet<ID>,
    /// The embedded SpenderCap's object id. Stable across `set_allowance`.
    cap_id: ID,
}

/// Emitted on every successful routed spend.
public struct Routed has copy, drop {
    policy_id: ID,
    vault_id: ID,
    cap_id: ID,
    coin_type: vector<u8>,
    amount: u64,
    destination: address,
}

/// Emitted on every successful swap-and-route.
public struct Swapped has copy, drop {
    policy_id: ID,
    vault_id: ID,
    pool_id: ID,
    a2b: bool,
    amount_in: u64,
    amount_paid: u64,
    amount_out: u64,
    destination: address,
}

/// Emitted on any admin change.
public struct PolicyUpdated has copy, drop {
    policy_id: ID,
    destination: address,
    agent: address,
    suspended: bool,
}

/// Create the policy and embed `cap` in it. The cap is consumed by value, so no
/// caller can hold it afterwards. The venue allowlist starts empty — the owner
/// must approve pools explicitly.
///
/// Intended PTB: `spend_vault::mint_cap(vault, owner_cap)` then this. The vault
/// must be shared by the owner separately; the policy is shared here.
public fun create(
    vault: &Vault,
    owner_cap: &OwnerCap,
    agent: address,
    destination: address,
    cap: SpenderCap,
    ctx: &mut TxContext,
): ID {
    let vault_id = object::id(vault);
    assert!(spend_vault::owner_cap_vault_id(owner_cap) == vault_id, EWrongOwnerCap);
    assert!(spend_vault::spender_cap_vault_id(&cap) == vault_id, EWrongVault);

    let cap_id = object::id(&cap);
    let mut policy = Policy {
        id: object::new(ctx),
        vault_id,
        destination,
        agent,
        suspended: false,
        allowed_pools: vec_set::empty(),
        cap_id,
    };
    let policy_id = object::id(&policy);

    dynamic_object_field::add(&mut policy.id, CapKey {}, cap);
    transfer::share_object(policy);

    event::emit(PolicyUpdated {
        policy_id,
        destination,
        agent,
        suspended: false,
    });

    policy_id
}

// === Admin (OwnerCap holder) ===

/// Rotate the authorised agent.
public fun set_agent(policy: &mut Policy, owner_cap: &OwnerCap, new_agent: address) {
    assert_binding(policy, owner_cap);
    policy.agent = new_agent;
    emit_updated(policy);
}

/// Redirect routed value. A sink change, not a grant of authority — the agent
/// still cannot choose a destination per call.
public fun set_destination(policy: &mut Policy, owner_cap: &OwnerCap, new_destination: address) {
    assert_binding(policy, owner_cap);
    policy.destination = new_destination;
    emit_updated(policy);
}

/// Owner-controlled suspension, applied on top of the OZ budget.
public fun set_suspended(policy: &mut Policy, owner_cap: &OwnerCap, suspended: bool) {
    assert_binding(policy, owner_cap);
    policy.suspended = suspended;
    emit_updated(policy);
}

/// Approve or revoke a venue. The agent can only ever trade against pools the
/// owner has approved here.
public fun set_pool_allowed(policy: &mut Policy, owner_cap: &OwnerCap, pool_id: ID, allowed: bool) {
    assert_binding(policy, owner_cap);
    if (allowed) {
        // `vec_set::insert` aborts when the key is already present, so
        // re-allowlisting an allowed pool used to fail — which also made a hire
        // impossible to re-run. Checking first makes this idempotent, so calling
        // it twice is harmless rather than fatal.
        if (!policy.allowed_pools.contains(&pool_id)) {
            policy.allowed_pools.insert(pool_id);
        };
    } else {
        // `vec_set::remove` aborts with `EKeyDoesNotExist` when the key is
        // absent in this framework version — it does *not* return a bool. So
        // revoking twice failed too, and both directions needed guarding.
        if (policy.allowed_pools.contains(&pool_id)) {
            policy.allowed_pools.remove(&pool_id);
        };
    };
    emit_updated(policy);
}

/// Set the bound on how far a swap may move the price, in basis points of PRICE.
///
/// Owner-gated, and an upsert. Three states, deliberately distinct:
///
///   absent   no bound. This is how a live policy starts, so introducing the bound
///            changes nothing until the owner opts in.
///   `0`      the bound is explicitly off. A deliberate act, not a default.
///   `n > 0`  the price may move at most `n` basis points in either direction.
///
/// The ceiling is not a policy decision, it is a guard against a typo: without it,
/// `10_000` would mean "no limit" while looking like a number someone chose.
public fun set_max_slippage_bps(policy: &mut Policy, owner_cap: &OwnerCap, bps: u64) {
    assert_binding(policy, owner_cap);
    assert!(bps <= MAX_SLIPPAGE_BPS_CEILING, ESlippageTooLoose);

    if (dynamic_field::exists(&policy.id, SlippageKey {})) {
        let slot = dynamic_field::borrow_mut<SlippageKey, u64>(&mut policy.id, SlippageKey {});
        *slot = bps;
    } else {
        dynamic_field::add(&mut policy.id, SlippageKey {}, bps);
    };

    emit_updated(policy);
}

// === Agent paths ===

/// Draw `amount` of `C` from the OZ budget behind the embedded cap and send the
/// proceeds to `policy.destination`. No venue involved — the unswapped shape of
/// the flow, useful for testing the money path in isolation.
public fun spend_to_destination<C>(
    policy: &mut Policy,
    vault: &mut Vault,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_agent_gates(policy, vault, ctx);

    let destination = policy.destination;
    let cap = dynamic_object_field::borrow<CapKey, SpenderCap>(&policy.id, CapKey {});
    let funds: Balance<C> = spend_vault::spend<C>(vault, cap, amount, clock, ctx);

    transfer::public_transfer(coin::from_balance(funds, ctx), destination);

    event::emit(Routed {
        policy_id: object::id(policy),
        vault_id: policy.vault_id,
        cap_id: policy.cap_id,
        coin_type: std::type_name::into_string(
            std::type_name::with_defining_ids<C>(),
        ).into_bytes(),
        amount,
        destination,
    });
}

/// Swap against an allowlisted Cetus CLMM pool and route both the output and any
/// unspent input to `policy.destination`.
///
/// Cetus's CLMM exposes a flash swap, not a plain swap: output is delivered up
/// front and the input is repaid afterwards, with the receipt forcing repayment
/// in the same transaction (it has no `drop`). Repayment asserts EXACT equality
/// against `pay_amount`, so the input is split to exactly that figure and the
/// remainder is routed on rather than being left behind or over-paid.
///
/// The caller supplies only strategy parameters — pool, direction, amount, and a
/// price limit. It cannot choose where value goes.
public fun swap_and_route<A, B>(
    policy: &mut Policy,
    vault: &mut Vault,
    config: &GlobalConfig,
    pool: &mut Pool<A, B>,
    a2b: bool,
    amount: u64,
    sqrt_price_limit: u128,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_agent_gates(policy, vault, ctx);
    assert!(policy.allowed_pools.contains(&object::id(pool)), EPoolNotAllowed);
    // The caller supplies `sqrt_price_limit`, so without this the agent chooses its
    // own price tolerance. It is the one term of the trade the policy could not
    // previously bound: who, where, how much and where-to were all enforced, and the
    // rate was not. A bounded pool is the difference between a hostile agent wasting
    // gas and a hostile agent extracting value at a price of its choosing.
    assert_slippage_in_bound(policy, pool, sqrt_price_limit);

    let destination = policy.destination;
    let cap = dynamic_object_field::borrow<CapKey, SpenderCap>(&policy.id, CapKey {});

    let (amount_paid, amount_out) = if (a2b) {
        swap_a2b<A, B>(
            vault, cap, config, pool, amount, sqrt_price_limit, clock, destination, ctx,
        )
    } else {
        swap_b2a<A, B>(
            vault, cap, config, pool, amount, sqrt_price_limit, clock, destination, ctx,
        )
    };

    event::emit(Swapped {
        policy_id: object::id(policy),
        vault_id: policy.vault_id,
        pool_id: object::id(pool),
        a2b,
        amount_in: amount,
        amount_paid,
        amount_out,
        destination,
    });
}

// === Internals ===

/// A -> B. Pool returns `(zero<A>, output<B>)`; we owe A. Returns
/// `(amount_paid, amount_out)` for the audit event.
fun swap_a2b<A, B>(
    vault: &mut Vault,
    cap: &SpenderCap,
    config: &GlobalConfig,
    pool: &mut Pool<A, B>,
    amount: u64,
    sqrt_price_limit: u128,
    clock: &Clock,
    destination: address,
    ctx: &mut TxContext,
): (u64, u64) {
    let (zero_a, out_b, receipt) =
        cetus_pool::flash_swap<A, B>(config, pool, true, true, amount, sqrt_price_limit, clock);
    let pay_amount = cetus_pool::swap_pay_amount(&receipt);
    let out_amount = out_b.value();

    let mut input: Balance<A> = spend_vault::spend<A>(vault, cap, amount, clock, ctx);
    let pay = input.split(pay_amount);
    balance::destroy_zero(zero_a);

    cetus_pool::repay_flash_swap<A, B>(config, pool, pay, balance::zero<B>(), receipt);

    // Whatever was not consumed by the repayment goes back to the sink, so no
    // input is ever stranded in this module.
    transfer::public_transfer(coin::from_balance(input, ctx), destination);
    transfer::public_transfer(coin::from_balance(out_b, ctx), destination);

    (pay_amount, out_amount)
}

/// B -> A. Pool returns `(output<A>, zero<B>)`; we owe B. Returns
/// `(amount_paid, amount_out)` for the audit event.
fun swap_b2a<A, B>(
    vault: &mut Vault,
    cap: &SpenderCap,
    config: &GlobalConfig,
    pool: &mut Pool<A, B>,
    amount: u64,
    sqrt_price_limit: u128,
    clock: &Clock,
    destination: address,
    ctx: &mut TxContext,
): (u64, u64) {
    let (out_a, zero_b, receipt) =
        cetus_pool::flash_swap<A, B>(config, pool, false, true, amount, sqrt_price_limit, clock);
    let pay_amount = cetus_pool::swap_pay_amount(&receipt);
    let out_amount = out_a.value();

    let mut input: Balance<B> = spend_vault::spend<B>(vault, cap, amount, clock, ctx);
    let pay = input.split(pay_amount);
    balance::destroy_zero(zero_b);

    cetus_pool::repay_flash_swap<A, B>(config, pool, balance::zero<A>(), pay, receipt);

    transfer::public_transfer(coin::from_balance(input, ctx), destination);
    transfer::public_transfer(coin::from_balance(out_a, ctx), destination);

    (pay_amount, out_amount)
}

/// The gates every agent path shares.
fun assert_agent_gates(policy: &Policy, vault: &Vault, ctx: &TxContext) {
    assert!(ctx.sender() == policy.agent, ENotAgent);
    assert!(!policy.suspended, ESuspended);
    assert!(object::id(vault) == policy.vault_id, EWrongVault);
}

/// Bound how far a swap may move the price.
///
/// The pool quotes price as a square root and the limit arrives in that same unit,
/// so this squares both sides rather than converting either one. That is exact, and
/// it avoids tick arithmetic entirely -- which matters, because the tick helpers all
/// speak `integer_mate::i32`, a TRANSITIVE dependency this package cannot name.
/// `u256` is required because the square of a `u128` sqrt price overflows `u128`:
/// the maximum is about 7.9e28 and its square is 6.2e57.
///
/// Never set means unbounded, so adding this changes no existing policy's behaviour.
fun assert_slippage_in_bound<A, B>(
    policy: &Policy,
    pool: &Pool<A, B>,
    sqrt_price_limit: u128,
) {
    if (!dynamic_field::exists(&policy.id, SlippageKey {})) return;
    let bps = *dynamic_field::borrow<SlippageKey, u64>(&policy.id, SlippageKey {});
    if (bps == 0) return;

    assert_within_bps(cetus_pool::current_sqrt_price(pool), sqrt_price_limit, bps);
}

/// The arithmetic, separated from the state lookup so it can be tested directly.
/// Testing it through `swap_and_route` would need a live Cetus pool; this needs two
/// numbers, and the arithmetic is the part that can actually be wrong.
///
/// price is proportional to sqrt_price squared, so comparing squares compares prices,
/// and the bound stays in basis points of PRICE rather than of its root.
fun assert_within_bps(now_sqrt: u128, limit_sqrt: u128, bps: u64) {
    let now_sq: u256 = (now_sqrt as u256) * (now_sqrt as u256);
    let limit_sq: u256 = (limit_sqrt as u256) * (limit_sqrt as u256);

    let diff: u256 = if (limit_sq > now_sq) { limit_sq - now_sq } else { now_sq - limit_sq };

    // diff / now <= bps / 10_000, cross-multiplied so no division is needed.
    assert!(diff * 10_000 <= now_sq * (bps as u256), ESlippageOutOfBound);
}

#[test_only]
public fun assert_within_bps_for_testing(now_sqrt: u128, limit_sqrt: u128, bps: u64) {
    assert_within_bps(now_sqrt, limit_sqrt, bps)
}

/// The single admin gate: the presented OwnerCap must belong to this vault.
fun assert_binding(policy: &Policy, owner_cap: &OwnerCap) {
    assert!(
        spend_vault::owner_cap_vault_id(owner_cap) == policy.vault_id,
        EWrongOwnerCap,
    );
}

fun emit_updated(policy: &Policy) {
    event::emit(PolicyUpdated {
        policy_id: object::id(policy),
        destination: policy.destination,
        agent: policy.agent,
        suspended: policy.suspended,
    });
}

// === Read-only accessors ===

/// The embedded cap's id — pass this to `spend_vault::set_allowance`.
public fun cap_id(policy: &Policy): ID { policy.cap_id }

public fun vault_id(policy: &Policy): ID { policy.vault_id }

public fun destination(policy: &Policy): address { policy.destination }

public fun agent(policy: &Policy): address { policy.agent }

public fun is_suspended(policy: &Policy): bool { policy.suspended }

public fun is_pool_allowed(policy: &Policy, pool_id: ID): bool {
    policy.allowed_pools.contains(&pool_id)
}

/// The slippage bound in basis points, or `none` if it was never set. `some(0)`
/// means explicitly disabled -- the two are different states, and the difference is
/// whether anyone decided anything.
public fun max_slippage_bps(policy: &Policy): Option<u64> {
    if (dynamic_field::exists(&policy.id, SlippageKey {})) {
        option::some(*dynamic_field::borrow<SlippageKey, u64>(&policy.id, SlippageKey {}))
    } else {
        option::none()
    }
}
