/// Tests for `sui_tokyo::deepbook_guard`.
///
/// What these prove: creation is permissionless — two unrelated wallets each create their own
/// guard in their own transaction, with no operator approval and no shared setup — that a guard
/// records exactly the pool, the capabilities and the agent it was handed, and that the
/// BalanceManager stays independently reachable afterwards so its owner can withdraw without
/// going through this module. That last one is the property the whole design rests on: a bug
/// here cannot trap capital.
///
/// What these CANNOT prove: that an order is placed. `place_limit_order` needs a live pool and a
/// pool-funded BalanceManager, neither of which the unit VM can construct. Those paths need an
/// on-chain run against the pinned pool.
#[test_only]
module sui_tokyo::deepbook_guard_tests;

use deepbook::balance_manager::{Self, BalanceManager, DepositCap, TradeCap, WithdrawCap};
use std::unit_test::assert_eq;
use sui::coin;
use sui::test_scenario as ts;
use sui_tokyo::deepbook_guard::{Self, DeepbookGuard};

const ALICE: address = @0xA;
const BOB: address = @0xB;
const ALICE_AGENT: address = @0xA1;
const BOB_AGENT: address = @0xB1;

/// Stand-ins for the pool's `Base`/`Quote` pair. Phantom, so any type will do.
public struct TestBase has drop {}
public struct TestQuote has drop {}

/// A coin type that exists only in this module, for funding a BalanceManager.
public struct TestCoin has drop {}

fun pool(): ID {
    object::id_from_address(@0xF00D)
}

/// A BalanceManager owned by the current sender, funded with one test coin, with one of each
/// capability. The caps come back by value so the caller can capture their ids before a guard
/// takes them.
fun fund_and_mint(s: &mut ts::Scenario): (BalanceManager, DepositCap, WithdrawCap, TradeCap) {
    let mut bm = balance_manager::new(s.ctx());
    balance_manager::deposit<TestCoin>(
        &mut bm,
        coin::mint_for_testing<TestCoin>(1_000, s.ctx()),
        s.ctx(),
    );

    let deposit_cap = balance_manager::mint_deposit_cap(&mut bm, s.ctx());
    let withdraw_cap = balance_manager::mint_withdraw_cap(&mut bm, s.ctx());
    let trade_cap = balance_manager::mint_trade_cap(&mut bm, s.ctx());

    (bm, deposit_cap, withdraw_cap, trade_cap)
}

/// The claim of this step: no whitelist, no per-user deploy, no operator in the path. Two
/// wallets that have never met each create a working guard, each recording its own maker and
/// its own choice of agent.
#[test]
fun two_unrelated_wallets_each_create_their_own_guard() {
    let mut s = ts::begin(ALICE);
    let (bm, dc, wc, tc) = fund_and_mint(&mut s);
    let alice_guard =
        deepbook_guard::create<TestBase, TestQuote>(pool(), bm, dc, wc, tc, ALICE_AGENT, s.ctx());

    s.next_tx(BOB);
    let (bm, dc, wc, tc) = fund_and_mint(&mut s);
    let bob_guard =
        deepbook_guard::create<TestBase, TestQuote>(pool(), bm, dc, wc, tc, BOB_AGENT, s.ctx());

    assert!(alice_guard != bob_guard);

    s.next_tx(ALICE);
    {
        let g = ts::take_shared_by_id<DeepbookGuard<TestBase, TestQuote>>(&s, alice_guard);
        assert_eq!(deepbook_guard::maker(&g), ALICE);
        assert_eq!(deepbook_guard::agent(&g), ALICE_AGENT);
        ts::return_shared(g);
    };

    s.next_tx(BOB);
    {
        let g = ts::take_shared_by_id<DeepbookGuard<TestBase, TestQuote>>(&s, bob_guard);
        assert_eq!(deepbook_guard::maker(&g), BOB);
        assert_eq!(deepbook_guard::agent(&g), BOB_AGENT);
        ts::return_shared(g);
    };
    s.end();
}

/// A guard holds the capabilities it was handed and no others, and its binding is the pool the
/// maker named. Read back by a stranger, because on-chain state is public.
#[test]
fun the_guard_records_what_it_was_handed() {
    let mut s = ts::begin(ALICE);
    let (bm, dc, wc, tc) = fund_and_mint(&mut s);

    let balance_manager_id = object::id(&bm);
    let deposit_cap_id = object::id(&dc);
    let withdraw_cap_id = object::id(&wc);
    let trade_cap_id = object::id(&tc);

    let guard_id =
        deepbook_guard::create<TestBase, TestQuote>(pool(), bm, dc, wc, tc, ALICE_AGENT, s.ctx());

    s.next_tx(BOB);
    {
        let g = ts::take_shared_by_id<DeepbookGuard<TestBase, TestQuote>>(&s, guard_id);
        assert_eq!(deepbook_guard::pool_id(&g), pool());
        assert_eq!(deepbook_guard::balance_manager_id(&g), balance_manager_id);
        assert_eq!(deepbook_guard::deposit_cap_id(&g), deposit_cap_id);
        assert_eq!(deepbook_guard::withdraw_cap_id(&g), withdraw_cap_id);
        assert_eq!(deepbook_guard::trade_cap_id(&g), trade_cap_id);
        ts::return_shared(g);
    };
    s.end();
}

/// The exit that does not run through this module.
///
/// A guard was created with every capability the account has, which is the worst case: if the
/// BalanceManager were stored inside the guard, this withdrawal would be impossible. It is
/// shared instead, so the maker reaches it directly and DeepBook's own owner check is the only
/// gate. No capability is used and none is needed.
#[test]
fun the_maker_can_still_withdraw_without_the_guard() {
    let mut s = ts::begin(ALICE);
    let (bm, dc, wc, tc) = fund_and_mint(&mut s);
    let balance_manager_id = object::id(&bm);

    let _guard_id =
        deepbook_guard::create<TestBase, TestQuote>(pool(), bm, dc, wc, tc, ALICE_AGENT, s.ctx());

    s.next_tx(ALICE);
    {
        let mut bm = ts::take_shared_by_id<BalanceManager>(&s, balance_manager_id);
        let out = balance_manager::withdraw<TestCoin>(&mut bm, 1_000, s.ctx());
        assert_eq!(out.value(), 1_000);
        transfer::public_transfer(out, ALICE);
        ts::return_shared(bm);
    };
    s.end();
}
