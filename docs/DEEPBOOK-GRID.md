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
| `DepositCap` | deposit only | **nobody needs one** — see below |
| `WithdrawCap` | withdraw only | **nobody needs one** — see below |
| `TradeProof` | ephemeral, `has drop`, generated per call | nobody — made and consumed in-tx |

`TradeCap`/`DepositCap`/`WithdrawCap` are all `has key, store`, and `BalanceManager has key, store`
— so **our shared object can hold any of them as fields.** What makes the containment real is that
the agent never holds a cap, so it cannot reach DeepBook except through our entry points.

**The guard stores the trade capability and nothing else.** The other two turned out to be dead
storage, and this was found before the publish rather than after — which matters, because removing a
struct field is not something a Sui upgrade can do:

- `owner` is set when a BalanceManager is created and **there is no setter for it anywhere** in
  `deepbook::balance_manager` (checked: `owner` is assigned only in the `new*` constructors).
- `create` takes the BalanceManager **by value**, and in Sui only an owner can use an owned object as
  an input. So the maker is permanently the account's owner.
- DeepBook's owner paths — `deposit<T>`, `withdraw<T>`, `withdraw_all<T>` — go through
  `generate_proof_as_owner` and take **no capability at all**.

So a deposit or withdraw capability in the guard would never be read by anything, while costing two
fields in a struct that cannot be slimmed later.

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
ceiling is 1,000 per BalanceManager, counted across all three types; the guard uses one, so one
account can back 1,000 guards — nowhere near this design. `_v2` on
`new_with_custom_owner_caps_v2` is mandatory; the unsuffixed name is a stub that aborts 1337. That
constructor is not used here at all: it mints three capabilities, and `new` plus `mint_trade_cap`
mints the one this design wants.

**What isolation actually rests on**, checked against the source rather than assumed, because the
code path is not what enforces it:

- A cap belongs to an account by **allowlist membership**, not by the `balance_manager_id` field it
  carries: every validator asserts `allow_listed.contains(object::borrow_id(cap))`. Presenting one
  account's cap against another aborts `EInvalidTrader` (= 1).
- So the **trade** cap *can* be checked at creation, by attempting the proof every order needs —
  Move cannot catch an abort, so the check IS the call. `create` now does this, and a mismatched
  pair is refused rather than producing a guard whose every order aborts inside DeepBook.
- The **deposit and withdraw** capabilities are not checked at all, because the guard does not take
them. DeepBook's `validate_deposit_cap` / `validate_withdraw_cap` are package-private, so a
mismatched pair would only surface on first use — another reason not to have a field that exists
solely to be wrong. The `a_foreign_deposit_cap_is_refused_by_deepbook_on_use` test still calls
DeepBook directly, and now documents why this design wants no such capability rather than why it
cannot check one.
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

Maker only (`ctx.sender() == guard.maker`): `create<Base,Quote>` (takes the BM + the trade
capability, shares) · `set_agent` · `set_bounds` · `set_budget` · `set_paused`. Deposit and withdraw
are DeepBook's owner paths, not ours — see §3.

Agent only (`ctx.sender() == guard.agent`, not paused, inside bounds): `buy` · `sell` · `cancel` ·
`cancel_all`.

Built so far: `create`, the maker's knobs `set_agent`/`set_bounds`/`set_budget`/`set_paused`, and
the agent paths `buy`/`sell`/`cancel`/`cancel_all`. That is the whole surface the design needs, and
the rest of this section records what the plan proposed and why it turned out to be unnecessary —
worth doing before a publish rather than after, since a published struct cannot be slimmed.

On the caller's side, `src/deepbook.ts` holds the pinned DeepBook constants, the grid arithmetic
(`gridLevels`), the same four refusals the guard makes (`refusalFor`, each naming the Move assert it
mirrors), and `buildCreateAccount` — the BalanceManager plus its trade capability, which touches
only DeepBook's published package and therefore **simulates on mainnet today**
(`src/verify-deepbook.js`, 21 checks, in the `bun run verify` chain).

The order paths are deliberately not built there yet: they call our guard module, so until it is
published they would be dead code that cannot be run even once. They belong in the publish change,
together with the home-pane flow.

Where the code diverges from this plan, and why:

- **`deposit` and `withdraw` are not ours and are not needed.** The maker is permanently the
  BalanceManager's owner (§3), so DeepBook's owner paths already cover capital in and out with no
  capability. The plan listed them as guard functions; the finding is that they would have been
  convenience at best.
- **No `set_destination`.** An agent path never produces a coin — proceeds stay inside the
  BalanceManager — so there is no value output for a destination to catch.
- **`stop`/`redeem` are not built yet, and are convenience rather than capability.** The maker can
  already freeze with `set_paused`, take the agent seat with `set_agent`, cancel with `cancel_all`,
  withdraw as owner and revoke the capability. `stop` would be that in one transaction instead of
  three, which is worth having and blocks nothing.
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

**Done, 2026-02:** the module went live in the v9 upgrade,
`EtxVz7BBjKC4qVJqnbTp9LqCm16heCB1UfExsm41VZHM` — package `0xe420d1be…`, version 9. It is an
**upgrade**, not a publish: the package was already deployed, and adding a module to a published
package means upgrading it under the UpgradeCap (policy `compatible`, which permits exactly this).
Cost was **0.1996 SUI**, twice the 0.1 this section originally estimated.

The check that mattered before spending it: whether the git-pinned DeepBook dependency would LINK
or BUNDLE. `Move.lock` pins every dependency by source only, and DeepBook's own manifest declares
`[addresses] deepbook = "0x0"` — the same condition that made the first publish bundle
`spend_vault`. Bundling would have put DeepBook's `pool` and `balance_manager` inside our package,
making our `BalanceManager` a different type from the real one. Reading the compiled bytecode
settled it beforehand: `deepbook_guard.mv` referenced DeepBook's original id `0x2c8d603b…`, not
`0x0`. The published module list confirms it after the fact — five modules, ours only.

Not yet verified, stated as unverified: whether several `place_limit_order` commands may take `&mut`
on the same Pool/wrapper within **one PTB** (DeepBook's SDK batches orders, this repo has not tried
it). If not, the grid is one order per transaction. Decide by running one dry-run tx, not by reading.

The pool's tick size and price scale are now MEASURED rather than assumed, and checked against the
chain on every `bun run verify`: a live `get_level2_ticks_from_mid` gives level gaps that are all
multiples of 10, and a mid of 1.16 USDC per SUI, which fixes the price scale at 1e6 and the tick at
10 — the `0.00001` the contract table lists. Neither is in the pool's top-level JSON, so this was
read out of a simulation, not out of a field.

**The quantity scale is still open**, and it is the one number that could produce the thousandfold
error this section used to warn about in general. A live read's per-level quantities are not
multiples of the documented 0.1 SUI lot under any scale tried; the evidence is in NOTES.md and
`quantityScale` is marked UNVERIFIED. Settling it needs one real order, which needs the publish.

## 7. Three flavors of "help others"

A guard is one account, one operator address, one set of limits. That single shape carries the first
two ways of helping someone, and offers nothing for the third.

### (a) Self-serve — the maker's own operator

Built. The maker's wallet, or their own runner, is the `agent`; `set_agent` rotates it.

### (b) Managed — one operator, many users

**Needs no new contract surface.** Checked against the module rather than argued:

- The module holds **no global state**: no `init`, and the only shared objects it ever creates are
  the caller's BalanceManager and the guard itself (two call sites, both in `create`). An operator
  serving a thousand users has nothing shared to coordinate through, because there is nothing to
  create.
- Authority is a per-guard `address` field, so one address sits in any number of guards while the
  limits stay each maker's own (`one_operator_serves_many_guards`,
  `a_guards_band_does_not_apply_to_another_guard`).
- Events carry `guard_id` **and** `agent`, at creation and on every change (`GuardCreated`,
  `GuardUpdated`), so an operator finds the guards it serves without a registry object.
- What a user risks from an operator is that user's band, per-order bound and budget — and leaving
  is `set_agent`, or `revoke_trade_cap` if trust is gone entirely.
- **A user never depends on the operator to recover their own book.** Resting orders belong to the
  account, not the operator, and every cancel path is agent-gated — so an abandoned maker takes the
  seat with one `set_agent(maker)` and clears their own orders
  (`the_maker_can_take_the_agent_seat_and_unwind`).

**Answered, and the answer is yes.** Whether one transaction may take `&mut Pool` in several commands
was the open question deciding (b)'s economics — N users in one transaction rather than N. The
runner's own ladder settles it: `src/run-grid.ts` builds a five-level grid as five order placements
against the same pool in ONE transaction, and that transaction resolves and executes. The failure it
reports is DeepBook's balance check on the account — a statement about money, not about the shape of
the transaction. One transaction per guard is not required.

**Built for (b).** `src/runner.ts` is one operator's decision half: a pure function of a guard's
state, the book, and what is already resting, checked by 29 assertions in `src/verify-runner.js`.
Three properties are load-bearing rather than tidy:

- **Idempotent.** A ladder already resting is asked for nowhere. A runner is a loop and a guard's
  budget counts every order the agent ever asks for, so re-placing its own work would burn the
  maker's budget on orders that already exist.
- **Never crossing.** The ladder is capped at the best *bid*, never the ask, so every level is a
  maker order and none can fill at a price the grid did not choose.
- **Stands down, never crashes.** A market that has left the band, a guard that is paused, a seat
  this runner does not hold — each returns a plan with nothing in it and a reason, because the
  moment a runner must not die is the moment the market moves.

The submission half is not built, for the same reason the order paths are not: it calls the guard
module, which is not published. Nor is the listing's action. The page itself is built — a
`strategies` tab in the sidebar, its catalog served from `/api/strategies` — and opting in is
**absent with the server's reason shown** rather than a button that fails when pressed. The reason
is served as data (`blocked`), so the day the publish sets `DEEPBOOK_GUARD_PACKAGE` the page starts
offering the action with no UI change.

### (c) Programmable — the agent is a Move contract

**Not possible as this plan wrote it, and the plan was wrong.** A Move module can never be
`ctx.sender()` — that is the transaction signer, and a module does not sign. An address-gated guard
cannot admit a contract as its agent, no matter what the contract does.

Making it work means changing the gate from *is the caller this address* to *did the caller present
this capability* — an `AgentCap` object that a module could hold as a dynamic field. That is a
different trust shape, worth stating plainly: today there is **nothing at the operator to steal**,
which this design bought deliberately. An `AgentCap` is a stealable object, and holding it would
authorise trading every guard that accepted it. So (c) trades away "nothing to steal" for
programmability, and moves the strategy on chain where a bug cannot be fixed by a restart.

Deferred on those grounds, not on effort.

## 8. Shipping (a): the order of transactions

Ship (a) first, and the reason is not that it is the smallest — it is that **one small real order
exercises every layer at once**, so each layer gets proved before anything is built on top of it.
(b) and (c) then add no contract surface at all, which is what keeps the wrapper stable while the
layers above it change.

### What (a) needs, and what it turns out not to need

Built and verified: the guard's 25 public functions (95 move tests), the agent path authorised by a
capability no caller holds, the band/budget/pause bound, both protocol-native kills, the caller's
constants and grid arithmetic (21 checks, and the account-creation path simulates on mainnet), the
runner's decision half (29 checks), and the listing page.

**It does not need `deposit`, `withdraw`, `stop` or `redeem` on the guard.** That is a real finding
rather than a gap: funding is DeepBook's own owner-gated `deposit`, which works on the shared
BalanceManager (`the_maker_can_still_withdraw_without_the_guard` already deposits into one), and the
maker's exit is the owner's `withdraw` with no capability at all. The one thing the maker cannot do
is cancel the agent's resting orders — and `set_agent` to their own address fixes that, which
`the_maker_can_take_the_agent_seat_and_unwind` covers. So the capital paths are worth adding, and
none of them blocks a first live grid.

What IS missing before a grid can run: the publish, the order-path builders (`buy`/`sell`/`cancel`,
deferred because they would have been dead code), the runner's submission half, and the flow that
joins them.

And one unknown that must be settled FIRST, not after: **the quantity scale**. Its evidence is in
NOTES.md and `quantityScale` is marked UNVERIFIED. Transaction 5 below is the one that settles it.

### The sequence

Each transaction proves something the previous one did not, so a failure is attributable to one
layer rather than to five at once.

| # | Transaction | What it proves |
|---|---|---|
| 1 | Publish `deepbook_guard` | The module builds for mainnet; sets `DEEPBOOK_GUARD_PACKAGE` |
| 2 | Create BalanceManager + 3 caps | The creation path live, not just simulated |
| 3 | `create` the guard, band and budget set | Capability storage, and the BalanceManager becoming shared |
| 4 | Deposit a small amount | Funding on a SHARED BalanceManager, owner-gated |
| 5 | **One `buy`**, quantity chosen to expose the scale | The agent path end to end: the gate, the proof from the guard's own cap, the band, the budget — and the quantity scale, read back from `OrderInfo` and the event |
| 6 | `cancel` it | Order cancellation, and funds returning to settled |
| 7 | `withdraw` as owner | The escape hatch, with no capability, on real funds |

Only then are the submission half and the flow worth writing, because only then can either be run
even once. Transaction 5 should be placed at the documented lot size and, if it is refused, at the
value the refusal implies — the refusal is the measurement.

### The ask — answered

Publishing was one irreversible transaction and it is done: the module is live, and the id is in
`addresses.ts` as `DEEPBOOK_GUARD_PACKAGE`. Everything above that line in this plan — the wrapper,
the arithmetic, the runner's decision half, the listing — was written and checked before spending
it. Everything below it is now merely unwritten rather than unverifiable, which is the whole
reason for that order.

Next: transactions 2–7, then the submission half and the flow. Transaction 5 still settles the
quantity scale, and is still the one that matters.
