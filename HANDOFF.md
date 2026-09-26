# Handoff

For the next agent, and for anyone picking this up cold.

**What this is:** an on-device AI agent wallet for Sui. Keys never leave the device — no TEE, no
delegated MPC share, no third-party custody. A local model turns a sentence into an action; the
chain enforces the boundary; the extension signs.

**Read this first, then `NOTES.md`, then query mempal.** `NOTES.md` is the traps ledger — every
entry in it cost real time. Mempal is the reasoning behind the decisions, including the ones that
were later reversed.

---

## 1. Current state

**Package v9 is live on mainnet.** Everything below was read from `src/addresses.ts` and
`move/Published.toml`, not recalled.

```text
package v9          0xe420d1be090d84763b55ee6051cee1c346888d7ec8107af41e9172cc9ef8b864
original id (v1)    0x2441fb74d7684f43019fdabf27d6de24dc8e42826ddd86ba07bc21aded80c014
upgrade cap         0x50a57fce03614745395e2a9e1aac204cfd0f7979532106669066283898b97ec9
modules             deepbook_guard · order · policy · position_guard · spend_vault
CLI                 1.80.0

vault               0x153bb450c5bbb06c4587f95eec2b14f81cd6163792d43b59175a6df6504c2d42  (EMPTY)
owner cap           0x7150c87b41ba35e8841acc0ab146ba7f0dbb6dd032d4a15860b1f7c641953372
policy (standard)   0x8a68c6ebb9aab5ef378c51172a88b23c3cad51ec62b8b7c96ab847a5f9f820c0
spender cap         0x21b3bb053c65eed825cd7acb80417dd11dd437e057c3c056a5fab789b4c00580
position guard      0x62ced3a9785fb75a8f4188b1da311ab1975fbad9c585069b71d05cf649ba3754
pool 0.05%          0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab
pool 0.01%          0x413ddc5745aa6398e9da66c4843947e479f4bf63bade39ffc94c9197b433b332
agent wallet        0x199ca42b8c437bd4e1a440e0d15667bfc27291725680bb7a51bc4248165f8603
deployer / owner    0x0b3fc768f8bb3c772321e3e7781cac4a45585b4bc64043686beb634d65341798
USDC type           0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC
```text

**Four processes must be running.** The UI is useless without the first, and a talent whose server
is down refuses rather than guesses.

```bash
qvac serve openai              # the local model, port 11434
bun src/ui.ts                  # the app, 127.0.0.1:8788, token rotates each start
bun src/mcp-server.ts          # the reference filler, 127.0.0.1:8790
bun src/query-server.ts        # the read-only data server, 127.0.0.1:8791
```text

`bun run verify` runs one tsc pass and seven check suites — `verify-intent`, `verify-page`,
`verify-guard`, `verify-order`, `verify-query`, `verify-deepbook`, `verify-runner`. **Run it as its
own step** — batching it with `git commit` has shipped a red verify twice.

Note the shape, because a single "/N passed" is not what this prints: four suites report their own
totals (`verify-order` 9, `verify-query` 22, `verify-deepbook` 21, `verify-runner` 29 as of the
guard) and others report only `all checks passed`. A green run is `exit 0` with no `FAIL` line,
not one number.

---

## 2. Proven on mainnet

Not asserted — each of these has a transaction behind it.

```text
six original operations    policy, vault, guard, deposit, rebalance, redeem
the order escrow           create → fill → reclaim, and refund on expiry
ENotAgent                  a swap from the wrong address aborts on chain
storage rebate             measured: 0.004198392 SUI net from a burn
the allowance bound        v8: 0.01 against a 0.01 grant passes, 0.02 aborts
                           and live: 0.06 refused against 0.05, then 0.05 escrowed,
                           filled (58691 out, 50000000 in), reclaimed
the read path              "check my balances" -> ANSWERED, chain-sourced, the agent
                           wallet's SUI and USDC. THE ONE CLAIM HERE WITH NO
                           TRANSACTION BEHIND IT, and that is the point: a read
                           moves nothing, so there is no digest to name. What
                           proves it instead is that the gate reports `hire: null`
                           (no grant consulted) and that removing the talent makes
                           the same request refuse.
```text

**The full loop, once, in the user's own words:**

```text
0.05           refused — more than the 0.01 grant
policy DpFbvr4sRMXqp9ewHZEtL4XVAsqGTr4CnAiVFZCS31Ln   raised to 0.05
0.06           refused — more than the 0.05 grant
0.05           escrowed 4NZYCbRstwCEeamnukYH6SRN6Efh5iQgDKSEP5Z5zTZC
               filled   CNMbELdN5g2fG2FmPtbXdbuYAnpcFAnVf9q8RKzgccPW
               reclaimed 8u9HP1mEFvPQAcJ2f8itkyeWDD5dWfYBSavMGnrGxk4B
```text

---

## 3. The model, in one place

Three nouns. Getting them wrong is the most common way to misread this codebase.

```text
talent     how the agent reaches a SERVER, one to one. `swap` is a talent; its server is the
           reference filler. A manifest describes the SERVER, never the agent — offering the
           server's `fill` as the agent's own action was a real bug.

grant      an on-chain permission. A talent that spends needs one; a talent that only reads
           does not. Installing is off-chain; a grant is on-chain — a download vs a permission.
           WHICH OF THE TWO IS NOW DECLARED BY THE TALENT (`spends` on the action) and read by
           the gate before it judges anything, so a read is never asked to name a hire.

order      what a swap actually creates. It ESCROWS from the maker's wallet, holds min_out (what
           the maker receives), carries the filler's fee inside it, and expires in one minute.
```text

**The policy's five fields, and which of them bite.** A swap does not use the vault path, so this
is not uniform:

```text
agent          BITES   the settler must be the policy's agent
allowed_pools  BITES   the settler's pool must be approved
budget         BITES   per ORDER, since v8 — see the limit below
suspended      does not stop a fill. order.move never checks is_suspended.
max_slippage   does not apply to an order. min_out is the bound instead.
```text

**The budget is a per-order ceiling, NOT a spending total.** The allowance is read and never
decremented, so several orders of the same size each pass a grant that covers one. Decrementing
needs `spend_vault::spend`, which draws from the **vault** — a different pot from the wallet the
escrow comes out of. Making it a total means moving the escrow into the vault. That is a change to
where funds live, not a check added somewhere.

---

## 4. Open work, ranked

**1. The query talent — LANDED.** Balances and object lookup, the first capability that does not
move value, the first that would pay for data rather than trade, and the first genuinely **remote**
talent — the case the 1-to-1 model was built for. `src/query-server.ts` is the server (read-only,
holds no key, no fill route); the client's half is the `status` action and the gate's `spends`
branch. **What is NOT done: x402 settlement.** The price seam is in the server and deliberately off,
so nothing advertises a price that cannot be paid — turn it on when a client can draw from the
vault to pay one.

**2. USDC → SUI — LANDED**, with one OWNER action outstanding.

The direction is executable end to end now: `DIRECTIONS` in `src/addresses.ts` is the single table
(the input coin, the output coin, and which settle entry point), the escrow takes its coin from it,
the gate accepts both directions, and ONE filler picks `settle_a2b` or `settle_b2a` by reading the
coin off the order's own object type. The talent's title offers both, which it now does.

**What blocked a real trade, and it was never the direction:** the policy's cap held no USDC
allowance, so `create_with_policy` aborted `EExceedsAllowance` — verified by building the escrow
against mainnet, where the PTB resolved a real USDC coin and reached that assert.

**FIXED, and this is the fix that matters for that item:** the budget path is PER COIN now (`COINS`
in `addresses.ts`, threaded sheet → route → script), so a USDC ceiling can be granted at all. A 0.5
USDC grant **builds and simulates**; it still needs ONE signature from you in the policy sheet before
a USDC order can settle, because the app can build a grant and only the wallet can sign it.

**Also fixed, found in the same test:** the refusal for a trade too small to pay the filler's fee was
unreadable — it listed three possible causes and named no figure, so "the trade is below the filler's
minimum" looked like a broken aggregator. It now names the fee, what the maker would receive, and the
input that would actually work, derived from the live quote.

**Also fixed, found in the same test:** the FILLER's price limit sat on the wrong side for `a2b`.
`flash_swap_internal` aborts with `EWrongSqrtPriceLimit` (code 11) unless the limit is BELOW the
current price when selling A — the filler sent `current * 1.01` unconditionally, which is the `b2a`
form, so every USDC -> SUI order died in the pool and expired. The sign is now `DIRECTIONS.limitSign`,
beside the settle entry point. Our own `assert_within_bps` is symmetric and could never have caught it.

**And the fee default is unchanged, and must stay so.** `MCP_MIN_FEE_OUT` is an ABSOLUTE 0.01 USDC and
the reference filler refuses anything below it, so a fee that scales down with the trade merely
escrows money nobody takes. The minimum TRADE SIZE that follows is real. `NOTES.md` has the whole correction,
including the proportional-fee fix I made first and had to undo.

**Deliberately NOT invented here:** whether a USDC budget should require the VAULT to hold USDC.
The budget script enforces that for SUI and it is the right guard for the vault path — but the
escrow path draws from the maker's WALLET, so for an order it is a precondition nothing needs.
Resolving that is a design decision, not a mechanical change.

**3. Move the escrow into the vault — IN SOURCE, STAGED, NOT PUBLISHED.** The only way the budget
becomes a true spending total, and it is written and unit-tested. `policy::spend_balance_from_vault`
is the primitive that was missing (the vault path could spend and not enforce a floor; the order path
could enforce a floor and not spend), and `order::create_from_vault` +
`settle_from_vault_a2b`/`_b2a` make the escrow the VAULT's instead of the wallet's.

**THE DESIGN DIFFERS from the one line this file used to carry, and the difference matters.** The
draw happens at SETTLEMENT, not at creation: `spend_vault` has no credit-back — `set_allowance` is
owner-gated and `spend` only debits — so an order that drew at creation and then expired could never
return the budget it took, and with a 60-second window expiry is routine rather than an edge. The
cost of that choice, stated plainly: the ceiling is NOT reserved, so a maker who commits more than
the remaining budget gets the first settlement and not the second. Read `create_from_vault`'s own
note before publishing.

**NOTHING IS WIRED TO IT, deliberately.** No script, no gate branch, no UI — a caller cannot name a
package id that does not exist, and this project does not export earlier ids. Publishing is
**version 9**, roughly 0.1 SUI, with the UpgradeCap in the deployer wallet. Trigger to publish: any
other Move change to batch with it, or the decision that the budget should bound total spend.
`bun run test` → 61 passing, 6 of them new.

**4. Delete the old page at `/` — DONE.** `/` and its four modules are gone (`page.js`, `markup.js`,
`/units.js`, `/events.js`); all five answer 404 and `/app` is unaffected. **Its premise was false when
it was written**, and that is worth keeping rather than tidying away: "Nothing in `/` is unreachable
from `/app`" was not true. Seven operations had no control in `/app` at all — **`topup`, `withdraw`,
`position`, `deposit`, `rebalance`, `redeem`, `repoint`** — and `ActionForm.tsx`, whose own comment
says "one pattern, ten uses", was written for exactly those and is still never rendered.

What the deletion actually removed was their **UI**, not the capability: every one of them still has
an `--emit-bytes` script and the documented `execute-signed-tx` submission path, so an operator can
still do all seven by hand. The pressing two are `topup` and `withdraw` — the vault is the custody
pot, and there is now no way to put money in or take it out from a page.

**5. On-chain registry** — Walrus + SuiNS, so a talent can be discovered rather than pasted.

---

## 5. Rules that were learned the hard way

**Run it rather than read it.** Every significant bug in the last stretch was found by executing
something, not by reading it. Five rounds of theories once defended a transaction that had never
been sent, because a script documented `--emit-bytes` and never implemented it.

**Verify in the SERVED bundle.** The source being right is not the browser receiving it. Tokens
once rendered black-on-white because they were defined behind a class nothing applied, and `grep`
found the names and called it verified. Nothing that looks for a NAME can tell defined from in
effect.

**A check that names a file and a function describes a SHAPE, and shapes move.** Four checks in one
session failed on correct code for this reason. Assert a RELATIONSHIP — "one reader, used by both
callers" — not a location.

**A check written to fail on improvement is only worth having if the failure stops the push.**

**Read the file before you replace in it.** `sed 's/^/  /'` for display adds two spaces, and
pasting that output into a search pattern silently matches nothing. A global string replace across
an unre-read file is the same mistake one level up — it rewrote seven correct test call sites.

**A claim that disagrees with the code is the dominant bug class here.** A comment, a check, a
title, a registry constant, a manifest. The registry's `budgetSui` was shown as the current budget
for months — 0.03 against a real 0.01 — and the old page had labelled it "local" while the new one
dropped the caveat.

**A limit that reads as enforced and is not is worse than no limit**, because a maker sizes a trade
to it. That is how the allowance gap was found: the user asked why a 0.05 swap proposed against a
0.01 allowance. Nothing was broken; something was absent and the UI implied otherwise.

---

## 6. Where to look

```text
NOTES.md                  the traps ledger. Read it before touching Move or the upgrade path.
docs/ARCHITECTURE.md      how the pieces fit
docs/DECISIONS.md         why, including the reversals
docs/ORDER-ESCROW.md      the order model in full
docs/MCP-STANDARD.md      the filler protocol. PREDATES the talent vocabulary and the manifest
                          rule — treat it as a draft, not as current
docs/ROADMAP.md           where this is going
src/web/events.ts         the event vocabulary. An unclassified kind is VISIBLE by design.
src/db.ts                 chats, messages, talents. Chain state is never cached.
src/query-server.ts       the read-only reference server. Holds no key by design.
src/verify-query.js       the read path's acceptance check, incl. the grant boundary.
```text

**Mempal** holds the reasoning, in wing `sui-tokyo`. Query it before assuming — several drawers
record corrections that supersede earlier ones, including one that supersedes a conclusion drawn
from the wrong SDK method.

**The working rule that matters most:** when something is claimed, ask which transaction proves it.
If there is no transaction, it is a comment.
