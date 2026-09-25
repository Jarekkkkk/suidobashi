/// Boundary tests for `sui_tokyo::policy`.
///
/// What these prove: cap custody, sender gating, suspension, budget enforcement
/// from the OZ ledger, cap-holder-gated admin, vault binding, and that authority
/// follows the OwnerCap when it moves.
///
/// What these CANNOT prove: that funds actually move. Per the OZ test notes, the
/// unit VM does not model the funds accumulator (object-owned address balances),
/// so a withdraw "succeeds" without moving funds and pool-short behaviour is not
/// reachable here. Fund delivery must be verified on-chain with a dry run.
#[test_only]
module sui_tokyo::policy_tests;

use sui_tokyo::spend_vault::{Self, OwnerCap, Vault};
use std::unit_test::assert_eq;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::test_scenario as ts;
use sui_tokyo::policy;

const OWNER: address = @0xA;
const AGENT: address = @0xB;
const THIEF: address = @0xC;
const NEW_OWNER: address = @0xD;
const MAX_U64: u64 = 18_446_744_073_709_551_615;
const NOW_MS: u64 = 1_700_000_000_000;

/// Distinct defining type so the OZ budget key is ours alone.
public struct TestCoin has drop {}

/// Vault + funded + granted budget + a policy embedding the cap.
/// Runs in the caller's current scenario tx. Returns (vault_id, policy_id).
fun setup(s: &mut ts::Scenario, funds: u64, budget: u64): (ID, ID) {
    let (vault_id, policy_id, oc) = setup_returning_cap(s, funds, budget);
    transfer::public_transfer(oc, OWNER);
    (vault_id, policy_id)
}

/// Same, but hands the OwnerCap back so a test can move it itself.
fun setup_returning_cap(
    s: &mut ts::Scenario,
    funds: u64,
    budget: u64,
): (ID, ID, OwnerCap) {
    let (mut v, oc) = spend_vault::new(s.ctx());
    let vault_id = object::id(&v);

    if (funds > 0) {
        spend_vault::deposit<TestCoin>(
            &v,
            coin::mint_for_testing<TestCoin>(funds, s.ctx()),
            s.ctx(),
        );
    };

    let cap = spend_vault::mint_cap(&v, &oc, s.ctx());
    let cap_id = object::id(&cap);

    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(NOW_MS);

    spend_vault::set_allowance<TestCoin>(
        &mut v,
        &oc,
        cap_id,
        budget,
        MAX_U64,
        option::none(),
        &clk,
        s.ctx(),
    );

    // Cap is consumed by value here — no caller can hold it afterwards.
    let policy_id = policy::create(&v, &oc, AGENT, OWNER, cap, s.ctx());

    spend_vault::share(v);
    clk.share_for_testing();

    (vault_id, policy_id, oc)
}

/// The happy path: the agent draws within budget and the draw is recorded
/// against the ledger. Destination is structurally fixed — the function takes
/// no recipient — so routing is a type-level guarantee, not a runtime one.
#[test]
fun agent_within_budget_draws_and_decrements() {
    let mut s = ts::begin(OWNER);
    let (_vid, _pid) = setup(&mut s, 1_000, 500);

    s.next_tx(AGENT);
    {
        let mut v = ts::take_shared<Vault>(&s);
        let mut p = ts::take_shared<policy::Policy>(&s);
        let clk = ts::take_shared<Clock>(&s);

        policy::spend_to_destination<TestCoin>(&mut p, &mut v, 300, &clk, s.ctx());

        assert_eq!(spend_vault::allowance<TestCoin>(&v, policy::cap_id(&p)), 200);

        // Arrival is NOT asserted here on purpose: the unit VM does not model the
        // funds accumulator, so no delivered Coin is registered as an object.
        // Verify delivery on-chain with a dry run against a real vault.

        ts::return_shared(v);
        ts::return_shared(p);
        ts::return_shared(clk);
    };
    s.end();
}

/// Cumulative draws may not exceed the granted budget — enforced by the OZ
/// ledger, not by this module.
#[test]
#[expected_failure(abort_code = spend_vault::EAllowanceExceeded)]
fun agent_over_budget_aborts() {
    let mut s = ts::begin(OWNER);
    let (_vid, _pid) = setup(&mut s, 10_000, 500);

    s.next_tx(AGENT);
    {
        let mut v = ts::take_shared<Vault>(&s);
        let mut p = ts::take_shared<policy::Policy>(&s);
        let clk = ts::take_shared<Clock>(&s);

        policy::spend_to_destination<TestCoin>(&mut p, &mut v, 300, &clk, s.ctx());
        policy::spend_to_destination<TestCoin>(&mut p, &mut v, 300, &clk, s.ctx());

        ts::return_shared(v);
        ts::return_shared(p);
        ts::return_shared(clk);
    };
    s.end();
}

/// Only the authorised agent may draw, so a stolen key or a curious third party
/// is refused before the ledger is touched.
#[test]
#[expected_failure(abort_code = policy::ENotAgent)]
fun non_agent_aborts() {
    let mut s = ts::begin(OWNER);
    let (_vid, _pid) = setup(&mut s, 1_000, 500);

    s.next_tx(THIEF);
    {
        let mut v = ts::take_shared<Vault>(&s);
        let mut p = ts::take_shared<policy::Policy>(&s);
        let clk = ts::take_shared<Clock>(&s);

        policy::spend_to_destination<TestCoin>(&mut p, &mut v, 100, &clk, s.ctx());

        ts::return_shared(v);
        ts::return_shared(p);
        ts::return_shared(clk);
    };
    s.end();
}

/// Owner kill switch, independent of the OZ ledger.
#[test]
#[expected_failure(abort_code = policy::ESuspended)]
fun suspended_policy_aborts() {
    let mut s = ts::begin(OWNER);
    let (_vid, pid) = setup(&mut s, 1_000, 500);

    s.next_tx(OWNER);
    {
        let mut p = ts::take_shared<policy::Policy>(&s);
        let oc = ts::take_from_address<OwnerCap>(&s, OWNER);

        policy::set_suspended(&mut p, &oc, true);
        assert!(policy::is_suspended(&p));

        ts::return_to_address(OWNER, oc);
        ts::return_shared(p);
    };

    s.next_tx(AGENT);
    {
        let mut v = ts::take_shared<Vault>(&s);
        let mut p = ts::take_shared<policy::Policy>(&s);
        let clk = ts::take_shared<Clock>(&s);

        assert_eq!(object::id(&p), pid);
        policy::spend_to_destination<TestCoin>(&mut p, &mut v, 100, &clk, s.ctx());

        ts::return_shared(v);
        ts::return_shared(p);
        ts::return_shared(clk);
    };
    s.end();
}

/// A cap for a DIFFERENT vault cannot admin this policy. This is the binding
/// check that replaces a stored-owner comparison.
#[test]
#[expected_failure(abort_code = policy::EWrongOwnerCap)]
fun foreign_vault_owner_cap_rejected() {
    let mut s = ts::begin(OWNER);

    // Our policy's vault.
    let (_vid, _pid, oc) = setup_returning_cap(&mut s, 1_000, 500);
    transfer::public_transfer(oc, OWNER);

    // A second, unrelated vault and its cap.
    let (other_v, other_oc) = spend_vault::new(s.ctx());
    spend_vault::share(other_v);

    s.next_tx(OWNER);
    {
        let mut p = ts::take_shared<policy::Policy>(&s);
        // Aborts before this line runs; present so the cap is consumed on the
        // non-abort path and the compiler is satisfied.
        let foreign = other_oc;
        policy::set_agent(&mut p, &foreign, THIEF);
        ts::return_to_address(OWNER, foreign);

        ts::return_shared(p);
    };
    s.end();
}

/// Authority follows the cap: once the OwnerCap is handed to a new holder, that
/// holder admins the policy. This is the rotation gap closed — no stored owner
/// address to go stale.
#[test]
fun authority_follows_the_owner_cap() {
    let mut s = ts::begin(OWNER);
    let (_vid, _pid, oc) = setup_returning_cap(&mut s, 1_000, 500);

    // OWNER hands the vault over.
    transfer::public_transfer(oc, NEW_OWNER);

    s.next_tx(NEW_OWNER);
    {
        let mut p = ts::take_shared<policy::Policy>(&s);
        let oc = ts::take_from_address<OwnerCap>(&s, NEW_OWNER);

        policy::set_agent(&mut p, &oc, NEW_OWNER);
        policy::set_destination(&mut p, &oc, NEW_OWNER);

        assert_eq!(policy::agent(&p), NEW_OWNER);
        assert_eq!(policy::destination(&p), NEW_OWNER);

        ts::return_to_address(NEW_OWNER, oc);
        ts::return_shared(p);
    };

    // The rotated agent can draw.
    s.next_tx(NEW_OWNER);
    {
        let mut v = ts::take_shared<Vault>(&s);
        let mut p = ts::take_shared<policy::Policy>(&s);
        let clk = ts::take_shared<Clock>(&s);

        policy::spend_to_destination<TestCoin>(&mut p, &mut v, 100, &clk, s.ctx());
        assert_eq!(spend_vault::allowance<TestCoin>(&v, policy::cap_id(&p)), 400);

        ts::return_shared(v);
        ts::return_shared(p);
        ts::return_shared(clk);
    };
    s.end();
}

/// The old agent is refused after rotation.
#[test]
#[expected_failure(abort_code = policy::ENotAgent)]
fun old_agent_refused_after_rotation() {
    let mut s = ts::begin(OWNER);
    let (_vid, _pid) = setup(&mut s, 1_000, 500);

    s.next_tx(OWNER);
    {
        let mut p = ts::take_shared<policy::Policy>(&s);
        let oc = ts::take_from_address<OwnerCap>(&s, OWNER);

        policy::set_agent(&mut p, &oc, NEW_OWNER);

        ts::return_to_address(OWNER, oc);
        ts::return_shared(p);
    };

    s.next_tx(AGENT);
    {
        let mut v = ts::take_shared<Vault>(&s);
        let mut p = ts::take_shared<policy::Policy>(&s);
        let clk = ts::take_shared<Clock>(&s);

        policy::spend_to_destination<TestCoin>(&mut p, &mut v, 100, &clk, s.ctx());

        ts::return_shared(v);
        ts::return_shared(p);
        ts::return_shared(clk);
    };
    s.end();
}

// === Venue allowlist ===

/// Venues start closed: a fresh policy approves no pool, so the agent has no
/// route until the owner explicitly opens one.
#[test]
fun allowed_pools_starts_empty() {
    let mut s = ts::begin(OWNER);
    let (_vid, pid) = setup(&mut s, 1_000, 500);

    s.next_tx(OWNER);
    {
        let p = ts::take_shared<policy::Policy>(&s);
        assert_eq!(object::id(&p), pid);
        assert!(!policy::is_pool_allowed(&p, object::id_from_address(@0xF00D)));

        ts::return_shared(p);
    };
    s.end();
}

/// The cap holder opens and closes a venue, and the change is observable.
#[test]
fun owner_can_allow_and_revoke_pool() {
    let mut s = ts::begin(OWNER);
    let (_vid, _pid) = setup(&mut s, 1_000, 500);

    s.next_tx(OWNER);
    {
        let mut p = ts::take_shared<policy::Policy>(&s);
        let oc = ts::take_from_address<OwnerCap>(&s, OWNER);

        let pool_id = object::id_from_address(@0xF00D);
        policy::set_pool_allowed(&mut p, &oc, pool_id, true);
        assert!(policy::is_pool_allowed(&p, pool_id));

        policy::set_pool_allowed(&mut p, &oc, pool_id, false);
        assert!(!policy::is_pool_allowed(&p, pool_id));

        ts::return_to_address(OWNER, oc);
        ts::return_shared(p);
    };
    s.end();
}

/// Venue approval is cap-gated like every other admin action: a cap belonging to
/// a different vault cannot open a route on this policy.
#[test]
#[expected_failure(abort_code = policy::EWrongOwnerCap)]
fun foreign_cap_cannot_allow_pool() {
    let mut s = ts::begin(OWNER);
    let (_vid, _pid, oc) = setup_returning_cap(&mut s, 1_000, 500);
    transfer::public_transfer(oc, OWNER);

    let (other_v, foreign) = spend_vault::new(s.ctx());
    spend_vault::share(other_v);

    s.next_tx(OWNER);
    {
        let mut p = ts::take_shared<policy::Policy>(&s);

        policy::set_pool_allowed(&mut p, &foreign, object::id_from_address(@0xF00D), true);

        ts::return_to_address(OWNER, foreign);
        ts::return_shared(p);
    };
    s.end();
}

// === Idempotency ===

/// Re-allowlisting an already-allowed pool must be harmless, and revoking twice
/// likewise. Before the fix `vec_set::insert` aborted on the duplicate, which
/// made re-running a hire impossible and made recovery from a hiccup a failure
/// rather than a no-op.
#[test]
fun allowlisting_and_revoking_are_idempotent() {
    let mut s = ts::begin(OWNER);
    let (_vid, _pid) = setup(&mut s, 1_000, 500);

    s.next_tx(OWNER);
    {
        let mut p = ts::take_shared<policy::Policy>(&s);
        let oc = ts::take_from_address<OwnerCap>(&s, OWNER);
        let pool_id = object::id_from_address(@0xF00D);

        policy::set_pool_allowed(&mut p, &oc, pool_id, true);
        policy::set_pool_allowed(&mut p, &oc, pool_id, true); // must not abort
        assert!(policy::is_pool_allowed(&p, pool_id));

        policy::set_pool_allowed(&mut p, &oc, pool_id, false);
        policy::set_pool_allowed(&mut p, &oc, pool_id, false); // must not abort
        assert!(!policy::is_pool_allowed(&p, pool_id));

        ts::return_to_address(OWNER, oc);
        ts::return_shared(p);
    };
    s.end();
}

// === slippage bound ===
//
// The bound is in basis points of PRICE. The pool quotes price as a square root, so
// a naive implementation would bound the ROOT and be off by a factor of two at small
// values. The pair below pins the unit down: a sqrt move of 1/10_000 is a price move
// of 2.0001 bps, so it must pass at 3 and fail at 2. If the bound were applied to the
// sqrt price directly, both would pass and nothing else here would notice.

/// 2^64 — sqrt price 1.0 in the pool's Q64.64 representation, a realistic mid.
const SQRT_ONE: u128 = 18_446_744_073_709_551_616;

#[test]
fun slippage_within_bound_passes_both_directions() {
    let up = SQRT_ONE + SQRT_ONE / 10_000;
    let down = SQRT_ONE - SQRT_ONE / 10_000;
    policy::assert_within_bps_for_testing(SQRT_ONE, up, 3);
    policy::assert_within_bps_for_testing(SQRT_ONE, down, 3);
}

#[test]
#[expected_failure(abort_code = policy::ESlippageOutOfBound)]
fun slippage_beyond_bound_aborts() {
    // a sqrt move of 1/100 is a PRICE move of about 201 bps
    policy::assert_within_bps_for_testing(SQRT_ONE, SQRT_ONE + SQRT_ONE / 100, 5);
}

#[test]
#[expected_failure(abort_code = policy::ESlippageOutOfBound)]
fun slippage_bound_is_symmetric() {
    policy::assert_within_bps_for_testing(SQRT_ONE, SQRT_ONE - SQRT_ONE / 100, 5);
}

/// A 1/10_000 sqrt move is 2.0001 bps of PRICE, so a 2 bps bound must refuse it.
#[test]
#[expected_failure(abort_code = policy::ESlippageOutOfBound)]
fun slippage_is_basis_points_of_price_not_of_its_root() {
    policy::assert_within_bps_for_testing(SQRT_ONE, SQRT_ONE + SQRT_ONE / 10_000, 2);
}

/// The largest sqrt price the pool can report, squared, is what forces u256.
#[test]
fun slippage_arithmetic_survives_the_extreme_sqrt_price() {
    let max_sqrt: u128 = 79_226_673_515_401_279_992_447_579_055;
    policy::assert_within_bps_for_testing(max_sqrt, max_sqrt, 1);
}

#[test]
fun slippage_starts_unset() {
    let mut s = ts::begin(OWNER);
    let (_vid, pid) = setup(&mut s, 1_000, 500);

    s.next_tx(OWNER);
    {
        let p = ts::take_shared<policy::Policy>(&s);
        assert_eq!(object::id(&p), pid);
        // unset is NOT the same as zero: nobody has decided anything yet
        assert!(policy::max_slippage_bps(&p).is_none());

        ts::return_shared(p);
    };
    s.end();
}

/// The owner sets the bound, changes it, and can explicitly disable it.
#[test]
fun owner_can_set_and_change_the_slippage_bound() {
    let mut s = ts::begin(OWNER);
    let (_vid, _pid) = setup(&mut s, 1_000, 500);

    s.next_tx(OWNER);
    {
        let mut p = ts::take_shared<policy::Policy>(&s);
        let oc = ts::take_from_address<OwnerCap>(&s, OWNER);

        policy::set_max_slippage_bps(&mut p, &oc, 5);
        assert_eq!(policy::max_slippage_bps(&p).destroy_some(), 5);

        // an upsert, not an append
        policy::set_max_slippage_bps(&mut p, &oc, 25);
        assert_eq!(policy::max_slippage_bps(&p).destroy_some(), 25);

        // zero is a decision, and distinguishable from never having set it
        policy::set_max_slippage_bps(&mut p, &oc, 0);
        assert_eq!(policy::max_slippage_bps(&p).destroy_some(), 0);

        ts::return_to_address(OWNER, oc);
        ts::return_shared(p);
    };
    s.end();
}

/// The ceiling exists so a fat-fingered value cannot quietly disable the bound.
#[test]
#[expected_failure(abort_code = policy::ESlippageTooLoose)]
fun slippage_above_the_ceiling_is_refused() {
    let mut s = ts::begin(OWNER);
    let (_vid, _pid) = setup(&mut s, 1_000, 500);

    s.next_tx(OWNER);
    {
        let mut p = ts::take_shared<policy::Policy>(&s);
        let oc = ts::take_from_address<OwnerCap>(&s, OWNER);

        policy::set_max_slippage_bps(&mut p, &oc, 501);

        ts::return_to_address(OWNER, oc);
        ts::return_shared(p);
    };
    s.end();
}

/// The bound is cap-gated like every other admin action.
#[test]
#[expected_failure(abort_code = policy::EWrongOwnerCap)]
fun foreign_cap_cannot_set_the_slippage_bound() {
    let mut s = ts::begin(OWNER);
    let (_vid, _pid) = setup(&mut s, 1_000, 500);

    // a cap for a DIFFERENT vault
    s.next_tx(OWNER);
    let (other_vault, other_cap) = spend_vault::new(s.ctx());
    spend_vault::share(other_vault);
    transfer::public_transfer(other_cap, OWNER);

    s.next_tx(OWNER);
    {
        let mut p = ts::take_shared<policy::Policy>(&s);
        let foreign = ts::take_from_address<OwnerCap>(&s, OWNER);

        policy::set_max_slippage_bps(&mut p, &foreign, 5);

        ts::return_to_address(OWNER, foreign);
        ts::return_shared(p);
    };
    s.end();
}
