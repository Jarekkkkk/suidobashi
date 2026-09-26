# sui-tokyo — build notes

On-device agent wallet: QVAC for intent, local signing, OpenZeppelin allowance
for caps, a purpose gate for venue control. No delegation, no TEE.

## Deployed (mainnet)

| Thing | Value |
| --- | --- |
| Package (original id) | `0x2441fb74d7684f43019fdabf27d6de24dc8e42826ddd86ba07bc21aded80c014` |
| Package (version 2 id) | `0xbaf5205c0e5b8aeea6117a31e9b5e47af73e220ed58f32c2256f0e708cb2db9f` |
| Package (latest, v9) | `0xe420d1be090d84763b55ee6051cee1c346888d7ec8107af41e9172cc9ef8b864` |
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

- `deepbook_guard` is live, in the v9 upgrade: `EtxVz7BBjKC4qVJqnbTp9LqCm16heCB1UfExsm41VZHM`
  — package `0xe420d1be…`, version 9, 0.1996 SUI. The published module list is
  `deepbook_guard, order, policy, position_guard, spend_vault`, and that list is itself the
  evidence for the thing most worth checking before an upgrade: the DeepBook dependency LINKED
  rather than BUNDLED. A bundled dep would have put its own `pool` and `balance_manager` in that
  list, at which point our `BalanceManager` would be a different type from the real one and no
  guard could ever act on an account. The compiled bytecode was read first — it referenced
  DeepBook's original id `0x2c8d603b…`, not `0x0`.
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
- **No multi-hop or split routing.** Our module executes one pool, at most one hop. It handles
  BOTH directions of that pair — the direction is chosen per order and read back off the order's own
  type — but never two pools, and never a split.

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

The fix was structural, not a repair: the page's code moved into `src/web/page.js`
and `src/web/markup.js`, served as real modules, both linted and `node --check`ed.
**THOSE TWO FILES ARE GONE NOW** — they went with the old page when `/` was deleted, so do not go
looking for them. What outlives them is the lesson, which has nothing to do with where the file
lived: never put script inside a template literal, because the linter cannot see it and the escapes
are eaten before the browser does. The app keeps that property by being a bundled entry point
(`src/web/app/main.tsx`) rather than by being a string the server emits.
When checking a served page, extract the script and run `node --check` on it — do not
eyeball it, and do not trust the linter.

**The same trap, one layer out: a backtick inside a template literal ENDS the string.**
The SQLite schema in `src/db.ts` is one `db.run(\`…\`)` call, and a comment inside it used
backticks around identifiers. Each one terminated the template, so the SQL after it became
JavaScript and the file would not parse.

Caught immediately because it is TypeScript in a file the compiler reads. In a served string it
would have been silent — which is exactly what happened to the page above, twice. The rule is
narrower than "do not use backticks": inside a template literal, backticks and backslashes are
both consumed, so write the comment without them.

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

**A module that is also a CLI has to guard its entry point.** `agent.ts` ended with a bare
`main()`, so *importing* it ran the CLI. `ui.ts` imports `allowanceMist` from it to show the
on-chain allowance, so `bun src/ui.ts` printed the agent's usage line and exited 2 before it
ever listened. The bare call had been harmless for weeks because nothing imported that file —
which is a property of the CALLERS, not of the module, so the guard belongs in the module:
`if (import.meta.main)`. Two things make this one expensive to find:

- the symptom names the wrong program. Starting the server prints `usage: node src/agent.js`,
  which reads as "agent.ts was run", not as "the server failed to start";
- **and the already-running server keeps working**, because it holds a bundle built at its own
  startup. So the failure is invisible until the next restart, and every check you run against
  the live port passes. Start a fresh process (`UI_PORT=8899 bun src/ui.ts`) — the second
  instance is what tells you the truth.

**The served CSS and JS are built ONCE, at startup, and held in memory.** `buildAppBundle()` runs
in the listen path and `appBundle.css` is served from that snapshot, so editing `app.css` and
reloading the browser shows the OLD theme. **Everything served now comes from that snapshot** — the
page modules that used to be read per request went with the old page, so this is no longer a
difference between two kinds of route but the only way to see a change at all. Restart after a
style change, or check on a second port.

**An opacity tier on a TEXT COLOUR is a dark-theme assumption.** `text-muted-foreground/60` reads
fine on near-black and is 2.25:1 on cream; `/50` is 1.94:1, `/40` is 1.68:1. Matsu's
`--muted-foreground` is itself the floor at 4.45:1, so on this palette there is no lighter tier at
all — 21 sites in six components became the plain token, and the hierarchy they encoded is carried
by size, weight and case instead. The measurements live in `app.css` beside the token. ANY palette
swap has to be checked for this: the `/NN` suffixes are invisible in a diff of the theme file
alone, and every one of them was fine before.

**The gate demanded a grant for every action, including reads, while the docs said it did not.**
`HANDOFF` claimed "a talent that only reads does not need one" from the day the talent vocabulary
landed, and `validate` contradicted it the whole time: the `hire` check sat before every
action-specific branch, so a read was refused with "no hire matched". A sentence the code
disagrees with is this project's dominant bug class, and this one was found by RUNNING a read
rather than by reading the gate — which is the only way it could have been found, because the gate
looks correct until you ask it for something that is not a swap.

The fix is a property the gate has to know **before** it judges: `spends` is declared by the
talent, because the gate cannot wait to see what an action does before deciding whether to demand
a grant. Fail-closed, so an action nothing provides counts as spending. The whole story is in
`DECISIONS.md`; the assertion that keeps it true — a read reports `hire: null`, and the SWAP still
reports one — is in `src/verify-query.js`.

**When a draft spec and a reference implementation disagree, the implementation is the current
one — and the disagreement is worth writing down.** A service fee is `{ "x402": { "asset", "amount" } }`
in `docs/MCP-STANDARD.md` and `terms: { minFeeOut, feeAsset, … }` in the filler that actually
serves fills. Both spellings mean one fee; the doc is the older one and says of itself that it is a
draft. The new query server follows the code. The trap is not the doc being wrong — it is that a
reader who follows the doc will send a manifest field no server reads, and get a fill that looks
free.

**A budget that reads as a total and is not is worse than no budget — and there are two ways to
make it one, only one of which works.** The ledger (`spend_vault`) is the only thing that can bound
total spend, and its public surface has **no credit-back**: `set_allowance` is owner-gated, `spend`
only debits, `revoke` removes. So "draw the escrow out of the vault at creation" — the obvious
reading of "move the escrow into the vault" — leaks the budget of every order that expires, and with
a 60-second window expiry is the common case. The choice that survives is to draw at SETTLEMENT: the
commitment holds nothing, and an expired one costs no budget at all. The price is that the ceiling is
not reserved, which is stated in the code, in DECISIONS.md and in HANDOFF rather than discovered
later. Before designing anything on top of a ledger, enumerate what it can DEBIT and whether anything
can CREDIT — a limit whose only writer is the owner cannot be given back by a permissionless path.

**A destination that the caller supplies is a hole the moment the funds are not theirs.** The wallet
order path takes a `destination` and that is right: it is the maker's own escrowed coin. The
vault-funded path must NOT, because the money is the owner's — with a caller-chosen destination,
anyone could commit the owner's funds to their own address. `create_from_vault` therefore has no
destination parameter at all, and takes the policy's. Copying the neighbouring signature would have
been the natural thing to do and it would have shipped a theft.

**A completion claim written from the plan is not a claim about the code.** The old page at `/`
carried the note "the app at `/app` now covers swap, orders, and every policy boundary. Nothing in `/`
is unreachable from `/app`. Mostly a deletion." Seven operations had NO control in `/app` — `topup`,
`withdraw`, `position`, `deposit`, `rebalance`, `redeem`, `repoint` — and the component written for
them (`ActionForm.tsx`) had never been rendered even once. The store server-side could build all
sixteen kinds the whole time, which is exactly what makes this shape sneaky: the capability is
there, so a grep for the feature succeeds, and only a grep for the CALLER shows that nothing
reaches it. Before deleting a UI on the grounds that its replacement covers the same ground,
enumerate the replacement's controls and diff them against the ones being removed — `grep "<"` on
the component is enough, and it takes a minute.

The deletion itself was still right, and the distinction it turned on is worth keeping: what went
was the UI path, not the capability. Every one of the seven still has an `--emit-bytes` script, and
signing is the wallet's job either way — so nothing became impossible, only inconvenient.

**A flat fee is the filler's ABSOLUTE floor, so a minimum trade size is real — and "fixing" the flat
fee is the trap.** The default fee for a new order is `10^decimals / 100` — 0.01 of the output coin.
That LOOKS like a dust-size bug when a 0.01 SUI trade (quoting ~0.012 USDC) is refused, since the fee
is then 84% of the output. It is not a bug: `MCP_MIN_FEE_OUT` is 0.01 USDC, an absolute cost the
reference filler enforces with `fee < floor → refuse`, so a maker offering less escrows money nobody
will take. The output must cover the floor plus something for the maker, and that puts a floor under
the trade SIZE.

**I got this backwards first, and the entry is kept because the reversal is the lesson.** I made the
default proportional — ten basis points of the live quote — and it did make the 0.01 SUI order build:
escrow 0.01 SUI, fee 0.000012 USDC, `ok` from the simulation. Every one of those would have been
refused by the filler and expired. **The build succeeding was the bug, not the fix.** When a bound is
ABSOLUTE, a value that scales to meet it is a value that fails below it.

The real defect was the MESSAGE: it listed three possible causes and named no figure, so a trade that
was simply too small read like a broken aggregator. It now names the fee, what the maker would
receive, and the input that WOULD work — derived from the live quote rather than written down,
because a hardcoded threshold is wrong by the afternoon.

**A budget is per COIN, and one of them was hardcoded.** `set_allowance` is keyed by
`(cap_id, coin_type)`, so a SUI ceiling and a USDC ceiling are different rows of the ledger — but the
policy path wrote `typeArguments: [SUI_TYPE]`, so a USDC grant was not impossible to express, it was
impossible to REACH: a USDC order aborted `EExceedsAllowance` against a grant of zero and the sheet
had no way to fix it. The hop is three files wide (sheet → route → script) and **each one looked
right on its own**, which is why the check asserts the RELATIONSHIP rather than any single file: the
sheet names the coin, the route passes it, the script uses it as the type argument.

**THE POOL'S OWN ERROR NAME SETTLED THIS IN ONE GREP, AND THAT IS THE GENERAL LESSON.**
`USDC -> SUI` orders aborted in the pool with `abort code: 11` inside `pool::flash_swap_internal` and
expired unfilled — twice — while everything on OUR side looked right: the direction was in the table,
the escrow built, the filler simulated, the gate allowed it. Fetching Cetus's own `pool.move`:

```move
const EWrongSqrtPriceLimit: u64 = 11;
...
if (a2b) {
    assert!(pool.current_sqrt_price > sqrt_price_limit && ..., EWrongSqrtPriceLimit);
} else {
    assert!(pool.current_sqrt_price < sqrt_price_limit && ..., EWrongSqrtPriceLimit);
}
```

The limit must sit BELOW the current price for `a2b` and ABOVE it for `b2a`. The filler sent
`current * (10_000 + slippage) / 10_000` unconditionally — the `b2a` form — which is exactly why every
SUI -> USDC order filled and every USDC -> SUI order died.

**Our own slippage bound could not have caught it.** `assert_within_bps` compares MAGNITUDES and is
symmetric about the side, so a wrong-side limit passes our check and is refused by the pool. A
symmetric check on a direction-dependent value will never notice which way it points. The sign now
lives in `DIRECTIONS.limitSign`, beside the settle entry point, because it is the same kind of fact.

When an abort comes from a DEPENDENCY, fetch its source: the abort code named nothing, and its error
constant named everything.

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

**`listEvents` ignores every filter; `listTransactions` honours one — and says so.**

`listEvents` silently returns everything regardless of filter shape, which is why this
project concluded it was "notified, not watching" and gave up on discovering orders. That
conclusion was drawn from the WRONG METHOD. `listTransactions` accepts a filter and
**validates** it:

```js
await client.listTransactions({ filter: { sender: ADDRESS }, limit: 3 })
```

Passing `FromAddress` (the JSON-RPC spelling) is rejected with *"A transaction filter must
specify exactly one of sender, function"* — a refusal, not a silent no-op. That difference
is the whole point: one method tells you your filter is wrong, the other pretends it worked.

Verified by filtering, not by calling: a nonsense address returns **0** rows while the
deployer and the agent each return 3. Row shape is `{ $kind, Transaction: { digest,
 timestampMs, checkpoint, status } }` — the digest is what `findCreatedOrder` consumes.

So discovery IS possible: enumerate the maker's transactions, read the order id from each
create, then check each order's state. The earlier "shared objects cannot be listed by type"
remains true — that is a different limitation and it still holds — but it never implied this
one.

**The general lesson:** "the SDK ignores filters" was a conclusion about ONE method. Testing
a second method's filter with a value that cannot match is cheap, and it is the difference
between a design constraint and a mistaken belief. A filter is not proven by calling it; it
is proven by giving it something that must fail.

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

**MVR cannot resolve `@deepbook/core`, and the repo's `main` is not mainnet.**
`deepbook = { r.mvr = "@deepbook/core" }` — the form DeepBook's own skill documents — fails
with `Version 8 of @deepbook/core does not have git information specified`: MVR's record for
that version carries no git rev, so no source dependency can be built. Same registry gap that
forced `spend_vault` to be inlined. It is pinned to git at the `v8.0.0` tag instead, and that
tag was chosen by matching the DEPLOYED ABI rather than by taking the newest one: `main`
carries `pool::place_post_only_limit_order`, which mainnet v8 does not have, so compiling
against `main` would link a call that aborts on chain. A version pin is a claim about the
chain — check it against the chain's ABI, not against the docs (whose address table still
stops at v6) and not against the default branch.

**`share_object` is module-restricted; `public_share_object` is the path for a dependency's
type.** Sharing DeepBook's `BalanceManager` from `deepbook_guard::create` is refused —
`Invalid private transfer ... restricted to being called in the object's module` — and the
same diagnostic names the fix, because that type has `store`. The private form only works on
a type the calling module declares, which is why `transfer::share_object(guard)` is right for
our own guard one line below and wrong for the BalanceManager above it.

**DeepBook's `OrderInfo` is not declared by the module that returns it.** `pool::place_limit_order`
returns `OrderInfo`, but the type lives in `deepbook::order_info`, and its source sits in
`sources/book/order_info.move` — so neither the returning module nor the file path names it. A
wrapper that returns it has to import it separately. The compiler reports it as an unbound type,
which reads like the function returns nothing rather than like a missing import.

**`let _ = f()` does not discard a tuple.** A test helper returning `(ID, ID)` cannot be dropped
with `let _ =`; the compiler rejects it as an expression-list type and the fix is `let (_, _) =`.
A single-value return drops fine, so the error only appears on the helpers that return a pair —
which is exactly the shape a setup helper has, and exactly where a test wants to ignore both
halves.

**An `expected_failure` test must still consume every owned object on the path it never reaches.**
`let _ = expr` does not discard a value without `drop`, and an owned object still alive at `s.end()`
is a compile error — so an abort test has to consume the objects the abort would have skipped, on
lines the VM never executes. Two compile cycles on the guard tests, both in tests that were correct
by design. Bind the value and transfer it, or transfer it before the call.

**DeepBook's abort codes are private, so a test must name the literal.** `EInvalidTrader` and its
neighbours are plain private constants in `deepbook::balance_manager`, unreachable from a dependent
package's tests. `#[expected_failure(abort_code = 1)]` with a comment saying which constant it is
is the only form available; reading the source is how the number gets known. 0 is `EInvalidOwner`,
1 is `EInvalidTrader`.

**A Move module can never be `ctx.sender()`, so an address gate cannot admit a contract.** The plan
carried a "programmable agent" flavor: the guard's `agent` set to a Move contract holding the
strategy. It cannot work — `ctx.sender()` is the transaction signer, and a module does not sign.
Programmability needs the gate to become a *presented capability* (an `AgentCap` object) instead of
an address, which is a different trust shape: today there is nothing at the operator to steal, and
a capability is precisely a stealable thing. Written down before anyone builds it twice.

**DeepBook's per-level quantities disagree with the documented lot size, and one read cannot say
why.** A live `get_level2_ticks_from_mid` on the SUI/USDC pool returns bid levels whose gaps are all
multiples of 10 — the documented `0.00001` tick at this pool's 1e6 price scale, so the PRICE side
checks out — with best bid/ask of `1_159_960` / `1_160_080`, i.e. 1.16 USDC per SUI. The QUANTITY
side does not. Sampled per-level quantities of `864_000_000_000`, `4_318_600_000_000` and
`216_000_000_000` are not multiples of the documented 0.1 SUI lot (1e8) under that scale, nor under
1e9-per-token, nor under 1e6. Two readings, one source, and a read cannot say which is wrong.

Settle it with one order that must align: ask for exactly 0.1 SUI and see whether DeepBook refuses
it, then read the quantity back. That needs the guard module published, so it is blocked on the
publish. Until then `quantityScale` in `src/deepbook.ts` is marked UNVERIFIED and
`src/verify-deepbook.js` prints the numbers instead of asserting them.

**Dead storage has to go before an irreversible publish, not after.** `deepbook_guard` stored all
three DeepBook capabilities and used one. The other two could never be read: `BalanceManager`'s
`owner` is set only in the `new*` constructors and has **no setter anywhere** in the module, and
`create` takes the BalanceManager **by value**, which in Sui only an owner can do — so the maker is
permanently the account's owner, and DeepBook's owner paths (`deposit`, `withdraw`, `withdraw_all`)
go through `generate_proof_as_owner` and take no capability at all. Two fields that nothing could
ever read, in a struct a Sui upgrade cannot slim: `Published.toml`'s own comment on `spend_vault`
("an upgrade cannot remove a module that is already part of a published package") is the same
lesson one level down, at field granularity. The cost of finding it late is a guard that carries
two dead fields forever.

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

