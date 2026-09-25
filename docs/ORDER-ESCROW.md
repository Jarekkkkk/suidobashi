# Order escrow — the swap path

A second swap path, replacing the vault-spending one for trades a user commits to
in advance. Each swap is its own escrowed order carrying a **minimum the maker
chose**, so the guarantee is structural rather than advisory.

Status: **designed, not built.** [ARCHITECTURE.md](ARCHITECTURE.md) still describes
the vault path, which remains live and callable.

## Why this exists

The vault path cannot constrain the price. `swap_and_route` takes
`sqrt_price_limit` from the caller, so **the agent picks its own tolerance** — the
one term of a trade the policy could not bound. A `max_slippage_bps` was added in
v4, and it is real, but it is bypassable: every prior package version stays callable
with its own bytecode, so a caller who names v3 runs the unbounded body.

Escrow closes that properly, by changing where the funds are:

```text
VAULT PATH    funds in the vault, agent spends within an allowance
              the price is the agent's choice, bounded by a bypassable check

ORDER PATH    funds inside the order, minimum committed by the maker
              the only way to reach the funds is to settle, and settling
              asserts the minimum. Not bypassable, because the old path
              cannot reach funds held in an order.
```

This is the difference the project keeps coming back to: a guard against **mistakes**
versus a boundary against an **adversary**.

## The object

```move
public struct Order<CoinType> has key, store {   // NO drop
    id: UID,
    maker: address,
    destination: address,
    funds: Balance<CoinType>,
    pool_id: ID,
    min_out: u64,
    expires_at_ms: u64,
}
```

**The missing `drop` is the enforcement.** A value without it cannot be discarded,
so the order can only leave the system by being consumed — and both consuming
functions assert the maker's terms before they touch the funds.

It is an object rather than a hot potato on purpose. A hot potato must be consumed
**within the same transaction**, which cannot bind a flow where the maker commits in
one transaction and the agent settles in a later one. `key + store` without `drop`
gives the same non-discardable property across transactions.

## Lifecycle

```text
1  create    maker escrows a coin, commits min_out and an expiry, shares the order
2  settle    the agent fills it: swap, assert out >= min_out, route the output,
             then MARK the order settled — and leave it on chain
3  burn      the maker reclaims the settled order's storage

   refund    after expiry, anyone may trigger it; funds always return to the maker
```

### Why the order survives settlement

So the **storage rebate** can be reclaimed separately. Measured on chain:

```text
a minimal transaction          ~0.00024 SUI   (the failed ENotAgent tx)
an object's storage rebate     ~0.0044 SUI    (burn 5gko7Lna…: net +0.0041 after gas)
a settlement's gas             ~0.0043 SUI
```

So a dedicated burn costs about 0.0003 and returns about 0.0044 — a net gain of
**+0.0041**, which nearly covers a settlement's gas. The first version of this note
estimated ~0.0018 from comparable objects; the measured figure is roughly 2.4× that,
which is worth knowing because it makes the reclaim materially more valuable than the
guess suggested.

Burning inside `settle` would collect the same rebate at no extra cost — but it would
go to the **settler**, not the maker. Keeping the object alive is what lets the maker
take it instead, which is why `burn` is maker-gated: the rebate goes to whoever signs,
and it is the maker's storage.

Two consequences that are not optional:

- **A `settled` marker.** The object survives, so a second settlement has to be
  refused explicitly rather than relying on the object being gone. It is a **dynamic
  field**, not a struct field, because `Order` is already published and a compatible
  upgrade cannot change a struct's layout — the same constraint that put the slippage
  bound in a dynamic field.
- **The balance is emptied by splitting it out**, not by destructuring. An object
  cannot be rebuilt from a destructured UID; Sui requires a UID to come from
  `object::new`. So `settle` splits the whole balance out of the intact struct,
  leaving the original at zero.

## What settle asserts

```text
1  ctx.sender() == policy::agent(policy)              ENotAgent      the hire gate
2  policy::is_pool_allowed(policy, object::id(pool))  EPoolNotAllowed
3  object::id(pool) == order.pool_id                  EWrongPool     no substitution
4  clock.timestamp_ms() < order.expires_at_ms         EOrderExpired
5  amount_out >= order.min_out                        EBelowMinimum  the whole point
```

Assertion 3 exists because the settler chooses which `Pool` object to pass. Without
it a settler could swap against a pool the maker never named — the same class of
mistake as the venue allowlist, one layer down.

## Design decisions

| decision | choice | why |
| --- | --- | --- |
| cumulative budget | **none** — per trade | the order is the unit; exposure is bounded by how many orders the maker creates |
| who settles | **the policy's agent** | keeps the grant, the agent and the demonstrated caller gate load-bearing. Loosening to permissionless is additive |
| partial fills | **no** | all or nothing keeps `min_out` unambiguous |
| refund trigger | **anyone**, after expiry | no order can sit with dead funds if the maker goes quiet |
| default window | **1 minute** | a swap order is a short-lived intent, not a standing offer. No lower bound in the contract, so it can go shorter |
| storage rebate | **the maker**, via a separate burn | the rebate goes to whoever signs, and it is the maker's storage |
| destination | fixed at create | the settler cannot redirect value, same rule as the policy |
| policy dependency | agent gate + pool allowlist only | the order names its own pool, minimum and expiry |

## What this retires

**`max_slippage_bps` becomes unnecessary on this path.** Not fixed — replaced. The
bound was a bypassable check on a caller-supplied argument; `min_out` is a
maker-supplied commitment enforced by where the funds sit.

It stays in the policy for the vault path, which is still live.

## Known limits

- **No cumulative cap.** An agent can settle as many orders as exist. If unattended
  operation needs a total ceiling, that is a separate mechanism — and it would need
  a counter in a dynamic field, since the `Policy` struct layout is frozen.
- **`swap_and_route` stays callable** and unaffected. That is acceptable here
  precisely because escrowed funds are unreachable from it.
- **New event structs carry the new package id.** `OrderCreated`, `OrderSettled` and
  `OrderRefunded` are declared in the version that adds them, so an indexer must
  query that id — unlike `PolicyUpdated`, which permanently carries the id where it
  was first declared.
