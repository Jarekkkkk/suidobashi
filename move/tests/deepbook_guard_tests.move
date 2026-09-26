/// Tests for `sui_tokyo::deepbook_guard`.
///
/// What these prove: creation is permissionless; a single operator serves many guards while
/// holding nothing; the guard authorises orders from a capability no caller has; and the agent's
/// authority is bounded per guard — by band, by per-order size, by the pause — with the knobs
/// reachable only by the maker, including not by the agent itself. Plus the property the whole
/// design rests on: the BalanceManager stays independently reachable, so a bug here cannot trap
/// capital.
///
/// What these CANNOT prove: that an order is placed. `place_limit_order` needs a live DeepBook
/// pool, which the unit VM cannot construct. The gates take ids exactly so that the part which
/// can be tested is tested; the forwarding itself needs an on-chain run against the pinned pool.
#[test_only]
module sui_tokyo::deepbook_guard_tests;

use deepbook::balance_manager::{Self, BalanceManager};
use std::unit_test::assert_eq;
use sui::coin;
use sui::test_scenario as ts;
use sui_tokyo::deepbook_guard::{Self, DeepbookGuard};

const ALICE: address = @0xA;
const BOB: address = @0xB;
/// One operator, configured on every guard below. It is an address and holds no object.
const OPERATOR: address = @0xC;
const OTHER_OPERATOR: address = @0xD;
const STRANGER: address = @0xE;

/// Opaque to the guard — it compares these, it does not interpret them. Real values are in the
/// pool's own scaled price units.
const PRICE_MIN: u64 = 900;
const PRICE_MAX: u64 = 1_100;
const MAX_QTY: u64 = 100;

/// Stand-ins for the pool's `Base`/`Quote` pair. Phantom, so any type will do.
public struct TestBase has drop {}
public struct TestQuote has drop {}

/// A coin type that exists only in this module, for funding a BalanceManager.
public struct TestCoin has drop {}

fun pool(): ID {
    object::id_from_address(@0xF00D)
}

fun other_pool(): ID {
    object::id_from_address(@0xBEEF)
}

fun mock_balance_manager(): ID {
    object::id_from_address(@0x0DD)
}

/// A BalanceManager owned by the current sender, with one of each capability, placed under a new
/// guard. Returns the guard id and the BalanceManager id.
fun setup(
    s: &mut ts::Scenario,
    agent: address,
    price_min: u64,
    price_max: u64,
    max_qty: u64,
): (ID, ID) {
    let mut bm = balance_manager::new(s.ctx());
    let deposit_cap = balance_manager::mint_deposit_cap(&mut bm, s.ctx());
    let withdraw_cap = balance_manager::mint_withdraw_cap(&mut bm, s.ctx());
    let trade_cap = balance_manager::mint_trade_cap(&mut bm, s.ctx());
    let balance_manager_id = object::id(&bm);

    let guard_id = deepbook_guard::create<TestBase, TestQuote>(
        pool(),
        bm,
        deposit_cap,
        withdraw_cap,
        trade_cap,
        agent,
        price_min,
        price_max,
        max_qty,
        s.ctx(),
    );

    (guard_id, balance_manager_id)
}

/// The same, inside the band the tests below mostly use.
fun setup_in_band(s: &mut ts::Scenario, agent: address): (ID, ID) {
    setup(s, agent, PRICE_MIN, PRICE_MAX, MAX_QTY)
}

/// Take the guard out of the scenario, as a caller would receive a shared object.
fun take(s: &mut ts::Scenario, guard_id: ID): DeepbookGuard<TestBase, TestQuote> {
    ts::take_shared_by_id<DeepbookGuard<TestBase, TestQuote>>(s, guard_id)
}

// === Creation is permissionless ===

/// No whitelist, no per-user deploy, no operator in the path. Two wallets that have never met
/// each create a working guard, each recording its own maker and its own choice of agent.
#[test]
fun two_unrelated_wallets_each_create_their_own_guard() {
    let mut s = ts::begin(ALICE);
    let (alice_guard, _) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(BOB);
    let (bob_guard, _) = setup_in_band(&mut s, OTHER_OPERATOR);

    assert!(alice_guard != bob_guard);

    s.next_tx(ALICE);
    {
        let g = take(&mut s, alice_guard);
        assert_eq!(deepbook_guard::maker(&g), ALICE);
        assert_eq!(deepbook_guard::agent(&g), OPERATOR);
        ts::return_shared(g);
    };

    s.next_tx(BOB);
    {
        let g = take(&mut s, bob_guard);
        assert_eq!(deepbook_guard::maker(&g), BOB);
        assert_eq!(deepbook_guard::agent(&g), OTHER_OPERATOR);
        ts::return_shared(g);
    };
    s.end();
}

/// A guard holds the capabilities it was handed and no others, and its binding is the pool the
/// maker named. Read back by a stranger, because on-chain state is public.
#[test]
fun the_guard_records_what_it_was_handed() {
    let mut s = ts::begin(ALICE);

    let mut bm = balance_manager::new(s.ctx());
    let deposit_cap = balance_manager::mint_deposit_cap(&mut bm, s.ctx());
    let withdraw_cap = balance_manager::mint_withdraw_cap(&mut bm, s.ctx());
    let trade_cap = balance_manager::mint_trade_cap(&mut bm, s.ctx());

    let balance_manager_id = object::id(&bm);
    let deposit_cap_id = object::id(&deposit_cap);
    let withdraw_cap_id = object::id(&withdraw_cap);
    let trade_cap_id = object::id(&trade_cap);

    let guard_id = deepbook_guard::create<TestBase, TestQuote>(
        pool(),
        bm,
        deposit_cap,
        withdraw_cap,
        trade_cap,
        OPERATOR,
        PRICE_MIN,
        PRICE_MAX,
        MAX_QTY,
        s.ctx(),
    );

    s.next_tx(STRANGER);
    {
        let g = take(&mut s, guard_id);
        assert_eq!(deepbook_guard::pool_id(&g), pool());
        assert_eq!(deepbook_guard::balance_manager_id(&g), balance_manager_id);
        assert_eq!(deepbook_guard::deposit_cap_id(&g), deposit_cap_id);
        assert_eq!(deepbook_guard::withdraw_cap_id(&g), withdraw_cap_id);
        assert_eq!(deepbook_guard::trade_cap_id(&g), trade_cap_id);
        assert_eq!(deepbook_guard::is_paused(&g), false);

        // Three capabilities, each its own object — the reason the 1,000-per-account ceiling is
        // nowhere near this design.
        assert!(deposit_cap_id != withdraw_cap_id);
        assert!(withdraw_cap_id != trade_cap_id);
        assert!(deposit_cap_id != trade_cap_id);

        let (price_min, price_max, max_qty) = deepbook_guard::bounds(&g);
        assert_eq!(price_min, PRICE_MIN);
        assert_eq!(price_max, PRICE_MAX);
        assert_eq!(max_qty, MAX_QTY);
        ts::return_shared(g);
    };
    s.end();
}

/// The exit that does not run through this module.
///
/// A guard was created with every capability the account has, which is the worst case: if the
/// BalanceManager were stored inside the guard, this withdrawal would be impossible. It is shared
/// instead, so the maker reaches it directly and DeepBook's own owner check is the only gate. No
/// capability is used and none is needed.
#[test]
fun the_maker_can_still_withdraw_without_the_guard() {
    let mut s = ts::begin(ALICE);
    let (_, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(ALICE);
    {
        let mut bm = ts::take_shared_by_id<BalanceManager>(&s, balance_manager_id);
        balance_manager::deposit<TestCoin>(
            &mut bm,
            coin::mint_for_testing<TestCoin>(1_000, s.ctx()),
            s.ctx(),
        );

        let out = balance_manager::withdraw<TestCoin>(&mut bm, 1_000, s.ctx());
        assert_eq!(out.value(), 1_000);
        transfer::public_transfer(out, ALICE);
        ts::return_shared(bm);
    };
    s.end();
}

// === One operator, many guards ===

/// The step's claim, made executable. Two guards, two makers, one operator address. The operator
/// holds no object of either account and passes the gate on both — and each guard carries its own
/// band, so the same operator is inside the limits on one and outside them on the other.
#[test]
fun one_operator_serves_many_guards() {
    let mut s = ts::begin(ALICE);
    let (alice_guard, alice_bm) = setup(&mut s, OPERATOR, 900, 1_100, 100);

    s.next_tx(BOB);
    let (bob_guard, bob_bm) = setup(&mut s, OPERATOR, 1_000, 1_200, 50);

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, alice_guard);
        deepbook_guard::check_order_allowed_for_testing(&g, pool(), alice_bm, 950, 100, s.ctx());
        ts::return_shared(g);
    };
    {
        let g = take(&mut s, bob_guard);
        deepbook_guard::check_order_allowed_for_testing(&g, pool(), bob_bm, 1_050, 50, s.ctx());
        ts::return_shared(g);
    };
    s.end();
}

/// The limits are per guard, not per operator. A price the wide guard accepts, the narrow one
/// refuses — the same address, the same parameters, two different answers.
#[test]
#[expected_failure(abort_code = deepbook_guard::EPriceOutOfBand)]
fun a_guards_band_does_not_apply_to_another_guard() {
    let mut s = ts::begin(ALICE);
    // The wide guard, on the same operator and the same pool.
    let (_, _) = setup(&mut s, OPERATOR, 900, 1_100, 100);

    s.next_tx(BOB);
    let (bob_guard, bob_bm) = setup(&mut s, OPERATOR, 1_000, 1_200, 50);

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, bob_guard);
        // 950 is inside Alice's band and below Bob's floor.
        deepbook_guard::check_order_allowed_for_testing(&g, pool(), bob_bm, 950, 50, s.ctx());
        ts::return_shared(g);
    };
    s.end();
}

/// The operator holds no capability: it presents a BalanceManager and the guard produces the
/// proof from the cap that guard stores. `generate_proof_as_trader` validates the cap against the
/// BalanceManager, so this also shows the stored cap is the account's own.
#[test]
fun the_guard_authorises_orders_with_a_cap_no_caller_holds() {
    let mut s = ts::begin(ALICE);
    let (guard_id, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, guard_id);
        let mut bm = ts::take_shared_by_id<BalanceManager>(&s, balance_manager_id);

        deepbook_guard::generate_proof_for_testing(&g, &mut bm, s.ctx());

        ts::return_shared(bm);
        ts::return_shared(g);
    };
    s.end();
}

// === The gate ===

#[test]
#[expected_failure(abort_code = deepbook_guard::ENotAgent)]
fun a_stranger_is_refused() {
    let mut s = ts::begin(ALICE);
    let (guard_id, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(STRANGER);
    {
        let g = take(&mut s, guard_id);
        deepbook_guard::check_order_allowed_for_testing(
            &g,
            pool(),
            balance_manager_id,
            1_000,
            1,
            s.ctx(),
        );
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = deepbook_guard::EWrongPool)]
fun a_foreign_pool_is_refused() {
    let mut s = ts::begin(ALICE);
    let (guard_id, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, guard_id);
        deepbook_guard::check_order_allowed_for_testing(
            &g,
            other_pool(),
            balance_manager_id,
            1_000,
            1,
            s.ctx(),
        );
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = deepbook_guard::EWrongBalanceManager)]
fun a_foreign_balance_manager_is_refused() {
    let mut s = ts::begin(ALICE);
    let (guard_id, _) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, guard_id);
        deepbook_guard::check_order_allowed_for_testing(
            &g,
            pool(),
            mock_balance_manager(),
            1_000,
            1,
            s.ctx(),
        );
        ts::return_shared(g);
    };
    s.end();
}

// === The economic bound ===

#[test]
#[expected_failure(abort_code = deepbook_guard::EPriceOutOfBand)]
fun a_price_above_the_band_is_refused() {
    let mut s = ts::begin(ALICE);
    let (guard_id, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, guard_id);
        deepbook_guard::check_order_allowed_for_testing(
            &g,
            pool(),
            balance_manager_id,
            PRICE_MAX + 1,
            1,
            s.ctx(),
        );
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = deepbook_guard::EPriceOutOfBand)]
fun a_price_below_the_band_is_refused() {
    let mut s = ts::begin(ALICE);
    let (guard_id, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, guard_id);
        deepbook_guard::check_order_allowed_for_testing(
            &g,
            pool(),
            balance_manager_id,
            PRICE_MIN - 1,
            1,
            s.ctx(),
        );
        ts::return_shared(g);
    };
    s.end();
}

/// The bounds are inclusive, so the edges the maker wrote are usable.
#[test]
fun the_band_edges_are_inside_the_band() {
    let mut s = ts::begin(ALICE);
    let (guard_id, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, guard_id);
        deepbook_guard::check_order_allowed_for_testing(
            &g, pool(), balance_manager_id, PRICE_MIN, MAX_QTY, s.ctx(),
        );
        deepbook_guard::check_order_allowed_for_testing(
            &g, pool(), balance_manager_id, PRICE_MAX, 0, s.ctx(),
        );
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = deepbook_guard::EQuantityAboveBound)]
fun a_quantity_above_the_bound_is_refused() {
    let mut s = ts::begin(ALICE);
    let (guard_id, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, guard_id);
        deepbook_guard::check_order_allowed_for_testing(
            &g,
            pool(),
            balance_manager_id,
            1_000,
            MAX_QTY + 1,
            s.ctx(),
        );
        ts::return_shared(g);
    };
    s.end();
}

// === The maker's knobs, and who may reach them ===

/// Freezing the agent costs no capability and moves no coin, so it still works on a guard whose
/// capabilities are all held inside itself.
#[test]
fun the_maker_pauses_without_holding_any_capability() {
    let mut s = ts::begin(ALICE);
    let (guard_id, _) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(ALICE);
    {
        let mut g = take(&mut s, guard_id);
        deepbook_guard::set_paused(&mut g, true, s.ctx());
        assert_eq!(deepbook_guard::is_paused(&g), true);
        ts::return_shared(g);
    };

    // Paused means every agent path refuses; the gate is checked here for the flag's sake.
    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, guard_id);
        assert_eq!(deepbook_guard::is_paused(&g), true);
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = deepbook_guard::EPaused)]
fun a_paused_guard_refuses_its_agent() {
    let mut s = ts::begin(ALICE);
    let (guard_id, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(ALICE);
    {
        let mut g = take(&mut s, guard_id);
        deepbook_guard::set_paused(&mut g, true, s.ctx());
        ts::return_shared(g);
    };

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, guard_id);
        deepbook_guard::check_order_allowed_for_testing(
            &g,
            pool(),
            balance_manager_id,
            1_000,
            1,
            s.ctx(),
        );
        ts::return_shared(g);
    };
    s.end();
}

/// The agent may not widen the band it is confined to. This is the line that makes the bound a
/// bound rather than a suggestion: without it, a compromised operator sets its own limit.
#[test]
#[expected_failure(abort_code = deepbook_guard::ENotMaker)]
fun the_agent_cannot_widen_its_own_band() {
    let mut s = ts::begin(ALICE);
    let (guard_id, _) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(OPERATOR);
    {
        let mut g = take(&mut s, guard_id);
        deepbook_guard::set_bounds(&mut g, 0, 1_000_000, 1_000_000, s.ctx());
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = deepbook_guard::ENotMaker)]
fun a_stranger_cannot_pause_the_guard() {
    let mut s = ts::begin(ALICE);
    let (guard_id, _) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(STRANGER);
    {
        let mut g = take(&mut s, guard_id);
        deepbook_guard::set_paused(&mut g, true, s.ctx());
        ts::return_shared(g);
    };
    s.end();
}

/// Narrowing the band really narrows it: a price that was inside becomes outside.
#[test]
#[expected_failure(abort_code = deepbook_guard::EPriceOutOfBand)]
fun the_maker_narrowing_the_band_locks_the_agent_out() {
    let mut s = ts::begin(ALICE);
    let (guard_id, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(ALICE);
    {
        let mut g = take(&mut s, guard_id);
        deepbook_guard::set_bounds(&mut g, 990, 1_010, MAX_QTY, s.ctx());
        ts::return_shared(g);
    };

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, guard_id);
        // 950 was inside the old band.
        deepbook_guard::check_order_allowed_for_testing(
            &g,
            pool(),
            balance_manager_id,
            950,
            1,
            s.ctx(),
        );
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = deepbook_guard::EPriceBandInverted)]
fun an_inverted_band_is_refused() {
    let mut s = ts::begin(ALICE);
    let (guard_id, _) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(ALICE);
    {
        let mut g = take(&mut s, guard_id);
        deepbook_guard::set_bounds(&mut g, 1_100, 900, MAX_QTY, s.ctx());
        ts::return_shared(g);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = deepbook_guard::EPriceBandInverted)]
fun a_guard_cannot_be_created_with_an_inverted_band() {
    let mut s = ts::begin(ALICE);
    let (_, _) = setup(&mut s, OPERATOR, 1_100, 900, MAX_QTY);
    s.end();
}

// === Rotating the operator ===

/// Rotation takes effect at once: the old operator is refused from the next transaction, so there
/// is no window in which two addresses can both trade the account.
#[test]
#[expected_failure(abort_code = deepbook_guard::ENotAgent)]
fun the_old_operator_is_refused_after_rotation() {
    let mut s = ts::begin(ALICE);
    let (guard_id, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(ALICE);
    {
        let mut g = take(&mut s, guard_id);
        deepbook_guard::set_agent(&mut g, OTHER_OPERATOR, s.ctx());
        ts::return_shared(g);
    };

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, guard_id);
        deepbook_guard::check_order_allowed_for_testing(
            &g,
            pool(),
            balance_manager_id,
            1_000,
            1,
            s.ctx(),
        );
        ts::return_shared(g);
    };
    s.end();
}

#[test]
fun the_new_operator_takes_over() {
    let mut s = ts::begin(ALICE);
    let (guard_id, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(ALICE);
    {
        let mut g = take(&mut s, guard_id);
        deepbook_guard::set_agent(&mut g, OTHER_OPERATOR, s.ctx());
        assert_eq!(deepbook_guard::agent(&g), OTHER_OPERATOR);
        ts::return_shared(g);
    };

    s.next_tx(OTHER_OPERATOR);
    {
        let g = take(&mut s, guard_id);
        deepbook_guard::check_order_allowed_for_testing(
            &g,
            pool(),
            balance_manager_id,
            1_000,
            1,
            s.ctx(),
        );
        ts::return_shared(g);
    };
    s.end();
}

// === Isolation ===
//
// The claim under test: one account per guard, one set of capabilities per guard, no shared fund,
// and no path that moves value between accounts. Most of it is enforced by DeepBook rather than by
// this module, which is the point — it holds even if this code is wrong.
//
// DeepBook's error constants are private, so these tests name the abort code as a literal:
// `0` is `EInvalidOwner` and `1` is `EInvalidTrader`, the allowlist refusal.

/// Two accounts, both the same owner's, so the only thing wrong is the pairing. This is the one
/// place the code could undercut the claim: nothing about a `TradeCap` at rest says which
/// BalanceManager it belongs to, and before this check the mismatch would only surface when the
/// strategy first tried to trade.
#[test]
#[expected_failure(abort_code = 1)]
fun create_refuses_a_trade_cap_from_another_account() {
    let mut s = ts::begin(ALICE);

    let mut first = balance_manager::new(s.ctx());
    let deposit_cap = balance_manager::mint_deposit_cap(&mut first, s.ctx());
    let withdraw_cap = balance_manager::mint_withdraw_cap(&mut first, s.ctx());

    let mut second = balance_manager::new(s.ctx());
    let foreign_trade_cap = balance_manager::mint_trade_cap(&mut second, s.ctx());
    transfer::public_transfer(second, ALICE);

    let _ = deepbook_guard::create<TestBase, TestQuote>(
        pool(),
        first,
        deposit_cap,
        withdraw_cap,
        foreign_trade_cap,
        OPERATOR,
        PRICE_MIN,
        PRICE_MAX,
        MAX_QTY,
        s.ctx(),
    );
    s.end();
}

/// The isolation itself, enforced by DeepBook and not by us: a capability is welded to one
/// account's allowlist, so a guard's own trade capability cannot be presented against any other
/// account. Meaning no agent, however far it has gone rogue, can point one guard's authority at a
/// different user's money.
#[test]
#[expected_failure(abort_code = 1)]
fun a_guards_trade_cap_cannot_authorise_another_account() {
    let mut s = ts::begin(ALICE);
    let (guard_id, _) = setup_in_band(&mut s, OPERATOR);

    let mut other_account = balance_manager::new(s.ctx());

    s.next_tx(OPERATOR);
    {
        let g = take(&mut s, guard_id);
        // The guard's stored capability, offered to an account that never listed it. The module
        // never hands the capability out, so this hook is the only way to make the attempt.
        deepbook_guard::generate_proof_for_testing(&g, &mut other_account, s.ctx());
        transfer::public_transfer(other_account, ALICE);
        ts::return_shared(g);
    };
    s.end();
}

/// What stops anyone arranging a shared fund: a second guard over one account can exist only
/// because that account's owner minted the capabilities for it. Minting is owner-gated inside
/// DeepBook, so an outsider cannot manufacture authority over an account it does not own.
#[test]
#[expected_failure(abort_code = 0)]
fun a_stranger_cannot_mint_a_capability_for_another_account() {
    let mut s = ts::begin(ALICE);
    let (_, balance_manager_id) = setup_in_band(&mut s, OPERATOR);

    s.next_tx(STRANGER);
    {
        let mut bm = ts::take_shared_by_id<BalanceManager>(&s, balance_manager_id);
        let cap = balance_manager::mint_trade_cap(&mut bm, s.ctx());
        transfer::public_transfer(cap, STRANGER);
        ts::return_shared(bm);
    };
    s.end();
}

/// The two capabilities `create` cannot check are still checked — by DeepBook, on first use. Its
/// validators for these take the same allowlist route as the trade capability; they are simply not
/// reachable from outside the package, so the refusal lands at the deposit rather than at creation.
/// A later gate, not a hole.
#[test]
#[expected_failure(abort_code = 1)]
fun a_foreign_deposit_cap_is_refused_by_deepbook_on_use() {
    let mut s = ts::begin(ALICE);

    let mut account = balance_manager::new(s.ctx());
    let mut other_account = balance_manager::new(s.ctx());
    let foreign_deposit_cap = balance_manager::mint_deposit_cap(&mut other_account, s.ctx());

    balance_manager::deposit_with_cap<TestCoin>(
        &mut account,
        &foreign_deposit_cap,
        coin::mint_for_testing<TestCoin>(1_000, s.ctx()),
        s.ctx(),
    );
    transfer::public_transfer(foreign_deposit_cap, ALICE);
    transfer::public_transfer(other_account, ALICE);
    transfer::public_transfer(account, ALICE);
    s.end();
}
