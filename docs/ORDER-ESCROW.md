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
create    maker escrows a coin, commits min_out and an expiry, shares the order
settle    the agent fills it: swap, assert out >= min_out, route, consume the order
refund    after expiry, anyone may trigger it; funds always return to the maker
```

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
