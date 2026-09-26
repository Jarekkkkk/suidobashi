# DeepBook v3 long-grid guard — feasibility

Question asked: can we wrap DeepBook's shared object inside a shared object of our own, expose only
`buy`/`sell` to the agent, and keep `stop`/`deposit`/`withdraw` for the user?

**Verdict: yes, and DeepBook v3 already supplies half of it.** Its own docs describe the exact
pattern ("a protocol can create a BalanceManager, hold the TradeCap internally, and allow users to
trigger trades through the protocol's own access control"). What DeepBook does *not* supply is a
bound on what the agent may trade, a pause, and the grid itself. Those three are the wrapper.

Sources: `MystenLabs/skills` → `deepbook-move/{pool-api,balance-manager-api}.md`,
`deepbook-overview/{design,contract-info}.md`; `MystenLabs/deepbookv3` source + `Published.toml`;
mainnet ABI probes. Every address and signature below was read from the chain or the vendor source,
not remembered.

## 1. Addresses and version — the docs' table is stale

```text
published-at  0x0e735f8c93a95722efd73521aca7a7652c0bb71ed1daf41b26dfd7d1ff71f748   version 8
original-id   0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809
registry      0xaf16199a2dff736e9f07a845f23c5da6df6f756eddb631aed9d24a93efc4549d
```

`docs.sui.io`'s table stops at v6; DeepBook's `Published.toml` says v8 and its own pool-api reference
says "Version 8". Calls through a disabled version abort `EPackageVersionDisabled`, so pin **v8**.

The trap: the SUI/USDC pool's *object type* names the **original** id while calls must use
**published-at**. Read from chain:

```text
0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407
  type 0x2c8d603b…::pool::Pool<0x2::sui::SUI, 0xdba34672…::usdc::USDC>   ← original id in the type
  call 0x0e735f8c…::pool::place_limit_order                              ← published-at for calls
```

Quote asset is this repo's existing `USDC_TYPE`, so `COINS`/`toUnits`/`shortCoinType` all apply.

**Type-argument order is flipped against this repo's Cetus pool.** DeepBook SUI/USDC is
`Pool<SUI, USDC>` (base SUI, quote USDC — `is_bid=true` buys SUI with USDC). `src/addresses.ts`
already defines `POOL_TYPE_ARGS = [USDC_TYPE, SUI_TYPE]` for Cetus `Pool<USDC, SUI>`. A DeepBook call
reusing that constant is the wrong pool. Needs its own `DEEPBOOK_POOL_TYPE_ARGS = [SUI_TYPE, USDC_TYPE]`.

## 2. Signatures (verbatim from source, existence confirmed against mainnet v8 ABI)

```move
place_limit_order<Base, Quote>(pool, balance_manager, trade_proof, client_order_id: u64,
    order_type: u8, self_matching_option: u8, price: u64, quantity: u64, is_bid: bool,
    pay_with_deep: bool, expire_timestamp: u64, clock, ctx): OrderInfo          // 13 params ✓

place_market_order<Base, Quote>(pool, balance_manager, trade_proof, client_order_id, 
    self_matching_option, quantity, is_bid, pay_with_deep, clock, ctx): OrderInfo

cancel_order<Base, Quote>(pool, balance_manager, trade_proof, order_id: u128, clock, ctx)
cancel_all_orders<Base, Quote>(pool, balance_manager, trade_proof, clock, ctx)
account_open_orders<Base, Quote>(pool, balance_manager): vector<u128>          // no proof needed
get_level2_ticks_from_mid<Base, Quote>(pool, ticks, clock): (bid_px, bid_qty, ask_px, ask_qty)
```

Order types `0 NO_RESTRICTION · 1 IOC · 2 FILL_OR_KILL · 3 POST_ONLY`; self-match `0 allowed ·
1 cancel taker · 2 cancel maker`. `OrderInfo has copy, drop, store` with `order_id(): u128`,
`status()`, `order_inserted(): bool`, `executed_quantity()` — so a wrapper can read the id and drop it.

**`place_post_only_limit_order` exists on the repo's main branch but is NOT deployed at v8** — ABI
probe returns `Function not found`. It returns `Option<OrderInfo>` (none instead of aborting on a
crossing order), which is exactly right for a grid, but it is unreleased. A grid therefore uses
`order_type = 3` (POST_ONLY); a crossing POST_ONLY order **aborts**, and Move has no try/catch, so
non-crossing prices must be computed *before* the call from `get_level2_ticks_from_mid`.

## 3. Who holds the authority (the answer to the design question)

DeepBook v3 has a two-tier model already:

| Object | Ability | Natural holder |
|---|---|---|
| `BalanceManager` (shared) | holds settled balances per asset | **the user** (owner) |
| `TradeCap` | place/cancel orders, stake — *no* deposit/withdraw | the wrapper |
| `DepositCap` | deposit only | the wrapper |
| `WithdrawCap` | withdraw only | the wrapper |
| `TradeProof` | ephemeral, `has drop`, generated per call | nobody — made and consumed in-tx |

`TradeCap`/`DepositCap`/`WithdrawCap` are all `has key, store`, and `BalanceManager has key, store`
— so **our shared object can hold all four as fields.** That is what makes the containment real: the
agent never holds a cap, so it cannot reach DeepBook except through our entry points.

```move
generate_proof_as_trader(balance_manager, trade_cap, ctx): TradeProof   // cap-holder path ✓
generate_proof_as_owner(balance_manager, ctx): TradeProof               // sender must be owner
deposit_with_cap<T>(bm, deposit_cap, coin)
withdraw_with_cap<T>(bm, withdraw_cap, amount, ctx): Coin<T>
revoke_trade_cap(bm, trade_cap_id: &ID, ctx)   // owner-gated; takes &ID, not ID; permanent
new_with_custom_owner_caps_v2<App: drop>(witness, registry, owner, ctx)
    : (BalanceManager, DepositCap, WithdrawCap, TradeCap)     // one call, all three caps
```

**The user keeps two exits that do not run through our code**, and both now have tests rather than
prose:

- As BalanceManager *owner*, `withdraw<T>(bm, amount, ctx)` needs no capability at all, so a bug in
  the wrapper cannot trap capital. `the_harshest_kill_still_leaves_the_maker_an_exit` withdraws the
  whole balance *after* the agent's authority has been revoked.
- `revoke_trade_cap` is owner-gated and **removes the id from the account's allowlist for good**.
  This guard cannot accept a replacement capability, so for that guard the kill is terminal:
  `set_paused` is the reversible stop, revocation is the one-way one.
  `the_maker_can_kill_the_agent_without_touching_this_module` revokes, then shows the capability the
  guard still stores no longer authorises a proof.

Constraints worth knowing. Withdrawals only touch **settled** balances — funds in resting orders
cannot be withdrawn until canceled, so a stop must `cancel_all_orders` before any withdraw. The cap
ceiling is 1,000 per BalanceManager, counted across all three types, so one account can back ~330
guards at three caps each — nowhere near this design. `_v2` on `new_with_custom_owner_caps_v2` is
mandatory; the unsuffixed name is a stub that aborts 1337.

**What isolation actually rests on**, checked against the source rather than assumed, because the
code path is not what enforces it:

- A cap belongs to an account by **allowlist membership**, not by the `balance_manager_id` field it
  carries: every validator asserts `allow_listed.contains(object::borrow_id(cap))`. Presenting one
  account's cap against another aborts `EInvalidTrader` (= 1).
- So the **trade** cap *can* be checked at creation, by attempting the proof every order needs —
  Move cannot catch an abort, so the check IS the call. `create` now does this, and a mismatched
  pair is refused rather than producing a guard whose every order aborts inside DeepBook.
- The **deposit and withdraw** caps cannot be checked the same way: `validate_deposit_cap` and
  `validate_withdraw_cap` are package-private, so a mismatch there surfaces on first use. It fails
  closed, and the maker's owner-withdraw exit is unaffected either way.
- A second guard over one account is possible. Only that account's owner can mint the caps for it,
  so it is a maker's choice about their own money rather than something a third party can arrange —
  which is why nothing here forbids it.

## 4. What the wrapper adds — only these three, DeepBook has none of them

1. **Bounds.** DeepBook's `TradeCap` bounds *which functions* the agent may call, not *how much* or
   *at what price*. A TradeCap holder can market-sell the entire balance. The wrapper stores
   `price_min`, `price_max`, `max_qty` per order, and a cumulative budget — the same allowance idea
   `policy.move` already implements for escrow orders.
2. **Pause.** No suspension flag exists on a cap. The wrapper checks a `paused` flag before
   forwarding, which stops the agent without a revocation transaction and without touching balances.
3. **The grid.** A long grid is N descending buy levels inside the band. Deliberately *not* in Move:
   the wrapper exposes single `buy`/`sell`, and the client places the levels as commands in one PTB.
   Keeps Move small and keeps the band editable without a publish.

Fees: SUI/USDC is **taker 1 bp, maker 0 bps**. A grid of resting POST_ONLY orders is entirely maker
side, so it costs nothing and needs no DEEP balance. Only a crossing order pays, and `pay_with_deep:
false` pays in the input token at a 25% premium — so a fill that crosses is where fee cost appears.

## 5. Proposed surface

`move/sources/deepbook_guard.move`, mirroring `position_guard.move`'s shape (shared object, stored
agent address, maker-only setters, no function returning the wrapped object or a `&mut` to it).

Maker only (`ctx.sender() == guard.maker`): `create<Base,Quote>` (takes the BM + three caps, shares)
· `deposit<T>` · `withdraw<T>` (requires settled funds) · `stop` (paused + `cancel_all_orders`) ·
`resume` · `set_agent` · `set_destination` · `set_bounds` · `redeem` (cancel everything, withdraw
all, revoke the TradeCap — the wrapper goes inert, balances back with the user).

Agent only (`ctx.sender() == guard.agent`, not paused, inside bounds): `buy` · `sell` · `cancel` ·
`cancel_all`.

Built so far: `create`, the maker's knobs `set_agent`/`set_bounds`/`set_budget`/`set_paused`, and
the agent paths `buy`/`sell`/`cancel`/`cancel_all`. The maker's capital paths — `deposit`,
`withdraw`, `stop`, `redeem` — are the remaining steps. `stop` is `set_paused(true)` plus the
`cancel_all_orders` that a paused agent can no longer do for it.

Where the code diverges from this plan, and why:

- The pause primitive is `set_paused(bool)` rather than a `stop`/`resume` pair: stopping is a maker
  toggle, and cancelling the book is the part that needs the pool, so `stop` will be the pair.
- `set_bounds` and `set_budget` are separate rather than one `set_limits`, because they change on
  different occasions — a band is a market view, a budget is a spending decision.
- **The budget counts what the agent asks for, never gives it back, and cannot measure fills.**
  DeepBook never calls back, so a resting order's fate is unknowable on chain, and refunding on a
  cancel would mean tracking every order id. It bounds the size placed, not the size filled, so a
  grid should set it to the ladder's whole size.

Dropped from the plan: the per-placement event. DeepBook already emits one and
`place_limit_order` returns `OrderInfo`, so a guard-side copy would be a duplicate carrying the
same order id.

`Move.toml` gains the DeepBook dep beside the existing Cetus MVR dep — pinned to git at tag
`v8.0.0`, not MVR (its version-8 record has no git info) and not `main` (which is ahead of the
deployed version). See NOTES.md for both failures.

## 6. Cost and open items

Publish is a Move upgrade-free new module → ~0.1 SUI, irreversible, needs your explicit go-ahead.
Then one BM-creation tx (owner = your address, mints the three caps) and a small live grid.

Not yet verified, stated as unverified: whether several `place_limit_order` commands may take `&mut`
on the same Pool/wrapper within **one PTB** (DeepBook's SDK batches orders, this repo has not tried
it). If not, the grid is one order per transaction. Decide by running one dry-run tx, not by reading.

Raw tick/lot/min for the pool are not in its top-level JSON (state sits in a dynamic field); the
docs' table says tick `0.00001`, lot `0.1` for SUI/USDC. Must be read from chain at implementation
time — this is the same class of unit error that produced the thousandfold bug in the amount parser.
