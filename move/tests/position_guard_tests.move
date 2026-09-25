/// Boundary tests for `sui_tokyo::position_guard`.
///
/// What these prove: the caller gate, suspension, the owner-cap binding, that
/// authority follows the cap on transfer, and the tick-width bound that stops a
/// compromised agent choosing a ruinous range.
///
/// What these CANNOT prove: anything touching the position itself. Opening,
/// collecting, rebalancing and redeeming all need a live Cetus pool and a real
/// position, which the unit VM cannot construct — Cetus's test-only constructors
/// are not visible from a dependent package. Those paths need an on-chain run
/// against the pinned pool, exactly as the swap did.
#[test_only]
module sui_tokyo::position_guard_tests;

use sui_tokyo::spend_vault::{Self, OwnerCap};
use std::unit_test::assert_eq;
use sui::test_scenario as ts;
use sui_tokyo::position_guard::{Self, PositionGuard};

const OWNER: address = @0xA;
const AGENT: address = @0xB;
const THIEF: address = @0xC;
const NEW_OWNER: address = @0xD;

/// Distinct phantom types for the guard's two coin parameters.
public struct CoinA has drop {}
public struct CoinB has drop {}

/// A real vault and OwnerCap, so the binding check is exercised against the
/// actual OZ object rather than a mock.
fun setup(s: &mut ts::Scenario, agent: address, min_w: u32, max_w: u32): ID {
    let (v, oc) = spend_vault::new(s.ctx());
    let vault_id = object::id(&v);
    spend_vault::share(v);

    let guard_id = position_guard::create_for_testing<CoinA, CoinB>(
        vault_id, &oc, agent, OWNER, min_w, max_w, s.ctx(),
    );

    transfer::public_transfer(oc, OWNER);
    guard_id
}

// === Caller gate ===

#[test]
fun authorised_agent_passes_the_gate() {
    let mut s = ts::begin(OWNER);
    let _gid = setup(&mut s, AGENT, 10, 1000);

    s.next_tx(AGENT);
    {
        let g = ts::take_shared<PositionGuard<CoinA, CoinB>>(&s);
        position_guard::check_caller_for_testing(&g, s.ctx());
        assert_eq!(position_guard::agent(&g), AGENT);
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = position_guard::ENotAgent)]
fun non_agent_aborts() {
    let mut s = ts::begin(OWNER);
    let _gid = setup(&mut s, AGENT, 10, 1000);

    s.next_tx(THIEF);
    {
        let g = ts::take_shared<PositionGuard<CoinA, CoinB>>(&s);
        position_guard::check_caller_for_testing(&g, s.ctx());
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = position_guard::ESuspended)]
fun suspended_guard_refuses_the_agent() {
    let mut s = ts::begin(OWNER);
    let _gid = setup(&mut s, AGENT, 10, 1000);

    s.next_tx(OWNER);
    {
        let mut g = ts::take_shared<PositionGuard<CoinA, CoinB>>(&s);
        let oc = ts::take_from_address<OwnerCap>(&s, OWNER);
        position_guard::set_suspended(&mut g, &oc, true);
        assert!(position_guard::is_suspended(&g));
        ts::return_to_address(OWNER, oc);
        ts::return_shared(g);
    };

    s.next_tx(AGENT);
    {
        let g = ts::take_shared<PositionGuard<CoinA, CoinB>>(&s);
        position_guard::check_caller_for_testing(&g, s.ctx());
        ts::return_shared(g);
    };
    s.end();
}

// === Tick-width bound: the economic guardrail ===

#[test]
fun range_inside_bounds_passes() {
    let mut s = ts::begin(OWNER);
    let _gid = setup(&mut s, AGENT, 100, 1000);

    s.next_tx(AGENT);
    {
        let g = ts::take_shared<PositionGuard<CoinA, CoinB>>(&s);
        position_guard::check_range_for_testing(&g, 1000, 1400); // width 400
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = position_guard::ETickWidthOutOfBounds)]
fun range_too_narrow_aborts() {
    let mut s = ts::begin(OWNER);
    let _gid = setup(&mut s, AGENT, 100, 1000);

    s.next_tx(AGENT);
    {
        let g = ts::take_shared<PositionGuard<CoinA, CoinB>>(&s);
        position_guard::check_range_for_testing(&g, 1000, 1050); // width 50 < min
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = position_guard::ETickWidthOutOfBounds)]
fun range_too_wide_aborts() {
    let mut s = ts::begin(OWNER);
    let _gid = setup(&mut s, AGENT, 100, 1000);

    s.next_tx(AGENT);
    {
        let g = ts::take_shared<PositionGuard<CoinA, CoinB>>(&s);
        position_guard::check_range_for_testing(&g, 1000, 5000); // width 4000 > max
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = position_guard::ETickRangeInverted)]
fun inverted_range_aborts() {
    let mut s = ts::begin(OWNER);
    let _gid = setup(&mut s, AGENT, 100, 1000);

    s.next_tx(AGENT);
    {
        let g = ts::take_shared<PositionGuard<CoinA, CoinB>>(&s);
        position_guard::check_range_for_testing(&g, 2000, 1500);
        ts::return_shared(g);
    };
    s.end();
}

/// The bounds are the owner's knob: widening them is what lets the agent pick a
/// wider range, and the owner is the only one who can do it.
#[test]
fun owner_can_widen_bounds() {
    let mut s = ts::begin(OWNER);
    let _gid = setup(&mut s, AGENT, 100, 200);

    s.next_tx(OWNER);
    {
        let mut g = ts::take_shared<PositionGuard<CoinA, CoinB>>(&s);
        let oc = ts::take_from_address<OwnerCap>(&s, OWNER);
        position_guard::set_tick_bounds(&mut g, &oc, 100, 10_000);
        let (min_w, max_w) = position_guard::tick_bounds(&g);
        assert_eq!(min_w, 100);
        assert_eq!(max_w, 10_000);

        // The widened bound now admits a width the old one rejected.
        position_guard::check_range_for_testing(&g, 1000, 9000);

        ts::return_to_address(OWNER, oc);
        ts::return_shared(g);
    };
    s.end();
}

// === Cap-gated admin ===

#[test]
#[expected_failure(abort_code = position_guard::EWrongOwnerCap)]
fun foreign_vault_cap_cannot_admin() {
    let mut s = ts::begin(OWNER);
    let _gid = setup(&mut s, AGENT, 10, 1000);

    // A cap belonging to a different vault.
    let (other_v, foreign) = spend_vault::new(s.ctx());
    spend_vault::share(other_v);

    s.next_tx(OWNER);
    {
        let mut g = ts::take_shared<PositionGuard<CoinA, CoinB>>(&s);
        position_guard::set_agent(&mut g, &foreign, THIEF);
        ts::return_to_address(OWNER, foreign);
        ts::return_shared(g);
    };
    s.end();
}

/// Authority follows the cap: hand the OwnerCap over and the new holder admins
/// the guard. No stale stored owner to go wrong.
#[test]
fun authority_follows_the_owner_cap() {
    let mut s = ts::begin(OWNER);
    let _gid = setup(&mut s, AGENT, 10, 1000);

    s.next_tx(OWNER);
    {
        let oc = ts::take_from_address<OwnerCap>(&s, OWNER);
        transfer::public_transfer(oc, NEW_OWNER);
    };

    s.next_tx(NEW_OWNER);
    {
        let mut g = ts::take_shared<PositionGuard<CoinA, CoinB>>(&s);
        let oc = ts::take_from_address<OwnerCap>(&s, NEW_OWNER);

        position_guard::set_agent(&mut g, &oc, NEW_OWNER);
        position_guard::set_destination(&mut g, &oc, NEW_OWNER);

        assert_eq!(position_guard::agent(&g), NEW_OWNER);
        assert_eq!(position_guard::destination(&g), NEW_OWNER);

        ts::return_to_address(NEW_OWNER, oc);
        ts::return_shared(g);
    };
    s.end();
}
