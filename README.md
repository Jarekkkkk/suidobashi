# sui-tokyo

An **on-device agent wallet for Sui**. A local model turns a sentence into a
proposed action; deterministic code disposes; the wallet extension signs; and the
limits that constrain the agent live **on chain**, not in a server.

## The core claim

> The agent cannot exceed its grant, and that holds even if every server in the
> path is compromised.

Everything in this repository exists to make that sentence true. It is also the
test to apply to any new feature: **a feature that puts a limit in a server has
removed the claim rather than extended it.**

Two consequences that shape the code:

1. **The server holds no key and cannot sign.** It builds a transaction, keeps the
   bytes, and submits bytes plus a signature it was handed.
2. **The chain is the only authority.** The server's gate and its simulation are
   pre-flight conveniences — remove them and the limits still bind.

## Read this

| document | answers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How does it work **today**? Objects, access control, the gate stack, the swap route, trust boundaries. |
| [docs/DECISIONS.md](docs/DECISIONS.md) | **Why** is it like this? Every decision with its rationale, what was rejected and why, and the consequences. |
| [docs/MCP-STANDARD.md](docs/MCP-STANDARD.md) | The **forward design**: the publisher/agent contract — manifest, action protocol, verification rules. Not built yet. |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is next, in what order, and **why that order**. Plus open questions and deferrals. |
| [NOTES.md](NOTES.md) | Traps that cost real time. Read this before touching Move or the CLI — it will save you a day. |

Start with **ARCHITECTURE.md** if you are new, **DECISIONS.md** if you are about to
argue with the design, and **NOTES.md** if something is failing inexplicably.

## Where the code lives

```text
move/sources/
  policy.move            the grant: agent, destination, venues, kill switch
  position_guard.move    the object gate: an LP position, with a tick-width bound
  spend_vault.move       OpenZeppelin's allowance ledger, vendored by inlining

src/
  addresses.js           every deployed id — the single source of truth
  hires.js               which policy, cap and venue a strategy uses (bookkeeping only)
  agent.js               the intent layer: extract, ground, gate
  ui.js                  the local server: page, gate, build/submit split
  swap.js, rebalance.js, redeem.js, position lifecycle scripts
  verify-intent.js       checks for the intent layer (8 cases)
  verify-page.js         checks for escaping and amount parsing
  verify-guard.js        checks for guard adoption, against a real transaction

src/web/
  page.js                the page's logic (a real module — see DECISIONS.md)
  markup.js              escaping; safe markup is a String subclass
  units.js               decimal → integer money, exact, no floats
```

Verified limits live in `src/addresses.js` and on chain. `src/hires.js` is
**bookkeeping only** — the chain holds the authority, so a wrong entry produces a
refused transaction rather than a wider permission.

## Running it

```bash
bun install
bun run qvac         # local model on 127.0.0.1:11434
bun run ui           # the UI on 127.0.0.1:8788
bun run verify       # the check suites
bun run test         # Move unit tests
```

The UI binds loopback only and refuses non-loopback without
`UI_ALLOW_NON_LOOPBACK=1`. Its token rotates on every restart, so reload the page
after restarting the server.

Signing is done by the **Slush** browser extension. There is no key in this
repository, in the server, or in any request.

## Status

**Live and proven on Sui mainnet** — not a local simulation:

- a swap through the purpose gate, with `amount_paid == amount_in`
- an on-chain budget refusal, `EAllowanceExceeded`
- a Cetus position created with no address owning it, funded, rebalanced
  atomically with rewards collected, and exited
- `EPoolNotAllowed` when a strategy is pointed at a venue outside its allowlist
- owner actions from the UI: fund vault, set budget, venue open/close
- the full position cycle driven from the UI with wallet-extension signing

**Not proven, and it matters:** **owner/agent separation.** Every agent-path proof
so far was signed by an address that is *both* owner and agent, so no agent path
has ever been refused for being the wrong caller — `ENotAgent` and `ESuspended`
have never fired on mainnet. The access-control claim is currently **reasoned
rather than tested**, which is why per-server agent identity is the recommended
first move in the [roadmap](docs/ROADMAP.md).

## What this is not

- **Not keyless and not custodial.** No TEE, no delegated MPC, no vendor share.
  Those were considered and rejected; see [DECISIONS.md](docs/DECISIONS.md).
- **Not a general-purpose bot.** The model extracts; it never chooses. A 0.6B local
  model will not emit an empty string in a required enum, so it cannot be asked to
  decide anything, and the design does not ask it to.
- **Not finished.** The MCP server standard is designed and unbuilt. See the
  roadmap for what is real versus planned.
