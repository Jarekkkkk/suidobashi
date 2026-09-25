# MCP server standard

The contract between a **publisher's MCP server** and a **Policy Guard** (the
user's local agent). This is the forward design: the manifest and verification
path are **not built yet**. Recorded now because the schema is what everything
else waits on.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) for how the chain enforces limits,
[DECISIONS.md](DECISIONS.md) for why the boundary sits here.

## Roles

| | **Policy Guard** (the user's) | **MCP Server** (a publisher's) |
| --- | --- | --- |
| owns | the user's decisions, the grant | a strategy |
| holds | no key, no funds | an **agent key** (holds nothing itself) |
| does | routing, extraction, grounding, the pre-flight gate, **verification** | builds transactions, runs crons, pays its own gas |
| trusted for | decisions and UX | its strategy, its prompt |
| **not** trusted for | holding keys, enforcing limits | **anything about value** |

The one thing neither is trusted for is the limit itself. That lives on chain.

## Two seams, deliberately

Everything that will later become Walrus and SuiNS sits behind exactly two
functions:

```text
fetchManifest(publisherId) → manifest      # HTTP now → Walrus blob + registry object later
resolvePublisher(nameOrAddress) → id       # HTTP now → SuiNS later
```

Because SuiNS names resolve to an **address** and Walrus blobs are **immutable**,
the later version has a registry object holding `name → {publisher, agent,
blob_id, sha256, version, status}`. The manifest must therefore be
**self-contained, versioned and hashable from day one** so that swap needs no
format change.

## The manifest

What a publisher declares at publication. Declared **beforehand** and disclosed
openly — including the prompt, because the prompt is what shapes the user's
action and it is untrusted input.

```jsonc
{
  "schemaVersion": "1",
  "publisher": {
    "id": "suidobashi:acme",              // SuiNS leaf name later
    "agent": "0x…",                       // the address its MCP server signs as
    "contact": "…"
  },
  "strategy": { "id": "cetus-swap", "version": "1.0.0" },

  "actions": [
    {
      "id": "swap",
      "title": "Swap on Cetus",
      "description": "Swap between two tokens on an allowlisted Cetus pool.",

      // ROUTING — deterministic selection. The model never chooses.
      "verbs": ["swap", "exchange", "convert", "sell", "buy"],

      // DECLARED TARGETS — every call the built transaction may make.
      "packages": [
        { "id": "0x2441fb…", "modules": ["policy"] },
        { "id": "0x1eabed…", "modules": ["pool"] }
      ],
      "functions": [
        "0x2441fb…::policy::swap_and_route",
        "0x1eabed…::pool::swap"
      ],

      // VARIABLES the CLIENT supplies. The form is generated from this.
      "variables": [
        { "name": "pool",        "type": "poolId", "required": true },
        { "name": "direction",   "type": "enum", "values": ["a2b", "b2a"], "required": true },
        { "name": "amountSui",   "type": "sui",  "min": "0.001", "max": "1", "required": true },
        { "name": "slippageBps", "type": "bps",  "min": 1, "max": 100, "default": 50 }
      ],

      // The prompt run locally, with the user's words. UNTRUSTED input.
      "prompt": "…",

      "x402": { "asset": "USDC", "amount": "0.01", "chain": "sui" }
    }
  ]
}
```

### Variable types

These are the UI vocabulary, because both the client form and the model's
extraction schema are generated from them.

| type | meaning | carries |
| --- | --- | --- |
| `sui` / `usdc` | a decimal amount of a coin | `min`, `max`, `decimals` |
| `bps` | basis points | `min`, `max`, `default` |
| `tick` | a CLMM tick index | `spacing`, `min`, `max` |
| `enum` | a fixed choice | `values` |
| `address` / `poolId` | an object or account id | `required` |
| `bool` | a flag | `default` |

### Manifest rules

1. **`functions` must be declared exactly**, as `(package, module, function)`. A
   whitelisted package is not enough — a package has many functions and not all are
   safe for an agent.
2. **Declare the prompt and the variables.** The user must see what will shape the
   action and what they will be asked for, before installing.
3. **`agents` must match the grant.** The `publisher.agent` address is the one the
   user grants permission to; the policy's `agent` field is set to it.
4. **Hash it.** `manifestHash` = sha256 of the canonical manifest, recorded by the
   registry so behaviour cannot change under a stable name.

## The action protocol

### Request — Policy Guard → MCP Server

```jsonc
POST /action
{
  "strategy": "cetus-swap",
  "action": "swap",
  "manifestHash": "sha256:…",             // what we believe we are calling
  "policy": "0x…",                        // the on-chain grant
  "agent":  "0x…",                        // the address signing
  "variables": {                          // exactly the declared variables
    "pool": "0x51e883…",
    "direction": "b2a",
    "amountSui": "0.05",
    "slippageBps": 50
  },
  "x402": { "proof": "…" }                // the SERVICE fee, not the allowance
}
```

### Response — MCP Server → Policy Guard

```jsonc
{
  "txBytes": "base64…",
  "manifestHash": "sha256:…",

  // The server's own statement of what it built. This is the hinge of
  // verification: we check the BYTES against the CLAIM rather than inferring
  // intent from bytes.
  "claimed": {
    "action": "swap",
    "pool": "0x51e883…",
    "direction": "b2a",
    "amountIn": "50000000",
    "minOut": "…",
    "sqrtPriceLimit": "…",
    "destination": "0x…"
  }
}
```

## Verification rules

Run by the Policy Guard, before anything is signed. **Pre-flight, not authority.**

```text
1  decode txBytes (BCS) → enumerate every MoveCall
2  every (package, module, function) ∈ manifest.functions        else REFUSE
3  claimed.destination == policy.destination                     else REFUSE  ← value redirect
4  claimed.amountIn ≤ what the user asked for                    else REFUSE
5  claimed.sqrtPriceLimit within policy.max_slippage_bps          else REFUSE  ← the price
6  manifestHash matches the manifest fetched                     else REFUSE
7  the transaction simulates successfully                        else REFUSE
```

Rule 2 catches a call to something undeclared. Rule 3 is the important one: it is
what stops a hostile server redirecting value. Rule 5 is the one that needs new
Move — see [DECISIONS.md](DECISIONS.md#bound-the-slippage-on-chain).

### What this does NOT prove

Stated plainly, because a document that overstates a control is worse than no
document:

- **Whitelisting *what* is called does not constrain *how*.** Arguments carry the
  risk. Allowing a pool's `swap` does not bound the price limit passed to it.
- **Argument values may not be statically resolvable** — they can be composed from
  earlier commands or read from chain state, so "the amount is 0.05" is not always
  checkable from the bytes.
- **A manifest is a supply-chain control, not a value control.** It bounds which
  code the publisher may touch. The chain bounds value.

The real guarantee is the gate stack in [ARCHITECTURE.md](ARCHITECTURE.md): both
servers can be hostile and the limits still hold. Everything above exists to save
gas and mistakes.

## x402 — the service fee

```text
402 Payment Required  →  pay in USDC  →  retry with a proof
```

Precedent: Glassnode runs `x402.glassnode.com` mirroring their standard API
one-to-one, pay-per-request in USDC, no API key, plus a `/metadata` route. The
metadata-route idea for MCP servers follows that shape.

Three rules:

1. **The fee is for the service, the allowance bounds the capital.** They are
   different money and must never be merged in the UI or the code.
2. **The server pays its own gas** and recovers it through the fee, which means it
   carries SUI price risk against a USDC fee. This is also what bounds a key
   compromise to the gas wallet.
3. **A paid fee is not a permission.** Paying does not widen the grant.

## Lifecycle

```text
① DISCOVER   browse / search the marketplace
             filter by action, venue, fee, reputation
② INSTALL    see packages · functions · prompt · fee        ← the consent moment
             choose a budget
             → set_allowance + set_pool_allowed on chain
             → write the local installed record
③ ASK        route over INSTALLED verbs (deterministic)
             model extracts parameters only, grounding runs
④ CONFIGURE  user supplies the declared variables
⑤ PAY+BUILD  POST /action with the x402 fee
⑥ VERIFY     decode · compare against the claim · manifest · simulate
⑦ SIGN+SUBMIT  wallet signs, chain runs the real gates
⑧ RECORD     digest, status, and reputation derived from EVENTS
```

**Installation is what makes routing tractable.** The model never sees hundreds of
published strategies — only the installed set, typically one to five.

**The installed record** must live **server-side**, because routing runs there:

```jsonc
{
  "strategy": "cetus-swap",
  "action": "swap",
  "manifestHash": "sha256:…",
  "verbs": ["swap", "exchange", "convert"],
  "policy": "0x…",
  "agent": "0x…",
  "variables": { … },
  "x402": { "asset": "USDC", "amount": "0.01" }
}
```

**Uninstall** = `set_suspended(policy, true)` + drop the record. Suspension refuses
at gate layer 2, so a stale record cannot be worked around.

**Refusal quality.** When nothing matches, say what *is* installed. An unhelpful
refusal is worse than no refusal — it sends the operator looking in the wrong
place, which is exactly what `borrow_child_object` did for a whole cycle.

## Reference implementation

No publisher exists yet, so the first MCP server should be **ours**: a thin HTTP
wrapper around the existing `swap.js` implementing this contract. That is the
cheapest way to find out which schema fields are actually needed rather than
guessed, and it is the artefact a publisher copies.

Order of work suggested by the design:

1. per-server agent identity (config, not Move) — makes the caller gate testable
2. `max_slippage_bps` on the policy (additive Move) — closes the price hole
3. the reference MCP server + the manifest fetch seam
4. byte decoding and claim verification
5. install / marketplace screens
6. Walrus + SuiNS behind the two seams
