# Roadmap

The agreed plan, with the reasoning behind its **ordering** — which matters more
than the list, because several items are cheap now and expensive later.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) (how it works) ·
[DECISIONS.md](DECISIONS.md) (why) · [MCP-STANDARD.md](MCP-STANDARD.md) (the spec).

## Scope decision

**Build one swap strategy; park the second.** Two strategies (`standard` on a
0.05% pool, `cautious` on a 0.01% pool) proved independent caps, budgets and
venues — but they multiply the surface while the fundamental user flow and data
schema are still unsettled. Collapsing to one is a **config** change, not a Move
change, so nothing is lost by doing it now and adding the second back later.

## Recommended first move

**Per-server agent identity.** Three reasons it comes first:

1. It costs **no Move work** — the model already supports it (one policy per agent
   address, one cap per policy, one allowance per cap).
2. It makes the access-control claim **testable for the first time**. Today
   `agent == owner`, so `ENotAgent` and `ESuspended` have never fired on mainnet.
3. Everything downstream assumes it: the manifest declares `publisher.agent`, the
   grant binds to that address, and the caller gate is the thing being sold.

## Phases

### Phase 1 — vocabulary and identity

**Status: not started. Blocks everything.**

- [ ] Write the domain terms down and stop using them loosely: **vault**,
      **policy (the grant)**, **cap**, **allowance**. They were being conflated in
      conversation, and they name everything else.
- [ ] Give each MCP server its own agent address; issue one policy per server.
- [ ] Test the caller gate for real: a call from the wrong address must be refused
      on chain with `ENotAgent`, and a suspended grant with `ESuspended`.

### Phase 2 — schemas

**Status: designed in [MCP-STANDARD.md](MCP-STANDARD.md); needs settling.**

- [ ] The **manifest**: publisher, strategy/action ids, routing **verbs**,
      declared `(package, module, function)` sets, the variable schema, the prompt,
      the x402 fee.
- [ ] The **action request/response**, including the `claimed` intent block and
      `manifestHash`.
- [ ] The **installed-skill record**, stored server-side because routing reads it.
- [ ] The supported **variable types**. This is effectively the UI vocabulary,
      since both the client form and the model's extraction schema are generated
      from it.

### Phase 3 — discovery, install, routing

**Status: not started.**

- [ ] `GET /marketplace` and `GET /manifest/:id` over HTTP, behind the two seams.
- [ ] `POST /install`: present the disclosure (packages, functions, prompt, fee),
      collect the budget, issue the on-chain grant (`set_allowance` +
      `set_pool_allowed`), write the local record.
- [ ] `POST /uninstall`: `set_suspended(policy, true)` + drop the record.
- [ ] **Deterministic routing** over installed verbs. The model extracts parameters
      only; it never selects.

### Phase 4 — Policy Guard verification

**Status: not started.**

- [ ] BCS-decode the returned `TransactionKind`; enumerate every `MoveCall`.
- [ ] Check each `(package, module, function)` against the manifest.
- [ ] Cross-check the `claimed` block against the decoded bytes; treat a mismatch
      as a provable discrepancy.
- [ ] Verify `manifestHash`.
- [ ] Document what this does **not** prove — see the section in
      [MCP-STANDARD.md](MCP-STANDARD.md#what-this-does-not-prove).

### Phase 5 — reference MCP server

**Status: not started.**

- [ ] Wrap the existing `swap.js` in an HTTP server implementing the contract.
- [ ] x402 as the service fee, kept separate from the allowance.

No publisher exists yet, so a reference implementation is the cheapest way to
discover which schema fields are actually needed rather than guessed, and it is
the artefact a publisher copies.

### Phase 6 — the on-chain change that is still required

**Status: not started. Required regardless of the MCP work.**

- [ ] **`max_slippage_bps` on the policy**, asserting the caller's
      `sqrt_price_limit` against the pool's live price. Additive Move, since the
      existing signature cannot change.

Today the agent picks its own price tolerance. It is the only guarantee that lives
solely in our server, and once a third party supplies bytes or config it becomes
the single field that can pass every gate and still extract value.

### Phase 7 — UI

**Status: not started.**

- [ ] Decide React-in-page against **one** swap template, so the rewrite is
      contained. OpenUI Lang is the intended format for the UI standard.
- [ ] Fix the component vocabulary and the trust rule together: allowlisted
      components only, no raw HTML, every value escaped.
- [ ] Render the variable schema as the client form.
- [ ] Show the **real** remaining allowance via
      `spend_vault::allowance<T>(vault, cap_id)` instead of the local record.
- [ ] An **execution log** with digests. Today one line of status is rendered and
      then lost.
- [ ] Information architecture for the stacked rows (ask / owner / position /
      strategies), which only grows once strategies are per-server.

## Deferred, with triggers

Recorded so they are not rediscovered as if new.

| item | cost | trigger to do it |
| --- | --- | --- |
| publish **v4** (`set_pool_allowed` idempotency) | ~0.12 SUI | an allowlist actually needs re-running, or other Move changes batch in |
| **Walrus** + **SuiNS** transport | — | once the user flow and data schema settle |
| **rate limiting** (daily/window cap) | new Move | when a real strategy needs it — not now |
| **agent rewards / fees** | new Move + design | needs the destination-invariant question answered first |
| **cron / interval execution** | agent key signing | after the swap path is solid — this is what forces limits on chain |
| the **second strategy** | config | when the first is proven end to end |

## Open questions for the owner

1. **Is the swap template a description the publisher writes, or a config the user
   fills in?** Currently both: the publisher declares the schema, the user supplies
   the values. Worth confirming that is the intent.
2. **Who funds an MCP server's gas wallet**, and is there any bound on gas spend?
   The allowance does not cover gas.
3. **Can a penalty be negative**, or does it only reduce future eligibility?
4. **Does off-chain marketplace reputation fold in at all?** AgentBazar's is off
   chain and gameable.
5. **Parent name custody.** `suidobashi` is not registered yet. It will control
   every publisher identity and be able to revoke them, so it belongs in a
   **multisig before any publisher exists**, not after.

## What is proven, and what is not

Kept here because the gap is the reason Phase 1 is first.

**Proven on mainnet:** swap through the gate · on-chain budget refusal
(`EAllowanceExceeded`) · position created with no address owning it · liquidity
deposit · atomic rebalance with rewards collected · redeem · `EPoolNotAllowed` on
the wrong venue · owner actions from the UI · the full position cycle driven from
the UI with wallet signing.

**Not proven: owner/agent separation.** Every agent-path proof was signed by an
address that is *both* owner and agent, so no agent path has ever been refused for
being the wrong caller. The separation is the product; it is currently reasoned,
not tested.

**Also not proven:** a third-party MCP server returning bytes (designed, not
built), and cron/interval execution.
