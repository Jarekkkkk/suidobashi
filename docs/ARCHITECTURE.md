# Architecture

How `sui-tokyo` works today. For the reasoning behind each choice see
[DECISIONS.md](DECISIONS.md); for the forward design see
[MCP-STANDARD.md](MCP-STANDARD.md); for traps that cost real time see the
`NOTES.md` in the repo root.

## What this is

An on-device agent wallet for Sui. A local AI model turns a sentence into a
proposed action; deterministic code disposes; the wallet extension signs; and the
limits that constrain the agent live on chain rather than in the server.

## The core claim

> The agent cannot exceed its grant, and that holds even if every server in the
> path is compromised.

This is why the project exists in the shape it does. Everything below is in
service of that one sentence, and it is the thing to check any new feature
against — a feature that makes a limit live in a server has removed the claim
rather than extended it.

Two consequences that shape the code:

1. **The server holds no key and cannot sign.** It builds a transaction, keeps
   the bytes, and submits bytes plus a signature it was handed.
2. **The chain is the only authority.** The server's gate and its simulation are
   pre-flight conveniences. If they were removed, the limits would still bind.

## Objects and access control

```text
        OWNER (you)                          AGENT (an address)
        key on device                        key wherever you put it
        holds: OwnerCap                      holds: nothing
             │                                     │
             │ the ONLY thing that                  │ may only CALL
             │ can change limits                    │ within the grant
             ▼                                     ▼
  ┌──────────────────────┐              ┌──────────────────────┐
  │  OwnerCap            │              │  policy.agent        │
  │  (address-owned)     │              │  (a field, not a cap)│
  └──────────┬───────────┘              └──────────┬───────────┘
             │ presents                            │ compared to ctx.sender()
             ▼                                     ▼
  ┌────────────────────────────────────────────────────────────┐
  │  POLICY   (shared)                                          │
  │   vault_id ─────────────┐   agent ──────► AGENT            │
  │   destination ──────────┼──► OWNER (value can only go here)│
  │   allowed_pools: {Pool} │   suspended: bool                │
  │   cap_id ───────────────┼───────────┐                      │
  └─────────────────────────┼───────────┼──────────────────────┘
                            │           │ holds as a
                            │           │ dynamic object field
                            ▼           ▼
  ┌──────────────────────┐   ┌──────────────────────┐
  │  VAULT (OZ, shared)  │   │  SpenderCap          │
  │   holds the funds    │◄──┤  key only, no value  │
  └──────────┬───────────┘   └──────────────────────┘
             │ keyed by (cap_id, coin_type)
             ▼
  ┌──────────────────────────────────────────────────┐
  │  ALLOWANCE (OZ ledger entry)                     │
  │   { remaining: u64,  expires_at_ms: u64 }        │
  └──────────────────────────────────────────────────┘
```

**Who can do what:**

```text
OWNER  (OwnerCap holder)
  ├─ policy : set_agent · set_destination · set_suspended · set_pool_allowed
  ├─ vault  : deposit · withdraw · withdraw_all · mint_cap · revoke · revoke_all
  │           set_allowance                      ← the budget
  └─ guard  : redeem · deposit_liquidity · set_agent/destination/suspended/tick_bounds

AGENT  (the address in policy.agent / guard.agent)
  ├─ policy : spend_to_destination · swap_and_route
  └─ guard  : rebalance · rebalance_with_rewards · collect_fees

ANYONE
  └─ read-only accessors (policy / vault / guard getters, devInspect)
```

**The property that matters:** the agent holds no cap and has no setter. It
cannot widen its own budget, change its destination, add a venue, or un-suspend
itself. Every limit is behind the OwnerCap. Any new feature must preserve this.

## Vocabulary

These were being used loosely, and they are load-bearing:

| term | what it is | where |
| --- | --- | --- |
| **Vault** | where the funds sit | OpenZeppelin, shared object |
| **Policy** | the **grant**: who may act, where, to whom, kill switch | our Move, shared |
| **SpenderCap** | the key the policy holds; the ledger is keyed by it | owned by the policy, as a dynamic object field |
| **Allowance** | the **budget**: `(cap_id, coin_type) → {remaining, expires_at_ms}` | OZ ledger |

Policy and allowance are separate on purpose: the grant is *permission*, the
allowance is *spendable amount*. `set_allowance` is an upsert keyed by the cap,
so the budget changes without touching the permission.

## The gate stack

Outermost first. Layers 1–4 are our Move; 5–6 are OpenZeppelin's ledger.

```text
  1  POLICY     sender == policy.agent ................. ENotAgent          ← WHO
  2  POLICY     !policy.suspended ...................... ESuspended         ← LIVE?
  3  POLICY     vault id == policy.vault_id ............ EWrongVault        ← WHICH VAULT
  4  POLICY     pool ∈ allowed_pools ................... EPoolNotAllowed    ← WHERE
  ───────────────────────────────────────────────────────────────────────
  5  OZ LEDGER  allowance(cap_id, SUI).remaining ≥ amount EAllowanceExceeded ← HOW MUCH
  6  OZ LEDGER  now < expires_at_ms .................... EAllowanceExpired  ← UNTIL WHEN
  ───────────────────────────────────────────────────────────────────────
  (parallel path — the object gate)
      GUARD     sender == guard.agent .................. ENotAgent
      GUARD     !guard.suspended ....................... ESuspended
      GUARD     pool id == guard.pool_id ............... EWrongPool
      GUARD     tick width within min..max ............. ← the ECONOMIC ceiling
```

**Layers 1–4 can only narrow.** The caller chooses the pool, direction, amount
and price limit. It can never choose where value goes, because `destination` is
fixed by the policy. That is why a compromised agent cannot redirect funds.

**Layer 5–6 is why the interval strategy needs on-chain limits at all** — see
[DECISIONS.md](DECISIONS.md#config-off-chain-limits-on-chain).

## The swap route

**Setup** (owner, signed on-device). Order matters:

```text
  1  deploy the OZ vault + OwnerCap, share the vault
  2  fund the vault                    ← MUST precede 4: the ledger is a ceiling
                                         over a real balance, not a reservation
  3  mint the SpenderCap               spend_vault::mint_cap(vault, owner_cap)
  4  create the policy                 policy::create(...) takes the cap BY VALUE,
                                         so cap_id is stable for later set_allowance
  5  grant the budget                  spend_vault::set_allowance<SUI>(cap_id, …)
  6  allow the venue                   policy::set_pool_allowed(pool, true)
```

**Execution** (agent), one call:

```move
policy::swap_and_route<A, B>(policy, vault, config, pool, a2b, amount,
                             sqrt_price_limit, clock)
```

Then a Cetus CLMM **flash swap**: output delivered up front, the input split to
exactly `pay_amount` and repaid, with both the remainder and the output routed to
`policy.destination`. It emits:

```move
Swapped { policy_id, vault_id, pool_id, a2b, amount_in, amount_paid,
          amount_out, destination }
```

## Execution flow, and which part is real

```text
 YOU              POLICY GUARD (yours)              MCP SERVER (publisher)   WALLET    CHAIN
  │                      │                                 │                  │         │
  │ "swap 0.05 SUI"      │                                 │                  │         │
  ├─────────────────────►│ ① local model extracts          │                  │         │
  │                      │ ② grounding vs YOUR words       │                  │         │
  │                      │ ③ deterministic gate            │                  │         │
  │◄── PROPOSED/REFUSED ─┤    ══ ADVISORY ══              │                  │         │
  │                      │                                 │                  │         │
  │ click Run            │ ④ build bytes / call MCP        │                  │         │
  ├─────────────────────►├────────────────────────────────►│                  │         │
  │                      │◄── tx bytes + claimed intent ───┤   UNTRUSTED      │         │
  │                      │ ⑤ verify: decode · compare vs   │                  │         │
  │                      │    claim · manifest · simulate  │                  │         │
  │◄── refused pre-sign ─┤    ══ PRE-FLIGHT ══             │                  │         │
  │                      │                                 │                  │         │
  │                      ├── bytes to sign ────────────────────────────────►│         │
  │                      │◄────────────────────────────── signature ────────┤         │
  │                      ├── submit ────────────────────────────────────────────────►│
  │                      │                                 │  ⑥ GATES RUN for real │
  │◄── digest + status ──┤                                 │   ══ AUTHORITATIVE ══  │
```

Throughout: **① ② ③ ⑤ are advisory. ⑥ is real.** The first four exist to save
you gas and mistakes, not to provide the guarantee. A hostile Policy Guard or a
hostile MCP Server changes nothing about ⑥.

## The object gate (position guard)

A parallel protection for LP positions, with the same shape but its own twist: a
position is a **dynamic object field** of the guard, not a guard field, so a guard
that has been exited stays empty permanently and the next `create` mints a **new
guard with a new id** generated on the validator.

Consequences:

- the guard id is runtime state; the server owns it, adopts it from the create
  transaction, and persists it to `src/addresses.js`
- a stale `position_id` proves nothing. To test whether a position is live,
  dry-run a guard operation: `dynamic_object_field::remove` aborts at
  `borrow_child_object` (code 1) when there is none
- cycle order is **open → fund → rebalance → exit**, and `exit` is terminal for
  that guard

## Trust boundaries

| component | trusted for | NOT trusted for |
| --- | --- | --- |
| Policy Guard (our server) | decisions, UX, verification | holding keys, enforcing limits |
| MCP Server (publisher) | its strategy, its prompt, building bytes | anything about value |
| local model | extraction only | selection, amounts, truth |
| wallet extension | approving what the user sees | policy |
| **chain** | **the limits** | — |

The local model is deliberately in the "not trusted" column even though it is
ours: it is a 0.6B model, and a model that will not emit an empty string cannot
be asked to decide anything.

## What is proven, and what is not

**Proven on mainnet:** a swap through the gate (`amount_paid == amount_in`); an
on-chain budget refusal (`EAllowanceExceeded`); a position created with no address
owning it; liquidity deposit; an atomic rebalance (position deleted and recreated,
surplus returned, CETUS rewards collected); redeem; `EPoolNotAllowed` on the wrong
venue; fund / set-budget / venue open-close from the UI; and the full position
cycle driven from the UI with wallet signing.

**Not proven, and it matters:** **owner/agent separation.** The gates are covered by
unit tests — the Move suite asserts `non_agent_aborts`, `suspended_policy_aborts`,
the tick-width bounds and cap binding. What has never happened is a refusal **on
mainnet, against a separate caller**: every agent-path proof so far was signed by an
address that is *both* owner and agent, so `ENotAgent` and `ESuspended` have never
fired on chain.

Worth keeping straight, because the two are easily conflated: a unit test shows the
gate is coded correctly; a mainnet refusal shows it is the thing standing between a
hostile caller and the funds. Only the second is evidence about this deployment,
which is why per-server agent identity is the recommended first move.

**Also not proven:** a third-party MCP server returning bytes (the manifest and
verification path is designed, not built), and the cron/interval strategy.
