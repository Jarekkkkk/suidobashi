/// Boundary tests for `sui_tokyo::order`.
///
/// What these prove: escrow custody, the maker's validation, refund timing, and the
/// four settlement gates — non-agent, unallowed pool, substituted pool, expired.
///
/// What these CANNOT prove: that a settlement moves funds. `settle_*` takes a live
/// Cetus `Pool`, and the unit VM cannot construct one. The gates are reachable
/// without a pool because they take only IDs, which is why they are separated from
/// the swap — so the part that can be tested is tested, and the part that cannot is
/// exercised by a mainnet dry run instead.
#[test_only]
module sui_tokyo::order_tests;

use sui_tokyo::order;
use sui_tokyo::policy::{Self, Policy};
use sui_tokyo::spend_vault::{Self, OwnerCap};
use sui::clock::{Self, Clock};
use sui::coin;
use sui::test_scenario as ts;
use std::unit_test::assert_eq;

const MAKER: address = @0xA;
const AGENT: address = @0xB;
const STRANGER: address = @0xC;
const NOW_MS: u64 = 1_700_000_000_000;
const LATER_MS: u64 = NOW_MS + 86_400_000;

/// Distinct defining type, so nothing collides with the policy tests.
public struct OrderTestCoin has drop {}

fun pool_a(): ID { object::id_from_address(@0xF00D) }
fun pool_b(): ID { object::id_from_address(@0xBEEF) }

/// Create, set and SHARE a clock. Shared rather than returned because `Clock` has no
/// `drop`: a test that expects an abort cannot leave one live, and a returned one
/// would be exactly that. Callers take it back with `ts::take_shared`.
fun share_clock(s: &mut ts::Scenario, ms: u64) {
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(ms);
    clk.share_for_testing();
}

/// A policy whose agent is AGENT, with `pool` allowed.
fun setup_policy(s: &mut ts::Scenario, pool: ID): ID {
    let (v, oc) = spend_vault::new(s.ctx());
    let cap = spend_vault::mint_cap(&v, &oc, s.ctx());
    let policy_id = policy::create(&v, &oc, AGENT, MAKER, cap, s.ctx());
    spend_vault::share(v);
    transfer::public_transfer(oc, MAKER);

    // A separate transaction, because `create` shared the policy and a shared object
    // is not something the creating transaction keeps mutating.
    s.next_tx(MAKER);
    {
        let mut p = ts::take_shared_by_id<Policy>(s, policy_id);
        let oc2 = ts::take_from_address<OwnerCap>(s, MAKER);
        policy::set_pool_allowed(&mut p, &oc2, pool, true);
        ts::return_to_address(MAKER, oc2);
        ts::return_shared(p);
    };
    policy_id
}

// === creating ===

#[test]
fun create_escrows_the_coin_and_records_the_terms() {
    let mut s = ts::begin(MAKER);
    share_clock(&mut s, NOW_MS);

    s.next_tx(MAKER);
    let clk = ts::take_shared<Clock>(&s);
    let order_id = order::create<OrderTestCoin>(
        coin::mint_for_testing<OrderTestCoin>(1_000, s.ctx()),
        pool_a(), 900, LATER_MS, MAKER, &clk, s.ctx(),
    );
    ts::return_shared(clk);

    s.next_tx(MAKER);
    {
        let o = ts::take_shared_by_id<order::Order<OrderTestCoin>>(&s, order_id);
        assert_eq!(order::amount_in(&o), 1_000);
        assert_eq!(order::min_out(&o), 900);
        assert_eq!(order::maker(&o), MAKER);
        assert_eq!(order::destination(&o), MAKER);
        assert_eq!(order::pool_id(&o), pool_a());
        assert_eq!(order::expires_at_ms(&o), LATER_MS);
        ts::return_shared(o);
    };
    s.end();
}

/// A zero floor is not a commitment — it would let a settler deliver nothing.
#[test]
#[expected_failure(abort_code = order::EZeroMinOut)]
fun create_refuses_a_zero_minimum() {
    let mut s = ts::begin(MAKER);
    share_clock(&mut s, NOW_MS);

    s.next_tx(MAKER);
    let clk = ts::take_shared<Clock>(&s);
    order::create<OrderTestCoin>(
        coin::mint_for_testing<OrderTestCoin>(1_000, s.ctx()),
        pool_a(), 0, LATER_MS, MAKER, &clk, s.ctx(),
    );
    ts::return_shared(clk);   // unreachable: the call above aborts
    s.end();
}

/// An order created already expired could never be settled, only refunded.
#[test]
#[expected_failure(abort_code = order::EOrderExpired)]
fun create_refuses_an_already_expired_order() {
    let mut s = ts::begin(MAKER);
    share_clock(&mut s, NOW_MS);

    s.next_tx(MAKER);
    let clk = ts::take_shared<Clock>(&s);
    order::create<OrderTestCoin>(
        coin::mint_for_testing<OrderTestCoin>(1_000, s.ctx()),
        pool_a(), 900, NOW_MS, MAKER, &clk, s.ctx(),
    );
    ts::return_shared(clk);   // unreachable: the call above aborts
    s.end();
}

#[test]
#[expected_failure(abort_code = order::EZeroAmount)]
fun create_refuses_an_empty_escrow() {
    let mut s = ts::begin(MAKER);
    share_clock(&mut s, NOW_MS);

    s.next_tx(MAKER);
    let clk = ts::take_shared<Clock>(&s);
    order::create<OrderTestCoin>(
        coin::mint_for_testing<OrderTestCoin>(0, s.ctx()),
        pool_a(), 900, LATER_MS, MAKER, &clk, s.ctx(),
    );
    ts::return_shared(clk);   // unreachable: the call above aborts
    s.end();
}

// === refunding ===

#[test]
#[expected_failure(abort_code = order::ENotExpired)]
fun refund_before_expiry_aborts() {
    let mut s = ts::begin(MAKER);
    share_clock(&mut s, NOW_MS);

    s.next_tx(MAKER);
    let clk = ts::take_shared<Clock>(&s);
    let order_id = order::create<OrderTestCoin>(
        coin::mint_for_testing<OrderTestCoin>(1_000, s.ctx()),
        pool_a(), 900, LATER_MS, MAKER, &clk, s.ctx(),
    );
    ts::return_shared(clk);

    // still NOW_MS, so LATER_MS has not arrived
    s.next_tx(MAKER);
    let clk2 = ts::take_shared<Clock>(&s);
    let o = ts::take_shared_by_id<order::Order<OrderTestCoin>>(&s, order_id);
    order::refund(o, &clk2, s.ctx());
    ts::return_shared(clk2);
    s.end();
}

/// Anyone may trigger it, and the funds still go to the maker — so a stranger can
/// only help, which is the point.
#[test]
fun anyone_may_refund_after_expiry_and_the_maker_is_paid() {
    let mut s = ts::begin(MAKER);
    // ONE clock, advanced in place. `create` requires the clock to be BEFORE the
    // expiry and `refund` requires it to be AFTER, so a single fixed timestamp
    // cannot satisfy both -- and two Clock objects would be ambiguous to
    // `take_shared`.
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(NOW_MS);

    let order_id = order::create<OrderTestCoin>(
        coin::mint_for_testing<OrderTestCoin>(1_000, s.ctx()),
        pool_a(), 900, LATER_MS, MAKER, &clk, s.ctx(),
    );
    clk.set_for_testing(LATER_MS);   // time passes
    clk.share_for_testing();

    // A DIFFERENT caller, and the clock now past expiry.
    s.next_tx(STRANGER);
    let clk2 = ts::take_shared<Clock>(&s);
    let o = ts::take_shared_by_id<order::Order<OrderTestCoin>>(&s, order_id);
    order::refund(o, &clk2, s.ctx());
    ts::return_shared(clk2);
    s.end();
}

// === the settlement gates ===
//
// Reached through a test-only wrapper, because the real entry points need a live
// Pool. The gates take only IDs, so they are testable on their own — and the order
// they run in is part of the contract.

#[test]
fun a_valid_settlement_passes_every_gate() {
    let mut s = ts::begin(AGENT);
    share_clock(&mut s, NOW_MS);
    let policy_id = setup_policy(&mut s, pool_a());

    s.next_tx(AGENT);
    let clk = ts::take_shared<Clock>(&s);
    let p = ts::take_shared_by_id<Policy>(&s, policy_id);
    order::assert_settleable_for_testing(&p, pool_a(), pool_a(), LATER_MS, &clk, s.ctx());
    ts::return_shared(p);
    ts::return_shared(clk);
    s.end();
}

#[test]
#[expected_failure(abort_code = order::ENotAgent)]
fun a_non_agent_cannot_settle() {
    let mut s = ts::begin(AGENT);
    share_clock(&mut s, NOW_MS);
    let policy_id = setup_policy(&mut s, pool_a());

    s.next_tx(STRANGER);
    let clk = ts::take_shared<Clock>(&s);
    let p = ts::take_shared_by_id<Policy>(&s, policy_id);
    order::assert_settleable_for_testing(&p, pool_a(), pool_a(), LATER_MS, &clk, s.ctx());
    ts::return_shared(p);
    ts::return_shared(clk);
    s.end();
}

#[test]
#[expected_failure(abort_code = order::EPoolNotAllowed)]
fun a_pool_outside_the_allowlist_cannot_settle() {
    let mut s = ts::begin(AGENT);
    share_clock(&mut s, NOW_MS);
    let policy_id = setup_policy(&mut s, pool_a());

    s.next_tx(AGENT);
    let clk = ts::take_shared<Clock>(&s);
    let p = ts::take_shared_by_id<Policy>(&s, policy_id);
    order::assert_settleable_for_testing(&p, pool_b(), pool_b(), LATER_MS, &clk, s.ctx());
    ts::return_shared(p);
    ts::return_shared(clk);
    s.end();
}

/// The settler picks which Pool object to pass, so the order's own pool id has to be
/// checked. Without this a settler could swap against a pool the maker never named.
#[test]
#[expected_failure(abort_code = order::EWrongPool)]
fun a_substituted_pool_cannot_settle() {
    let mut s = ts::begin(AGENT);
    share_clock(&mut s, NOW_MS);
    let policy_id = setup_policy(&mut s, pool_a());

    // both pools allowed, so only the order's own id can catch this
    s.next_tx(MAKER);
    {
        let mut p = ts::take_shared_by_id<Policy>(&s, policy_id);
        let oc = ts::take_from_address<OwnerCap>(&s, MAKER);
        policy::set_pool_allowed(&mut p, &oc, pool_b(), true);
        ts::return_to_address(MAKER, oc);
        ts::return_shared(p);
    };

    s.next_tx(AGENT);
    let clk = ts::take_shared<Clock>(&s);
    let p = ts::take_shared_by_id<Policy>(&s, policy_id);
    // the order names pool_a, the settler passes pool_b
    order::assert_settleable_for_testing(&p, pool_a(), pool_b(), LATER_MS, &clk, s.ctx());
    ts::return_shared(p);
    ts::return_shared(clk);
    s.end();
}

#[test]
#[expected_failure(abort_code = order::EOrderExpired)]
fun an_expired_order_cannot_settle() {
    let mut s = ts::begin(AGENT);
    // the clock is already past the order's expiry
    share_clock(&mut s, LATER_MS + 1);
    let policy_id = setup_policy(&mut s, pool_a());

    s.next_tx(AGENT);
    let clk = ts::take_shared<Clock>(&s);
    let p = ts::take_shared_by_id<Policy>(&s, policy_id);
    order::assert_settleable_for_testing(&p, pool_a(), pool_a(), LATER_MS, &clk, s.ctx());
    ts::return_shared(p);
    ts::return_shared(clk);
    s.end();
}

// === the storage-reclaim path ===
//
// A settled order now STAYS on chain, so its storage can be reclaimed later. That
// means the marker and the burn both need testing, and the burn is what pays: the
// rebate goes to whoever signs it, which is why it is maker-gated.

/// A fresh order is not settled. `settled()` reads a dynamic field, because the
/// struct layout is frozen and a `settled` bool is not available.
#[test]
fun a_fresh_order_is_not_settled() {
    let mut s = ts::begin(MAKER);
    share_clock(&mut s, NOW_MS);

    s.next_tx(MAKER);
    let clk = ts::take_shared<Clock>(&s);
    let order_id = order::create<OrderTestCoin>(
        coin::mint_for_testing<OrderTestCoin>(1_000, s.ctx()),
        pool_a(), 900, LATER_MS, MAKER, &clk, s.ctx(),
    );
    ts::return_shared(clk);

    s.next_tx(MAKER);
    {
        let o = ts::take_shared_by_id<order::Order<OrderTestCoin>>(&s, order_id);
        assert!(!order::settled(&o));
        ts::return_shared(o);
    };
    s.end();
}

/// The marker is what stops a second settlement, so it has to actually stick.
#[test]
fun marking_an_order_settled_is_observable() {
    let mut s = ts::begin(MAKER);
    share_clock(&mut s, NOW_MS);

    s.next_tx(MAKER);
    let clk = ts::take_shared<Clock>(&s);
    let order_id = order::create<OrderTestCoin>(
        coin::mint_for_testing<OrderTestCoin>(1_000, s.ctx()),
        pool_a(), 900, LATER_MS, MAKER, &clk, s.ctx(),
    );
    ts::return_shared(clk);

    s.next_tx(MAKER);
    {
        let mut o = ts::take_shared_by_id<order::Order<OrderTestCoin>>(&s, order_id);
        order::mark_settled_for_testing(&mut o);
        assert!(order::settled(&o));
        ts::return_shared(o);
    };
    s.end();
}

/// Burning an order that was never filled would destroy escrowed funds.
#[test]
#[expected_failure(abort_code = order::ENotSettled)]
fun burning_an_unsettled_order_aborts() {
    let mut s = ts::begin(MAKER);
    share_clock(&mut s, NOW_MS);

    s.next_tx(MAKER);
    let clk = ts::take_shared<Clock>(&s);
    let order_id = order::create<OrderTestCoin>(
        coin::mint_for_testing<OrderTestCoin>(1_000, s.ctx()),
        pool_a(), 900, LATER_MS, MAKER, &clk, s.ctx(),
    );
    ts::return_shared(clk);

    s.next_tx(MAKER);
    let o = ts::take_shared_by_id<order::Order<OrderTestCoin>>(&s, order_id);
    order::burn(o, s.ctx());
    s.end();
}

/// The rebate goes to whoever signs, so this is the maker's and nobody else's.
#[test]
#[expected_failure(abort_code = order::ENotMaker)]
fun a_stranger_cannot_reclaim_the_storage() {
    let mut s = ts::begin(MAKER);
    share_clock(&mut s, NOW_MS);

    s.next_tx(MAKER);
    let clk = ts::take_shared<Clock>(&s);
    let order_id = order::create<OrderTestCoin>(
        coin::mint_for_testing<OrderTestCoin>(1_000, s.ctx()),
        pool_a(), 900, LATER_MS, MAKER, &clk, s.ctx(),
    );
    ts::return_shared(clk);

    s.next_tx(STRANGER);
    let o = ts::take_shared_by_id<order::Order<OrderTestCoin>>(&s, order_id);
    order::burn(o, s.ctx());
    s.end();
}

/// The happy path: marked, empty, and the maker reclaims it.
#[test]
fun the_maker_can_reclaim_a_settled_order() {
    let mut s = ts::begin(MAKER);
    share_clock(&mut s, NOW_MS);

    s.next_tx(MAKER);
    let clk = ts::take_shared<Clock>(&s);
    let order_id = order::create<OrderTestCoin>(
        coin::mint_for_testing<OrderTestCoin>(1_000, s.ctx()),
        pool_a(), 900, LATER_MS, MAKER, &clk, s.ctx(),
    );
    ts::return_shared(clk);

    // Marked and emptied, which is the state `settle_*` leaves behind.
    s.next_tx(MAKER);
    {
        let mut o = ts::take_shared_by_id<order::Order<OrderTestCoin>>(&s, order_id);
        order::mark_settled_for_testing(&mut o);
        ts::return_shared(o);
    };

    s.next_tx(MAKER);
    let o = ts::take_shared_by_id<order::Order<OrderTestCoin>>(&s, order_id);
    order::burn(o, s.ctx());
    s.end();
}
