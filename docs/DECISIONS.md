# Decisions

The reasoning behind the design, including what was rejected and why. Recorded
because a decision without its alternatives gets re-litigated, and because the
rejected options were often rejected for reasons that are not obvious later.

Format: **Decision** · **Why** · **Rejected** · **Consequence**.

---

## On-device signing; no TEE, no delegated MPC

**Status:** implemented.

**Decision.** Keys never leave the device. Signing is done by the wallet
extension. The server builds a transaction, keeps the bytes under an id, and
submits bytes plus a signature it was handed.

**Why.** For an agent wallet the only claim worth making is that the agent cannot
move funds beyond its grant, and that claim is meaningful only if the key is not
somewhere the operator can use it.

**Rejected.**
- **WaaP** (TEE-based "keyless" wallet). A TEE means trusting the vendor's
  enclave, which is vendor custody with extra steps. The CLI package was
  uninstalled and nothing remained on disk.
- **Delegated MPC** (AgentBazar's model, via Dynamic). A server-side signing
  share makes the on-chain limit advisory, because the delegate can sign anything
  the OwnerCap allows.

**Consequence.** The on-chain allowance becomes the enforcement rather than a
policy written in a server. Every other decision follows from this one.

---

## OpenZeppelin `spend_vault` over native `sui::allowance`

**Status:** implemented (vendored by inlining).

**Decision.** Use OpenZeppelin's vault as the budget ledger.

**Why.** Native allowances are **disabled on mainnet at protocol 136**
(`enable_allowances` is absent), while the accumulator flags
`enable_accumulators` and `enable_object_funds_withdraw` are on. The native path
is unavailable today.

**Bonus.** Inlining also removed an "unpublished dependency" problem that was
blocking upgrades: the first publish used `--with-unpublished-dependencies` and
later builds resolved it externally, so an upgrade saw a module as removed
(`EUC01006`).

**Explicitly not the fix:** `--skip-verify-compatibility`. It would strip
`spend_vault` and orphan the Vault, the Policy and both caps.

**Consequence.** The ledger is keyed `(cap_id, coin_type)` →
`{remaining, expires_at_ms}`. `set_allowance` is an **upsert** keyed by the cap,
explaining why the budget can change without touching the permission — and why
"Fund vault" and "Set budget" are separate buttons.

---

## Model proposes, deterministic code disposes

**Status:** implemented. Check: `src/verify-intent.js` (8/8).

**Decision.** The local model only **extracts parameters**. Amount conversion,
the gate, and **which hire or action handles the request** are deterministic.
Selection comes from the user's words, never from the model.

**Why.** Proved three ways that a 0.6B model will not emit an empty string in a
required enum while non-empty options exist. So it cannot be trusted to answer
"no hire" — and it kept proposing agents the user had not named.

**Also decided.** Every model claim is grounded against the user's own text
(`groundedInRequest`). If the model asserts a value the user never said, it is
visible.

**Consequence.** This grounding becomes load-bearing rather than nice once
publishers supply their own prompts to the marketplace: the prompt is then
untrusted third-party input, and the model's output sets the amount. The user's
own words are the anchor; the allowance is the backstop.

---

## The build/submit split

**Status:** implemented.

**Decision.** `POST /api/build` returns a build id and the bytes to sign; the
browser asks the extension to sign; `POST /api/submit` posts `{id, signature}`
and the server submits. Sui's `execute-signed-tx` submits already-signed bytes and
cannot sign, so the submitting process holds no key.

**Why.** The server must not be able to sign. This is what makes the chain the
enforcement.

**Side effect worth knowing.** `tx.build({ client })` resolves **and simulates**,
so a doomed transaction is refused *before* the user is asked to approve it.
Excellent for gas; it also means this path can never produce an on-chain failure.

**Consequence.** Every action uses the same three steps: swap, suspend, fund
vault, set budget, venue open/close, and the whole position lifecycle.

---

## Three money flows stay distinct

**Status:** implemented except agent rewards.

| flow | from → to | where | enforced by |
| --- | --- | --- | --- |
| **x402 service fee** | user → MCP server | per HTTP call, USDC | the server (it can refuse service) |
| **allowance spend** | vault → the action | on chain | Move + the OZ ledger |
| **agent reward** | the action → agent | on chain | needs a contract |

**Decision.** Model them separately and never conflate them.

**Why.** x402 pays for the **service**; the allowance bounds the **capital**. A
server that takes an x402 fee and then exceeds the allowance is exactly what the
on-chain cap exists to prevent — and an off-chain cap cannot prevent it, because
in that scenario the server is the misbehaving party.

**Consequence, unresolved.** Agent rewards **break the policy's core invariant**
that the caller cannot choose where value goes. Today everything routes to
`policy.destination`, which is precisely why a compromised agent cannot redirect
funds. Paying an agent needs deliberate design (`fee_bps` + `fee_recipient` on the
policy, or a separate fee vault), plus answers on measuring performance and
handling a loss. Not a small addition.

**Gas note.** Gas is **not** covered by the allowance. An MCP server holding an
agent key must fund its own gas, which bounds a key compromise to the gas wallet.

---

## Config off-chain, limits on-chain

**Status:** decided; partially implemented (limits exist, the missing ones are new
Move).

**Decision.** Per-strategy **config** lives in the MCP server, off chain. **Limits**
live on chain in Move.

**Why — and this is the whole question.** They are different things:

- **Config** is a *setting*: pool, tick range, schedule, fee bps, prompt, UI
  metadata. A wrong value produces a bad action or a refused one. Off chain is
  obviously right: cheap, flexible, per publisher.
- A **limit** is a *security boundary*: how much, by whom, where, until when. Its
  only job is to hold when the thing being limited **misbehaves**. If the server
  both enforces the limit and is bounded by it, the limit is a comment.

**What actually decides it — can the server sign without a human?**

```text
Today (wallet extension, server holds no key):
    the user clicks Run, the wallet signs.
    Your SIGNATURE is the enforcement. An off-chain limit would be advisory.

The interval / cron strategy:
    the server signs UNATTENDED. There is no human click to be the enforcement.
    → an off-chain limit would be enforced by the party it constrains.
```

So the interval strategy **forces limits on chain**. That strategy was proposed in
the same conversation as the suggestion to move config off chain, which is why
the two had to be separated explicitly.

**Gas is not the reason.** `set_allowance` is one owner transaction at roughly
0.01 SUI, done repeatedly during testing. The reason to prefer off chain is
flexibility, and the wanted flexibility lives in config.

**Rejected.** AgentBazar's approach: the grant stored in Vercel KV and enforced
server-side, *plus* delegated MPC so the server can sign. Both halves are what
this project exists to avoid. Their **product shape** is still worth copying —
see the next entry.

**Consequence.** The on-chain cap is the only thing between a buggy or hostile MCP
server and the vault. The missing limit features are therefore load-bearing, not
polish.

---

## Per-server agent identity

**Status:** **implemented.** `hire-agent.js --repoint` hands a grant to a different
address and sets its price bound in one transaction.

**Decision.** Each MCP server is its own agent address. The policy's `agent` is
that address. The OwnerCap never leaves the device.

**Why it costs almost nothing.** The model already supports it: one policy per
agent address, one cap per policy, one allowance per cap. Issuing one policy per
MCP server is a **configuration** change, not a contract change.

**Why it mattered more than it looked.** While `agent == owner`, **no agent path
could be refused for being the wrong caller** on mainnet. `ENotAgent` and
`ESuspended` had never fired on chain.

To be precise about what was and was not covered, because the two are easily
conflated: the Move test suite DOES assert these gates — `non_agent_aborts`,
`suspended_policy_aborts`, tick-width bounds, cap binding, and agent rotation. So the
logic was unit-tested. What had never happened was a refusal on mainnet against a
separate caller — the difference between "the gate is coded correctly" and "the gate
is the thing standing between a hostile caller and the funds".

That difference is now closed for `ENotAgent`: after the handover, a swap submitted
from the owner's address aborts on chain in `assert_agent_gates`. `ESuspended`
remains unit-tested only.

**Why the agent key is safe on a server.** It holds nothing — no funds, only a
bounded permission. Its gas wallet bounds a compromise further.

---

## Adopt AgentBazar's grant features, on chain

**Status:** features identified, new Move required.

**Decision.** Take their **field list** as the product requirement and implement it
in Move.

**What our policy expresses today:** `agent`, `destination`, `suspended`,
`allowed_pools`, `cap_id` (`vault_id` fixed at create).

**What it cannot express, and they have:**

| their field | gap in ours | why it matters |
| --- | --- | --- |
| `maxUsdcPerTx` | ours is cumulative only | a grant can be drained in one call |
| `maxUsdcDaily` + `dailySpentUsdc` | no rate limit at all | nothing bounds frequency or burst |
| `allowedVersions` | per-venue only | "may swap but not rebalance" is not expressible |
| `revokedAt` | a bare `suspended` boolean | no timestamp; the policy itself has no expiry |
| — | **no slippage bound** | see the slippage entry — the largest gap |

**Why their having these is evidence.** It is a strong signal of what real users
want from an agent grant. Their implementation is a KV record enforced by their
server; ours is a Move object enforced by the chain.

**Constraint.** Every one of these is a **new function or field**, because a
compatible upgrade cannot change an existing signature (`EUC03001`/`EUC01005`) or
remove a module (`EUC01006`). Additions must be additive, beside the old ones.

**Property that must survive each addition:** the agent must never gain a setter.

---

## AgentBazar: what to take, what not to

**Status:** reference only.

**What it is.** A DeFi talent marketplace on Optimism (EthGlobal NY 2026:
LiFi × Dynamic × ENS). Agents act on a Dynamic embedded wallet via **delegated
MPC**, with per-agent spend caps.

**Verified from source, not assumed:**

- **One orchestrator, one model.** `getOrchestratorModel()` returns a single
  configured model. Each "agent" is **not a runtime** — it is a prompt block
  composed at call time from persona data
  (`{voice, whatYouDo, howYouDoIt, neverDo[], exampleLines}`) plus a listing.
  Specialists are **data**.
- **Specialists do not execute.** Their own prompt: *"No on-chain execution from
  you — route execution to LiFi Earn UI or composer-v3-lp / composer-v4-lp."* Same
  principle as our intent layer.
- **Prompts are curated, not published.** `AGENT_PERSONAS` and `AGENT_LISTINGS`
  are hardcoded constants in their repo, with a `DEFAULT_LISTING` fallback. The
  published `Agent` type carries **no prompt field** (`id, name, description,
  longDescription, kind, capabilities, version, chainId, tags`). The dynamic
  `registry/` handles *who exists*, not how they behave — so a self-registered
  external agent gets the default listing and no persona.
- **Their grant is off chain** (Vercel KV) and server-enforced. They also keep an
  `AgentExecutionLog { status, dryRun, composeHash, error, timestamp }`.

**Take:** the grant vocabulary, per-agent prompts as data, the
advisor/executor split, the execution log, a marketplace registry with
reputation.

**Do not take:** KV grants and delegated MPC. That erases the only thing this
project has that theirs does not.

**Improvement over theirs, agreed:** our publishers declare their own **prompt** and
the **variables** the client must supply, published openly in the manifest.
Curating behaviour centrally does not scale to an open marketplace and gives
publishers no real product.

---

## The MCP server builds bytes; the Policy Guard verifies

**Status:** designed; the manifest and verification path are **not built**.

**Decision.** The MCP server returns the transaction bytes. The Policy Guard
decodes and verifies them.

**Rejected for now** — having the server return only a *description* and letting us
build. It would remove an entire class of risk for very little cost. Kept in
reserve; publishers need to build for genuinely complex strategies.

**Why untrusted bytes are acceptable here.** Because the on-chain gates are
authoritative. A hostile server can only produce bytes that either **fail the
gates** (wasting gas) or **pass them** — and anything that passes is by definition
inside the grant. Value cannot be redirected, because `destination` is fixed by
the policy.

**The residual:** `sqrt_price_limit`. Recorded separately; it is the one field
that can pass every gate and still extract value.

---

## Verify the bytes against a stated claim

**Status:** designed.

**Decision.** Do not infer intent from bytes. Require the server to **state its
intent** in a structured `claimed` block, then verify the bytes against the claim.
This turns open-ended decoding into checkable facts:

```text
decode TransactionKind → enumerate every MoveCall
  ├─ every (package, module, function) is in the manifest's declared allowlist
  ├─ claimed.destination == policy.destination          ← the value-redirect check
  ├─ claimed.amountIn within what the user asked for
  ├─ claimed.sqrtPriceLimit within the policy's bound
  ├─ manifestHash matches the manifest fetched
  └─ the transaction simulates
```

**Why it is better than inference.** It is decidable, and a **mismatch is
provable**. A publisher whose bytes disagree with its claim has lied, which is a
reputation event with evidence rather than a heuristic.

**Limit that must be stated plainly.** Whitelisting **what** is called does **not**
constrain **how**. Arguments carry the risk — allowing a pool's `swap` does not
bound the price limit passed to it. A manifest is a **supply-chain control**, not a
value control, and must never be described as a guarantee.

---

## Bound the slippage on chain

**Status:** **required, not implemented.** The largest trust gap.

**Finding.** `policy::swap_and_route` takes `sqrt_price_limit` as a
**caller-supplied argument** and passes it through unchecked, so the agent chooses
its own price tolerance.

```text
WHO may act          enforced
WHERE value may go   enforced (destination is fixed)
HOW MUCH in total    enforced (the OZ ledger)
WHICH venues         enforced (allowed_pools)
THE RATE             ✗ NOT ENFORCED
```

**Why it matters more now.** Once a third party returns the bytes or supplies the
config, a hostile server can produce bytes that pass **every** gate and still
extract value at an arbitrary price. Value stays inside the grant; the rate does
not.

**Sharpened by our own design.** The client sets the slippage and the MCP server
builds the bytes — so the slippage the user believes they set is **not what
executes**. Only an on-chain check can bind it.

**Decision.** Store `max_slippage_bps` on the Policy and assert the supplied limit
against the pool's live price. **Additive Move only**, since the existing signature
cannot change.

---

## Install bounds routing; routing is deterministic

**Status:** designed. Corrects an assumption in an earlier flow.

**The gap.** A user cannot simply prompt *"swap 0.05"*. With hundreds of published
strategies the agent does not know which is enabled. Browsing and installing must
come **before** asking. The earlier flow silently assumed a known skill set, which
was only true because exactly one strategy existed.

**The insight.** Installation **bounds the routing problem**. The model never sees
hundreds — only the installed set, typically one to five.

**Decision.** Routing is **deterministic** over a manifest-declared `verbs` list
matched against the user's words. The model only extracts **parameters** within the
already-chosen action, and grounding still runs. Same principle as hire
selection: a model that will not emit an empty string must never be asked to
choose.

**Install is also where consent happens.** It is the transparency moment: the user
sees the declared packages, functions, prompt and fee **before** granting. Then the
on-chain grant issues in the same flow (`set_allowance` + `set_pool_allowed`).
Install = disclosure + consent + grant.

**The installed record** (`{strategy, action, manifestHash, verbs, policy, agent,
variables, x402}`) must live **server-side**, because the model runs there and
routing reads it. This is a small persistence layer the project does not yet have.

**Uninstall** = `set_suspended(policy, true)` + drop the record. Suspension refuses
at gate layer 2, so a stale record cannot be worked around.

**Refusal quality.** When nothing matches, say what *is* installed. The lesson from
`EPoolNotAllowed` and the `borrow_child_object` message: an unhelpful refusal is
worse than no refusal, because it sends the operator looking in the wrong place.

---

## Walrus and SuiNS: deferred, but designed

**Status:** deferred. HTTP now.

**Decision.** Serve manifests over plain HTTP until the user flow and data schema
settle. Walrus and SuiNS exist for the transparency and decentralization story.

**Constraints already verified**, so the schema need not change later:

- **A SuiNS name cannot point at a Walrus blob.** `name_record.target_address()`
  returns an `Option<address>`. Names are *identity*; the content pointer needs a
  separate Sui registry object.
- **Walrus blobs are immutable**, so something must hold "current" — the registry
  object, not the name.
- **Hash the manifest** and record `manifest_sha256` beside the blob id, or a
  publisher can swap behaviour behind a stable name.
- **Use leaf subnames.** Leaf: no NFT, parent-controlled, not transferable, and
  **revocable**. Node: has an NFT and **cannot be removed** except by expiry — so a
  publisher granted a node subname could never be delisted. The revoke row decides
  this.
- **A leaf's expiration is the parent's.** If the parent lapses, every publisher
  identity lapses at once. Operational hazard, not a nitpick.
- **Integrate via the core package only** — the docs warn the utility packages are
  likely to be replaced and will break integration code.
- Reverse lookup works for both, so an agent address can render as a name.

**Intended naming.** Parent `suidobashi` (not yet registered); publishers as leaf
subnames beneath it. The parent controls every publisher identity and can revoke
them, so it is the highest-value key in the system and belongs in a **multisig
before any publisher exists**, not after.

**Seam discipline that makes the deferral safe.** The manifest must be
self-contained, versioned and hashable from day one, and the two lookups
(`fetchManifest`, `resolvePublisher`) must each be a single function. Then Walrus
and SuiNS are new implementations of one function each, not a rewrite.

---

## Reputation is derived, never self-reported

**Status:** designed.

**Decision.** Reputation is on chain, tied to reward/penalty, updated atomically in
the same transaction as the action — and **derived from the events the policy
already emits** (`Swapped`, `Routed`), never written by the MCP server.

**Why.** If the server writes its own score, inflation is trivial. Authorship is
the whole question. With derivation, a server cannot claim a success it did not
perform, and cannot avoid the record of one it did.

**Bonus.** Because the server states a `claimed` intent and the Policy Guard
compares it against the decoded bytes, a **discrepancy is provable**. That is a
better input than success/failure alone.

**Open.** Whether off-chain ratings fold in at all (AgentBazar's are off chain and
gameable); what weight a derived score carries against a human attestation; and
whether a penalty can be negative or only reduces future eligibility.

---

## Page code must not live in a string

**Status:** implemented. This one caused a total UI failure.

**Root cause.** The page's JavaScript was embedded in a template literal in
`src/ui.js`. An escape written for a newline was **consumed by the template
literal** and arrived in the browser as a real newline inside a single-quoted
string — a `SyntaxError`. In a module, that means **nothing executes**, so no
handler attached and **every button on the page did nothing**. A second bug hid
behind it: a regex written with a backslash-`d` arrived as a bare `d`, so the
SUI→MIST converter returned `null` for valid input.

**Why nothing caught it.** The linter sees everything inside a template literal as
a **string**. Neither bug was reachable by linting.

**Fix, structural, and since taken further.** The page's code moved into real modules
(`src/web/page.js`, `src/web/markup.js`), linted and syntax-checked. **Both are now deleted with the
page**, and the property they established is held a different way: the UI is a bundled React entry
(`src/web/app/main.tsx`) that the server emits as a script tag, so no page carries script as text at
all. The same rule in a stronger form — there is no template literal left for an escape to be eaten
by.

**Rule adopted.** When checking a served page, fetch it, extract the script, and
run the interpreter's syntax check on it. Do not eyeball it.

---

## Safe markup must be a String

**Status:** the module is DELETED; the reasoning is kept. `src/web/markup.js` went with the old page,
and the React app interpolates through JSX, so nothing in the tree uses `html`/`esc`/`setHtml` any
more. It stays because it was a real bug with a non-obvious cause, and anything that builds markup
from interpolated values later — a report, an export, an email — inherits it exactly.

**The bug.** Safe markup was marked with a plain object. A plain object stringifies
to placeholder text, and the ordinary way to render a list is to map the template
over it and interpolate the array — so the hires strip and both dropdowns would
have rendered garbage. Flattening with `Array#toString` is also wrong: it inserts
**commas** between fragments.

**The fix.** Safe markup is a **String subclass**, so joining, concatenating and
interpolating all do the obvious thing while `instanceof` still marks it escaped.
`esc()` also flattens arrays with `join('')`.

**Also fixed.** A constant interpolated into the old inline script became a
**literal string** once the code moved out of the template literal, silently
breaking the explorer link for transaction digests.

---

## The server owns the guard id

**Status:** implemented. Cost a full cycle of confusion.

**Finding.** A Cetus position is a **dynamic object field** of the guard, not a
guard field. `create` mints a **brand-new guard each time**, and no entry point
puts a position into an existing guard. So a guard that has been exited stays empty
forever, and the next `create` yields a new guard id **generated on the validator**
— it can only be read back from the transaction's effects.

**The misleading symptom.** `addresses.js` held a previously exited guard's id.
Deposit, rebalance and redeem built against that emptied guard and failed with
`borrow_child_object` abort code 1. Worse, the message written for that abort said
*"open a position first"* — instructing the operator to do exactly what they had
just done, because the real cause (stale config) was invisible.

**Patch.** The server is the **authority** on which guard is current: it holds
`activeGuard`, passes `GUARD_ID`/`GUARD_SHARED_VERSION` to the guard scripts by env,
adopts the new guard from the create transaction on submit, and persists it to
`src/addresses.js`. The page reports the adoption, because an unadopted guard is
otherwise invisible and surfaces later as an unexplained refusal.

**Near-miss worth remembering.** A create also produces a **second** object whose
type mentions `position_guard` (a `dynamic_field::Field`). Matching on "the shared
object that was created", or on a loose substring, would have adopted the wrong
object. The matcher requires the exact `::position_guard::PositionGuard` type.

**Diagnostic rule.** A stale `position_id` proves nothing. To test whether a
position is live, dry-run a guard operation.

---

## A test that exercises a copy reports green

**Status:** implemented, with a guard against recurrence.

**What happened.** `src/guard-id.js` was written with two pure functions and
`src/verify-guard.js` to check them — but `src/ui.js` never imported the module. It
kept its own **inline copy**. So the check tested a module nothing ran, while the
running code was untested — and the two had already **drifted**, the tested copy
handling an older CLI spelling the running copy did not.

**Why this is worse than no test.** It reports **green**. It converts an untested
path into an apparently verified one, and the false confidence is the harm.

**Fix + guard.** The server imports the tested module, the copy is gone, and the
check now **fails if either function is inlined again** — confirmed by deliberately
re-inlining and watching it fail.

**Rule adopted throughout.** Pure, DOM-free logic lives in its own module and the
check **imports that module** — never reimplemented, never `eval`-ed:

| module | checked by |
| --- | --- |
| `src/web/units.ts` (decimal → integer money) | `src/verify-page.js` |
| `src/guard-id.ts` (guard adoption) | `src/verify-guard.js` |
| `src/agent.ts` (intent gate) | `src/verify-intent.js` |

The escaping module (`src/web/markup.js`) had a row here until the old page was deleted. The React
app is bundled and interpolates through JSX, so it needs no `html`/`setHtml`, and a check for a
deleted module is not a check. **The rule is unchanged** — pure logic lives in its own module and
the check imports it — which is why `units.ts` is still one shared module rather than a copy per
caller, and why its check may not be allowed to grow a second implementation.

Also adopted: one runnable check for non-trivial logic; verify the **served**
artefact rather than the source; and translate raw chain aborts into actionable
messages, because a Move abort code is not an explanation
(`borrow_child_object`, `balance::split`, `ENoLiquidity` each misled someone).

---

## v4 staged, not published

**Status:** fixed in source, deliberately not deployed.

**The bug.** `set_pool_allowed` was not idempotent in **either** direction:
`vec_set::insert` aborts when the key exists, `vec_set::remove` aborts
`EKeyDoesNotExist` when it does not. So re-allowlisting failed, revoking twice
failed, and a hire could not be re-run. The first fix only addressed one direction.

**Fix in source.** Check `contains()` before both `insert` and `remove`.

**Decision.** Publishing v4 costs roughly 0.12 SUI and the workaround is
Close-then-Open. **Trigger to publish:** an allowlist actually needs re-running, or
other Move changes accumulate to batch into the same upgrade.

---

## A read needs no grant, and the talent says which actions spend

**The claim, and the bug.** This project has said since the talent vocabulary landed that "a
talent that spends needs a grant; a talent that only reads does not". For as long as that sentence
existed the code disagreed with it: `validate` demanded a `hire` before it looked at the action at
all, so a read was refused with "no hire matched". The sentence was documentation, and
documentation the code contradicts is the dominant bug class here — it was found by running a
read, not by reading the gate.

**The decision.** An action's spend class is DECLARED BY ITS TALENT (`spends: boolean` on the
action) — not inferred from its name, and not configured anywhere else. The gate reads it before
judging anything, and a non-spending action returns early: no hire, no allowance, no venue, no
suspension check, and no amount. A read has no amount, and demanding one would refuse "check my
balances" for a number the request never needed to name.

**Why declared rather than inferred.** The gate has to know BEFORE it can decide whether to demand
a grant, so it cannot be derived afterwards from what the action turned out to do. It belongs to
the talent for the same reason the action id does: the talent is what says what the agent can do.
**Fail-closed:** an action nothing provides is treated as SPENDING, and so is one two talents
disagree about. The expensive mistake is letting something spend unguarded; the cheap one is
demanding a grant for a read.

**Not an optimisation.** A suspended hire can still read its own balance, and refusing that would
be the gate confusing "may not spend" with "may not act".

**Consequence.** `hire` is `null` in a read's report, which is the honest shape — no grant was
consulted. Both are asserted in `src/verify-query.js`, together with the regression that matters:
making reads exempt must not make the SWAP exempt too.

---

## x402 on the query route, and no price that cannot be paid

**Decision.** x402 belongs to routes that are not fills. A fill is paid by the fee inside the
order, so a second charge would be paid twice; the query server therefore has **no fill route at
all**, which makes "never charges for a fill" true by construction rather than by care.

**But it is off, and recording that is the point.** The server accepts `QUERY_PRICE_MIST` and,
above zero, answers every query `402` with those terms. **Nothing can pay yet:** paying means
building a transaction that draws from the vault under a grant, and that path does not exist. So
the default is zero, the manifest declares `priceMist: "0"`, and a check asserts it. Advertising a
price while nothing could settle it would repeat the exact trap already in NOTES — a talent whose
title promised USDC -> SUI while nothing implemented it.

---

## The direction is data, and it lives in one table

**Context.** For most of this project's life the escrow traded one way. The contract was never the
reason: `settle_a2b` and `settle_b2a` both existed and both enforce the maker's floor identically.
What was missing was that nothing CALLED `settle_a2b`, so the gate refused the direction — correctly,
while that was true. "Unbuilt, not forbidden" was the honest description, and it is now built.

**The decision.** `DIRECTIONS` in `src/addresses.ts` is the single table: the input coin, the output
coin, and which settle entry point. Everything reads it — the gate's supported list, the escrow's
`coinWithBalance` and type argument, the filler's entry point, the advisor's pair, and the budget
messages. A direction cannot be executable in one place and unknown in another.

**Two derived facts, not written down twice.** The entry point follows from which side of the pool
the input coin sits on, and the pool's own type arguments say which side that is — so
`settle_a2b`/`settle_b2a` is DERIVED from `POOL_TYPE_ARGS`, and a check asserts it. And the type
arguments are the pool's `[A, B]` in BOTH directions: the direction picks the entry point, never the
type arguments. Writing them out per direction is how a `settle_a2b` ends up called with its
arguments reversed — which compiles, and swaps the wrong way.

**The unit error this exposed, twice.** Two places had 9 decimals baked in and were correct only
because there was one coin: `parseAmountText` (which hardcoded the precision in three separate ways
and was a duplicate of `toUnits` besides), and the gate's money messages, which divided by `1e9`
and said "SUI" whatever the coin was. Both are fixed; the parser is now the one in `web/units.ts`,
and every money figure the agent reports carries the coin it is in. The wallet-balance and allowance
reads are also per coin now — the ledger is keyed by `(cap_id, coin_type)`, so comparing a USDC
amount against the SUI entry would have refused or allowed for a reason unrelated to the budget.

**The prerequisite, and it is not code.** The policy's cap holds no USDC allowance, so
`create_with_policy` aborts `EExceedsAllowance` — verified by building the escrow against mainnet,
where the PTB resolved a real USDC coin and reached that assert. Granting it is an owner-signed
`spend_vault::set_allowance<USDC>`, and the app's budget path is SUI-only. NOT INVENTED HERE:
whether a USDC budget should require the vault to hold USDC. That guard is right for the vault path
and irrelevant to an order, whose escrow comes from the maker's wallet.

---

## The escrow can be the vault, and the draw happens at SETTLEMENT

**Status: in source and unit-tested, deliberately NOT published** (version 9). Nothing is wired to it
— a caller cannot name a package id that does not exist.

**The problem it solves.** The budget bounded nothing that also had a commitment behind it. The vault
path (`swap_and_route`) SPENDS via `spend_vault::spend` and therefore decrements the ledger, but it
takes a caller-supplied price limit, so it cannot enforce a maker's floor. The order path enforces the
floor and only READS the allowance, so N orders of the same size each pass a grant that covers one.
A policy's stated ceiling was therefore a per-order limit wearing a total's name — worse than no
limit, because a maker sizes a trade to it.

**The decision.** `policy::spend_balance_from_vault` is the missing half: agent-gated, draws from the
vault, hands back the balance without deciding where it goes. `order::create_from_vault` commits the
vault's funds and holds NOTHING; `settle_from_vault_a2b`/`_b2a` draw at settlement and then run the
SAME settlement a wallet order uses, so the floor assertion, the delivery and the settled marker are
the tested ones. The only difference between the two kinds of order is where the money was before the
call.

**Draw at settlement, not at creation — and this is the load-bearing choice.** `spend_vault` has no
credit-back: `set_allowance` is owner-gated, `spend` only debits, and there is no third function that
increases a ceiling. An order that drew at creation and then expired could never return what it took,
and with a one-minute window expiry is routine. Drawing at settlement means an expired commitment
costs nothing. **What that gives up:** the ceiling is not RESERVED. A maker who commits more than the
remaining budget gets the first settlement and not the second. A reservation needs the credit-back
that does not exist, so this is a real trade rather than a detail.

**Two gates exist on this path and not on the wallet one, and both are deliberate:**

- **The OwnerCap.** This commits the owner's money, so the owner's credential is required, checked
against the vault exactly as `policy::create` checks it. Without the gate any address could burn the
owner's budget — nothing could be STOLEN, since every settlement pays the policy's destination, but
spending someone's budget on trades they did not ask for is a griefing vector, not a safe default.
- **`!suspended`**, inherited from `assert_agent_gates`. A suspended hire can still FILL a
wallet-escrowed order, because `order.move` never reads `is_suspended`; it cannot spend from a
suspended grant.

**No destination parameter, ever.** Value leaves the vault at settlement, so a caller-chosen
destination would let anyone commit the owner's money to any address. The commitment takes the
policy's, exactly as the vault path does. This is the one place where copying the WALLET path's
signature would have been a hole rather than a convenience.

---

## Deferred, and open

Recorded so they are not rediscovered as if new.

**Deferred:** Walrus and SuiNS transport · rate limiting · the v4 publish ·
agent reward and fee contracts (they break the destination invariant) ·
cron/interval execution · the second strategy.

**Open questions for the owner:**
- Is the swap template a *description the publisher writes* or a *config the user
  fills in*? Currently both: the publisher declares the schema, the user supplies
  the values.
- Who funds an MCP server's gas wallet, and is there any bound on gas spend?
- Can a penalty be negative, or only reduce future eligibility?
- Does off-chain marketplace reputation fold in at all?
