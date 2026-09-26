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

**Package v8 is live on mainnet.** Everything below was read from `src/addresses.ts` and
`move/Published.toml`, not recalled.

```text
package v8          0x4529c5490947c2c13997fabe78dfcc38f8645da3582713891eb1620eac4d0632
original id (v1)    0x2441fb74d7684f43019fdabf27d6de24dc8e42826ddd86ba07bc21aded80c014
upgrade cap         0x50a57fce03614745395e2a9e1aac204cfd0f7979532106669066283898b97ec9
modules             order · policy · position_guard · spend_vault
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

**Three processes must be running.** The UI is useless without the first.

```bash
qvac serve openai              # the local model, port 11434
bun src/ui.ts                  # the app, 127.0.0.1:8788, token rotates each start
bun src/mcp-server.ts          # the reference filler, 127.0.0.1:8790
```text

`bun run verify` runs one tsc pass and four check suites. **Run it as its own step** — batching it
with `git commit` has shipped a red verify twice.

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

**1. The query talent.** Balances and object lookup. The first capability that does not move value,
the first that would pay for data rather than trade, and the first genuinely **remote** talent —
which is the case the 1-to-1 model was built for and has not been exercised. **x402 belongs here**,
on a non-fill route. It must never charge for a fill.

**2. USDC → SUI.** The contract path exists (`settle_a2b`) and nothing calls it. Needs an order
escrowing USDC and a filler settling the other direction. The talent's title was corrected once
already for promising this direction while nothing implemented it.

**3. Move the escrow into the vault.** The only way the budget becomes a true spending total. Big:
it changes where the funds live, and `settle`/`refund` would have to return them to the vault.

**4. Delete the old page at `/`.** The app at `/app` now covers swap, orders, and every policy
boundary. Nothing in `/` is unreachable from `/app`. Mostly a deletion.

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
```text

**Mempal** holds the reasoning, in wing `sui-tokyo`. Query it before assuming — several drawers
record corrections that supersede earlier ones, including one that supersedes a conclusion drawn
from the wrong SDK method.

**The working rule that matters most:** when something is claimed, ask which transaction proves it.
If there is no transaction, it is a comment.
