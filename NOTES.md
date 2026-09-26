# sui-tokyo — build notes

On-device agent wallet: QVAC for intent, local signing, OpenZeppelin allowance
for caps, a purpose gate for venue control. No delegation, no TEE.

## Deployed (mainnet)

| Thing | Value |
| --- | --- |
| Package (original id) | `0x2441fb74d7684f43019fdabf27d6de24dc8e42826ddd86ba07bc21aded80c014` |
| Package (version 2 id) | `0xbaf5205c0e5b8aeea6117a31e9b5e47af73e220ed58f32c2256f0e708cb2db9f` |
| Package (latest, v3) | `0x0517705e1bd75f18c586b9a243a2608bda489420ca9d2308adbe2199fab999d7` |
| UpgradeCap | `0x50a57fce03614745395e2a9e1aac204cfd0f7979532106669066283898b97ec9` |
| Vault (shared v1) | `0x153bb450c5bbb06c4587f95eec2b14f81cd6163792d43b59175a6df6504c2d42` |
| Policy (shared v963323800) | `0x8a68c6ebb9aab5ef378c51172a88b23c3cad51ec62b8b7c96ab847a5f9f820c0` |
| OwnerCap | `0x7150c87b41ba35e8841acc0ab146ba7f0dbb6dd032d4a15860b1f7c641953372` |
| SpenderCap (owned by the Policy) | `0x21b3bb053c65eed825cd7acb80417dd11dd437e057c3c056a5fab789b4c00580` |
| Cetus pool (allowlisted) | `0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab` |
| Cetus GlobalConfig | `0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f` |

The vault holds **0.1 SUI** with the agent's budget set to **0.05 SUI** — deliberately
half. Verified by probe: a 0.05 draw passes, a 0.06 draw aborts `EAllowanceExceeded`.
The difference is unreachable by the agent, which is the point: the vault is custody,
the budget is authority, and they are not the same number.

### Proven on mainnet, by real transactions

- Swap through the purpose gate: `JAPdriQcvgVWQj7gY72AKUbi2uDQeU6t6Yix9HcxK5PM`
  (`amount_paid` exactly equals `amount_in`; output routed to the owner as a Coin)
- Over-budget draw refused on-chain: `5PscKjYZDb8Wmjno19iEs2cEAJ8ZDnLx8muC2HJS1QqW`
  (`EAllowanceExceeded`, `spend_vault::spend` line 865, checkpoint 325311845)
- The position guard holds a funded Cetus position. No address owns it: the
  position's owner is a dynamic-field wrapper, reachable only through the module.
- `rebalance_with_rewards` moved the range 68460–69460 → 68800–69200 atomically,
  collecting accrued CETUS and returning 0.315 SUI + 0.247 USDC of surplus. The
  guard's `position_id` changed, proving the close-and-reopen happened in one
  transaction.
- `redeem_with_rewards` destroyed the position and returned everything to the
  owner with only the OwnerCap — no agent cooperation, no agent key, no agent
  alive at all.
- **Natural language to on-chain, end to end**: "swap 0.05 SUI into USDC" on the
  local model produced intent `{action: swap, amountText: "0.05"}`, which this code
  converted to exactly `50000000` MIST, which became digest
  `EvUr5wDvMjs7F1ZRsEK6EHAcgWhXX1jLz3uAh79fqvvX` — `amount_in` 50000000,
  `amount_out` 50890, routed to the owner. The English request, the extracted
  number, the computed number and the on-chain amount agree to the unit.

## Deliberate deferrals

- **v4 is staged but deliberately NOT deployed.** It carries only the
  `set_pool_allowed` idempotency fix. Spending ~0.12 SUI to fix something that
  only bites on a *repeat* call is a poor trade when nothing is blocked: budgets
  re-grant through `set-budget.js` (a true upsert), allowlists are only written on
  a hire's first venue, and suspension is a bool assign. `Published.toml` records
  v3 as deployed, so the mismatch between source and chain is not hidden.

  Revisit if: an allowlist needs re-running, or other Move changes accumulate to
  batch in — a second upgrade for a single body change is wasteful, so wait for a
  reason to publish anyway.
- **UpgradeCap left in the deployer wallet.** Whoever holds it can republish the
  policy module and rewrite its rules, so the caps and the abort above are
  enforced by code that key can replace. Accepted for now; the official version
  freezes it (`make_immutable`) for full decentralisation. Until then, treat this
  cap as being as sensitive as the vault itself.
- **No desktop shell. Electron/Tauri deliberately not built.** The UI is a page
  served from the same local process that hosts the agent, so `fetch('/api/…')` is
  same-origin: no CORS, no Private Network Access check, no mixed-content block,
  and nothing to special-case. Hosting the UI *remotely* and calling `127.0.0.1`
  would be blocked, so that shape is off the table permanently.

  Electron would add a closed port, packaging, and OS keychain access. It was
  skipped because the security delta is smaller than it sounds — a malicious
  process running as this user can read the token, attach to an Electron app, or
  read the keystore file, so neither loopback-with-token nor IPC defends against
  the case that matters. Revisit when shipping to non-technical users, when OS
  keychain custody is wanted, or if the signer key ever moves into the browser.

  If it is built: Electron (only TS-native shell; Tauri means Rust, Wails means
  Go), with the same `index.html` in the renderer and the two `api()` calls
  swapped for IPC. **Do not load QVAC inside Electron's main process** — it ships
  native addons and Electron runs a different Node ABI, so spawn `qvac serve` as a
  sidecar instead.
- **Pool is pinned, not chosen per transaction.** The aggregator's routing is
  non-deterministic between calls at identical parameters, so advice is unstable.
- **No multi-hop or split routing.** Our module executes one pool, one direction.

## Security posture of the local surface

- Both the UI and the intent layer **assert loopback** and refuse to start
  otherwise. Exposing either takes a deliberate `UI_ALLOW_NON_LOOPBACK=1`, not a
  stray config edit.
- The UI issues a **per-run token**, injected into the page it serves and required
  on every `/api/*` call. A cross-origin caller can reach the port but cannot read
  the token, because same-origin policy blocks reading our response body.
- Loopback is **not user-scoped**, so any local process can reach these ports. The
  token stops a remote page driving the agent; it does not stop same-user malware,
  and nothing on loopback would.

- **Pool is pinned, not chosen per transaction.** The aggregator's routing is
  non-deterministic between calls at identical parameters, so advice is unstable.
- **`position_guard` is built and unit-tested but NOT published.** Its operations
  that touch the position (open, collect, rebalance, redeem) are unverified
  on-chain — the unit VM cannot construct a Cetus pool, so those need a live run
  against the pinned pool, exactly as the swap got. Publishing costs another
  publish (roughly 0.08 SUI) and needs an explicit go-ahead.

## QVAC — the intent layer

Local model serving on loopback via `qvac serve openai` (`127.0.0.1:11434`),
model `QWEN3_600M_INST_Q4`. The model's only job is language → a small typed
object. It never builds a transaction, never sees a key, and never decides what is
safe — every real rule lives below it, in the vault's caps, the venue allowlist,
the agent gate, and the tick bounds. So a wrong model produces a refused intent,
never a wrong transaction.

Four constraints, all found by probing this specific model rather than assumed:

- **Never ask it to do unit conversion.** Asked for MIST directly, it returned
  `500000000` for "0.05 SUI" — a tenfold error that looks entirely plausible, and
  the examples had covered 0.25 and 1 SUI but not 0.05. It also returned
  `amountMist: 0` zero-shot for "half a SUI". The fix that works: ask for the
  amount **exactly as written** (`amountText: "0.05"`) and convert here, by exact
  decimal parsing rather than floating point. The model extracts; this code
  computes.
- **Integer fields degenerate if unconstrained.** A free-form string field made it
  emit `"SUI-2000000…0000"` until it hit the length cap (`finish_reason: length`).
  A short, instruction-constrained literal is fine.
- **`/no_think` is required.** Without it Qwen3 emits a separate
  `reasoning_content` field and `content` is not the answer alone.
- **Worked examples are load-bearing.** They are what make a 0.6B model reliable
  at extraction, and they must include the awkward cases.

`src/agent.js` implements that: schema-constrained extraction, exact decimal →
MIST conversion, a boring enum-and-range gate, then dry run → keystore signature →
submission. It refuses rather than guesses.

## Known bugs

**`policy::set_pool_allowed` was not idempotent in either direction.** Fixed in
source; needs an upgrade to take effect on-chain.

`vec_set::insert` aborts when the key is already present, so re-allowlisting
failed. I first assumed removal was safe because `vec_set::remove` returns a bool —
**that is wrong in this framework version**: it aborts with `EKeyDoesNotExist` when
the key is absent, so revoking twice failed too. Both directions now check
`contains` first. Caught by the test written for the fix, which is the argument for
writing it.

Until the upgrade lands, re-running `setup-pool.js` fails at the allowlist step;
use `set-budget.js` for budget re-grants, since that one is a true upsert.

## Traps that cost time — do not rediscover these

**A `compatible` upgrade cannot change an existing public function's signature.**
Adding a `RewardType` parameter, or reshaping one, is rejected with
`EUC03001 function signature mismatch` / `EUC01005 type parameter mismatch`.
The policy is fixed at first publish and can only be tightened. Function *bodies*
are free, so the workaround is additive: new functions beside the old
(`rebalance_with_rewards`, `redeem_with_rewards`, `deposit_liquidity_fix`),
because a function also cannot be *removed* by an upgrade.

**A `compatible` upgrade cannot change an existing struct's layout either.** From
the upgrade docs: *"Your changes must be layout-compatible with the previous
version. Existing struct layouts, including struct abilities, must remain the same.
You can add new structs and functions."* So a new **field** cannot be added to
`Policy`, `Vault`, `PositionGuard` or any published struct — which rules out the
obvious way to add a per-policy setting.

The escape is a **dynamic field**. Dynamic fields hang off the object's `UID` and
are stored as separate objects, so they are not part of the struct layout and
adding one is compatible. Use one when a shipped struct needs new per-object state:

```move
public struct SlippageKey has copy, drop, store {}   // a NEW struct: allowed

dynamic_field::add(&mut policy.id, SlippageKey {}, bps);
```

Note the asymmetry that costs a day if forgotten: **structs are frozen, dynamic
fields are not.** Anything the design says "we can just add later" has to be
planned as a dynamic field, a separate object, or a new struct from the start.

**An upgrade can ADD a check but cannot IMPOSE one.** Every prior version of a
package stays callable with its own bytecode, so a check added in v4 does not apply
to a caller who names v3. Demonstrated, not theorised: after v4 shipped a slippage
bound in `swap_and_route`, v3's unbounded body is still reachable, and v3's code can
operate on a policy that v4 modified — because object types keep the original-id
identity and the layout is unchanged.

The Sui docs' recommended fix is a **version field in the shared object that every
version checks**. It cannot be retro-fitted: v1 through v3 were published without
one, so they will never refuse. What this means in practice:

```text
against a BUGGY agent     a new check helps, if the caller uses the new id
against a HOSTILE agent   it does not. Only SHARED STATE binds every version:
                          the allowance, the pool allowlist, the destination,
                          and the suspension flag.
```

So a limit added by upgrade is a guard against mistakes, never a boundary against
an adversary. Do not describe it as one.

**`ENotAgent` fires on mainnet.** For most of this project's life `agent == owner`,
so no call could ever be refused as the wrong caller — the gate passed its unit
tests while never being exercised on chain. Handing the grant to a different address
(`hire-agent.js --repoint`) changed that. A swap submitted from the owner's address
against a policy whose agent is someone else now aborts on chain:

```text
Status: Failure — MoveAbort in <pkg>::policy::assert_agent_gates
Aborted with 'ENotAgent' -- 'caller is not the authorised agent'
```

Worth reproducing deliberately: `tx.build({ client })` simulates and would refuse
the same transaction pre-flight, so producing the on-chain failure needs the
no-simulation build (`--gas-budget` on `sui client ptb`, or the offline recipe in
the previous note).

**Cetus refuses to close a position while rewards are owed.** `close_position`
requires `is_empty`, which means zero liquidity AND zero both fee sides AND every
reward at zero. A pool paying rewards therefore cannot be exited unless the
reward is collected first, and `collect_reward` needs the reward coin as a *type
parameter* — Move cannot iterate runtime types. Read the reward coin from the
pool's `rewarder_manager` and the vault id from Cetus's own
`clmmConfig.global_vault_id`. This is why the rebalance and redeem variants take
three type parameters; a pool with two rewarders would need more, which is a
known limit rather than a general solution.

**An upgraded module is only callable at the new version id.** The original package
id resolves to the version that first defined the module, so `policy` and
`spend_vault` are callable at the original id, but `position_guard` — added in
version 2 — is **not**: calling it at the original id fails with "unable to find
function". Existing object *types* keep the original-id identity either way, so
an `OwnerCap` minted before the upgrade is still the type the guard expects.

**An upgrade cannot remove a module that is part of the published package.**
(`EUC01006`.) The first publish used `--with-unpublished-dependencies`, which
bundled OpenZeppelin's `spend_vault` into our package; later builds resolved it as
an external dependency again, so the upgrade saw the module as removed.
`--skip-verify-compatibility` is **not** a fix — it would strip `spend_vault` and
orphan the Vault, Policy and both caps. The fix is to inline the module as our
own, which also removes the "unpublished dependency" problem permanently.

**Upgrades validate against the live protocol version.** A publish succeeded while
an upgrade failed with "protocol version 136 is newer than the maximum version 134
supported by this CLI" — the CLI, not the package, was the blocker. `suiup update
sui` moved it to v1.80.0.

**Shared versions are per-object, not a global 1.** Vault `1`, clock `1`, policy
`963323800`, pool `376543995`, Cetus config `1574190`. Passing the wrong one is
rejected as "not a shared object". Read them, never assume.

**Coin types come back in mixed forms.** The aggregator returns SUI as
`0x000…002::sui::SUI` while our constants use `0x2::sui::SUI`, and
`normalizeCoinType` does not bridge that — so an equality test silently never
matches and every route looks multi-hop. Compare on trailing segments.

**The PTB VM refuses `0x2::object::id` inside a transaction.** So an object id
that a call needs (e.g. a cap id for `set_allowance`) must be known off-chain and
passed as a pure value, or read from a previous transaction's effects.

**`tx.build({ client })` resolves, which simulates.** A doomed transaction
aborts during resolution and never reaches the chain. To produce a real *failed*
transaction you must build offline or use the CLI.

**The CLI cannot bind multi-return values.** `--assign` takes only the last
result and tuple syntax is rejected, so `spend_vault::new`'s `(Vault, OwnerCap)`
is unreachable. PTBs for that belong in the SDK.

**The CLI's PTB type arguments need angle brackets**, quoted so the shell does
not read them as redirection: `'<0x2::sui::SUI>'`.

**Cetus CLMM has no plain swap.** It is a flash swap: output delivered up front,
`repay_flash_swap` after, with repayment asserting **exact** equality against
`pay_amount`. Split the input to exactly that figure and route the remainder on;
over- or under-paying aborts. `Balance` has no `drop`, so both returned balances
must be consumed, and the receipt has no `drop`, which forces repayment into the
same transaction.

**The Cetus aggregator cannot hold our value.** `router::new_swap_context` is
`public` (so a module *can* call it), but the router also exposes `take_balance`,
so a transaction author can drain a swap context without swapping. This is why
the aggregator is advice-only and execution goes through our own module.

**The aggregator's provider filter needs the exported constant.** Passing the
string `'cetus'` silently does nothing and returns routes across every DEX.

**JavaScript embedded in a template literal is invisible to every tool, and its
backslashes are eaten before the browser sees them.** The UI page used to carry its
script inline; two bugs came from that one decision. A regex written as `\d` arrived
as a bare `d`, so `suiToMist("0.05")` returned null and Fund looked like a dead
button. A string written with `\n` arrived as a **real newline inside single quotes**,
which is a `SyntaxError` — the whole module failed to parse, so no handler attached
and *every* button on the page did nothing. The linter cannot see code inside a
string, so neither bug was catchable before serving it.

The fix is structural, not a repair: the page's code now lives in `src/web/page.js`
and `src/web/markup.js`, served as real modules. Both are linted and `node --check`ed.
When checking a served page, extract the script and run `node --check` on it — do not
eyeball it, and do not trust the linter.

**Already-safe markup must be a String, not a marker object.** The escaping helper
marks interpolations it produced as safe so a nested template is not escaped twice.
Done with a plain `{ [SAFE]: markup }` object, this breaks the most ordinary pattern
there is — mapping a template over a list — because `String([obj, obj])` is
`"[object Object],[object Object]"`. The hires strip and the hire dropdowns would
have rendered that. It must be a `String` subclass, and `esc` must flatten arrays
with `join('')` rather than letting `Array#toString` insert commas. Caught only by
`src/verify-page.js`, which imports the real module; that check is what makes the
escaping trustworthy.

**`redeem` leaves the guard permanently empty, and the guard id changes every
cycle.** The position is not a field of the guard — it is a dynamic *object* field
under `PositionKey {}`. `create` mints a brand-new guard each time, and no entry
point puts a position into an existing one, so:

- after a `redeem` the guard still holds the *old* `position_id`, which names a
  position that no longer exists. That field is a cached copy for display; the
  authoritative location is the dynamic object field.
- a stale `position_id` therefore proves nothing either way. To find out whether a
  position is live, dry-run any of them: `dynamic_object_field::remove` aborts at
  `borrow_child_object` (abort code 1) when there is none. `sui client dynamic-field`
  reports `{}` for a guard with no position, but that is the absence of evidence.
- every `create` yields a **new guard id**, and it is not predictable off-chain
  (`object::new` runs on the validator), so it can only be read back from the create
  transaction's effects. The **server is the authority** on which guard is current:
  it adopts the new id and shared version from that transaction the moment it submits
  it, passes them to `deposit`/`rebalance`/`redeem` as `GUARD_ID` /
  `GUARD_SHARED_VERSION`, and persists them into `addresses.js`. The scripts honour
  those variables and fall back to `addresses.js`, so running one by hand still works.
  `src/guard-id.js` holds the two pure pieces and `src/verify-guard.js` checks them
  against a real transaction — including the trap that a create also writes the
  *pool*, which is shared too, so "the shared object that was created" is not the
  guard.

**Order matters, and it is: open, fund, rebalance, exit.** `rebalance` refuses an
empty position with `ENoLiquidity` — not an error, just fund-before-move. And `exit`
is terminal for that guard, so anything after it needs a fresh `open`.

***

The CLI scripts under `src/` are **dry-run or `--emit-bytes` only** — there is no
`--execute` path and no key material anywhere (`setup-vault.js` is the sole
exception: it is the one-off script that creates the first vault, and the only file
that reads `SUI_SECRET_KEY`). Everything that signs signs in the extension, through
the server's build/submit split.

`src/agent.js` is the one place `--execute` still appears, and it is there to REFUSE
it: passing the flag prints a message explaining that signing no longer happens
there. Keep it — an old command in someone's shell history should fail loudly rather
than quietly do something else.

**An object cannot be rebuilt from a destructured UID.** The first version of `settle`
destructured the `Order`, swapped, and reassembled it with the same UID. The compiler
refused: *"The UID must come directly from `sui::object::new`, or
`sui::derived_object::claim`"*. So the struct has to stay **intact** and the funds come
out with `funds.split(funds.value())`, which leaves the original balance at zero.

**A shared object needs an explicit `sharedObjectRef` for an offline build.**
`tx.object(id)` requires *resolution*, which is exactly what an offline build cannot do —
it fails with *"transaction data was not sufficient to build offline"*. Read the initial
shared version and reference it explicitly. That also removes a lookup from the normal
path.

**A failed transaction comes back under `FailedTransaction`, not `Transaction`.** Reading
only the success shape reported `digest: null` for precisely the failures the
`--no-simulate` mode exists to produce. Cost one paid transaction to discover, because
the shape was guessed instead of dumped.

**A dynamic field is not in the object's `json`.** Anything stored in one is invisible to
a read of the object's own fields. This produced a real bug: the MCP server read
`order.fee_out`, found nothing, and `?? 0` reported every order as zero-fee while they
carried 5000 on chain.

**A struct with `key` needs `phantom` on its type parameters.** `key` normally requires
every type argument to have `store`; `phantom` is what exempts it. Without the annotation
`Order<SUI>` does not compile — and `CoinType` is only used inside `Balance<phantom T>`, so
`phantom` is the accurate description rather than a workaround.

**`toMist(undefined)` returns `0n`, so `??` does not apply.** A missing value silently
became a ZERO-LENGTH order that `create` refused as already expired, and the error pointed
at the chain rather than at the default that never applied. `??` catches `null` and
`undefined`, not a parse function's own zero.

**A zero fee is stored as absence, deliberately.** `create_with_fee` adds nothing for a
zero fee, so "no fee" has exactly one representation rather than two. Absence genuinely
means zero here — but only once the lookup is known to be right, which is a separate
question and the one that was wrong.

## Mainnet feature flags (protocol 136, read from the node)

```text
enable_accumulators                 = true
enable_object_funds_withdraw        = true    ← what the OZ vault needs
enable_address_balance_gas_payments = true
enable_allowances                   = absent  ← native sui::allowance is OFF on mainnet
```

The last line is why the OpenZeppelin vault is used rather than `sui::allowance`.
It is enabled on devnet and testnet only.

The wallet holds SUI as an **address balance**, not coin objects — inbound
transfers merge into the accumulator and do not create coins. Funding the vault
therefore withdraws from the live balance rather than splitting a coin.

## Code

```text
move/                       Move package; 20 unit tests
move/sources/policy.move        money gate: cap custody, agent gate, venue allowlist
move/sources/position_guard.move object gate: owns a Cetus position, never exposes it
src/addresses.js            every id and per-object shared version
src/agent.js                intent layer: QVAC -> typed intent -> deterministic gate
src/verify-intent.js        acceptance check for the intent layer (8 cases)
src/setup-vault.js          phase A — create vault, fund it
src/setup-policy.js         phase B — grant budget, create policy
src/setup-pool.js           allowlist venue, raise budget
src/topup-vault.js          deposit into the vault, set budget below balance
src/advisor.js              aggregator advice, read-only, deviation-guarded
src/swap.js                 swap build + dry run
src/verify-spend.js         end-to-end path check
src/create-position.js      open a position, embed it in a guard
src/deposit-liquidity.js    fund the position (fix-coin)
src/rebalance.js            move the range atomically, collecting rewards
src/redeem.js               owner-only exit
src/qvac.config.json        local model config
src/hires.js                the grants this owner holds
src/hire-agent.js           mint a cap, grant a budget, create a hire
src/set-budget.js           re-grant the agent's budget (upsert, gas only)
src/set-suspended.js        per-hire kill switch, owner-gated
src/ui.js                   three-pane frontend over the intent loop
```

## The marketplace layer

A policy *is* a grant, so **hiring needs no new contracts**. A second policy is a
second hire: its own cap, own budget, own venue allowlist, own agent, all drawing
on one vault.

```text
Hire A  standard   policy 0x8a68c6eb…820c0   budget 0.03   0.05% pool
Hire B  cautious   policy 0xb6834527…1d7d   budget 0.01   0.01% pool
```

The hires differ in **substance, not just in name**: a different venue (two
different Cetus SUI/USDC pools at different fee tiers), a different ceiling, and
independent suspension. Verified both ways on mainnet — routing cautious at its own
venue proposes, and forcing it onto standard's venue aborts `EPoolNotAllowed`.

**What a policy can and cannot express.** Its only per-hire knobs are the agent
address, the destination, the venue allowlist, and suspension — plus the ledger's
cap and expiry. There is no per-hire *action* allowlist, so "this agent may swap but
not rebalance" is not expressible without new Move. That is a real gap versus
AgentBazar's grants, which discriminated by version. Anything finer than "different
venue, different budget, different destination" needs a contract change.

Hiring is three phases because the PTB VM refuses `0x2::object::id`: mint the cap,
read its id off the effects, then grant the budget and create the policy. A new
hire starts with **no venue** — `allowed_pools` is empty — so it cannot trade until
the owner opens one. Fail-closed is right for a grant, but it does mean hiring is
three steps rather than two.

The per-hire kill switch is `policy::set_suspended`, owner-gated, needing no agent
cooperation. It is idempotent, unlike `set_pool_allowed`. Verified on mainnet: a
suspended hire refuses with `ESuspended`, and the suspension check runs *before*
the venue check.

Routing a request to a hire passes that hire's policy id *and* its venue to the
executing script — it selects a gate, it never widens one. Verified by forcing one
hire onto the other's venue and getting `EPoolNotAllowed` from its own policy.

External providers would be the same shape with one addition: a proposal schema a
provider returns and the local gate evaluates. They could only ever propose — there
is no delegation here, so a provider never signs and never holds value.

## The two gates

`policy` governs money: it custodies the OZ `SpenderCap`, so spend authority is
reachable only through its sender-gated paths, and it holds the venue allowlist.

`position_guard` governs an object: a shared wrapper owns a Cetus LP position and
exposes only whole operations. The rule it enforces, and the one the widely-copied
Cetus vault template breaks, is that **no function returns the position or a
mutable reference to it** — that template publishes `borrow_position`,
`borrow_mut_position` and `take_position`, and a caller holding `&mut Position`
can reach Cetus directly and bypass the wrapper entirely. Here the single borrow
is private, and `rebalance` performs remove, collect, close, open and repay
internally so the freed value never becomes a transaction value.

Signing never exposes the private key: the SDK builds bytes, the wallet extension
signs exactly those, and `sui client execute-signed-tx` submits them. That last
command cannot sign anything, which is the property the whole split rests on.

## Backlog

Each item carries the trigger that would make it worth doing. Nothing here is
blocking today; all of it is a deliberate `no` rather than an oversight.

| Item | Needs | Do it when |
| --- | --- | --- |
| **v4 upgrade** (idempotency fix) | code done, ~0.12 SUI | an allowlist needs re-running, or other Move changes pile up to batch in |
| **A live position** | no code, ~$1 + gas | you want the rebalance and redeem paths visible in the UI |
| **Per-hire action allowlist** | new Move | "this agent may swap but not rebalance" becomes a requirement. A policy's only knobs are agent, destination, venues, suspension, cap, expiry |
| **Guard reuse after redeem** | new Move | guards must outlive one position — today `redeem` leaves `position_id` pointing at a destroyed object and there is no way to attach a new one |
| **Readable budget** | an event on spend, plus an indexer | the local budget record drifts enough to mislead. The ledger amount sits in linked-table nodes and is not cheaply readable |
| **More than one reward type** | more type parameters | a pool pays two reward coins. Move cannot iterate runtime types, so today it is one type parameter per rewarder |
| **Multi-hop routing** | route dispatch reimplemented on-chain | execution quality outranks the purpose gate. The aggregator advises but cannot execute through us — see the `take_balance` finding |
| **Independent Move review** | a reviewer | before this holds value it does not need to. Written by one author and never audited; two upgrades were needed for issues I found myself |
| **Freeze the UpgradeCap** | irreversible | before production. Until then the rules are enforced by code that key can replace |

One small inconsistency worth clearing whenever `/api/*` is next touched:
`/api/execute` and `/api/suspend` return slightly different shapes (`stage` is only
set by the signing helper). Both work; neither is a contract anyone depends on yet.

