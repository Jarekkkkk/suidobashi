# The talent and the boundary

Two patterns carry this system, and they meet at exactly one line of code. This file is the picture of
that meeting; [`ARCHITECTURE.md`](./ARCHITECTURE.md) has the wider map — objects, the gate stack, the
object gate, what is proven.

- **The talent** is how a *capability* is published: a server, a manifest, one HTTP route per action,
  and a signing key behind it. It is what an agent can call.
- **The boundary** is how a *capability is limited*: a Move module on chain that holds the authority
  and the maker's rules, and refuses anything outside them. It is what an agent cannot exceed.

The line that joins them: **a talent's action shells out to the same runner a person runs by hand.**

---

## 1. Architecture — what runs, where, who calls whom

```mermaid
flowchart LR
    subgraph Edge["Browser"]
        App["React app<br/>src/web/app/main.tsx<br/>3 tabs: chats / talents / outstanding"]
        Wallet["Sui wallet<br/>dapp-kit + local bridge"]
    end

    subgraph Procs["Local processes"]
        UiServer["UI server<br/>bun src/ui.ts :8788<br/>serves /wallet.js + /app.js<br/>/api/* routes, token-gated<br/>holds SUI_SECRET_KEY"]
        Mcp["MCP server<br/>bun src/mcp-server.ts :8790<br/>GET /metadata, POST /fill, POST /grid/run<br/>/schedule, 30s cron<br/>holds AGENT_SECRET_KEY"]
        Query["Query server<br/>bun src/query-server.ts :8791<br/>read-only, no key"]
    end

    Runner["src/run-grid.ts<br/>THE SHARED RUNNER<br/>not a server: spawned by every caller"]

    subgraph Chain["Sui mainnet"]
        Guard["deepbook_guard module v9<br/>0xe420d1be…<br/>holds BalanceManager + TradeCap<br/>enforces agent / band / qty / budget / pause"]
        Book["DeepBook SUI/USDC pool<br/>0xe05dafb5…<br/>shared order book"]
    end

    App -- "HTTP, token-gated" --> UiServer
    App <--> Wallet
    UiServer -- "spawnSync (dry by default)" --> Runner
    Mcp -- "spawnSync" --> Runner
    Runner -- "devInspect + signAndExecute" --> Chain
    UiServer -- "read, and write for its own flows" --> Chain
    Mcp -- "read, and write for its actions" --> Chain
    Query -- "read" --> Chain
    Guard -- "places, cancels, reads" --> Book
```

**The runner is deliberately not a service.** The UI, the MCP server, the cron and a person at a
terminal all execute the same file. One implementation, four entry points, and no way for them to drift
apart — which is also why the plan to "extract the runner into a shared module" was unnecessary and was
never done.

---

## 2. Design — the talent and the boundary

This is the diagram to explain. Two patterns on the left and right, and the runner in the middle.

```mermaid
flowchart TB
    subgraph Talent["THE TALENT — how a capability is published"]
        direction TB
        Manifest["GET /metadata<br/>manifest: strategy, actions[], routes<br/>actions: fill · grid.status · grid.run"]
        Route["POST /grid/run · POST /fill<br/>signed with AGENT_SECRET_KEY"]
        Clock["setInterval 30s<br/>fires due schedules through the same runner"]
    end

    Runner["src/run-grid.ts<br/>read the state · plan inside the rules · sign · submit"]

    subgraph Boundary["THE BOUNDARY — how a capability is limited"]
        direction TB
        Maker["Maker (owner) 0x0b3fc…<br/>sets band · maxQty · budget · agent<br/>withdraws directly, no capability needed"]
        Seat["Agent (seat) 0x0b3fc…<br/>places · cancels<br/>scoped by the maker's band"]
        Held["shared BalanceManager<br/>+ TradeCap wrapped inside the guard<br/>the agent's entire authority"]
        Rules["on every buy and sell:<br/>paused? · agent matches? · price in band?<br/>qty ≤ maxQty? · committed + qty ≤ budget?"]
    end

    Manifest --> Route
    Route -- "spawnSync" --> Runner
    Clock -- "same path" --> Runner
    Runner -- "off-chain: the same rules, readably" --> Rules
    Runner -- "deepbook_guard::buy / sell" --> Held
    Held -- "on chain: the same rules, finally" --> Rules
    Rules -.->|"abort codes: EPriceOutOfBand · EQuantityAboveBound · EBudgetExceeded · EPaused · ENotAgent"| Seat
    Maker -.->|"owner withdraw — an independent path that bypasses the guard"| Held
```

**Read it as a sentence:** a talent action spawns the runner; the runner reads the boundary's state,
plans inside its rules, and submits a transaction the boundary enforces again on chain.

**The rules are enforced twice, and both times matter.** Off-chain, so a sloppy pass is refused with a
reason a person can read. On-chain, so a *malicious* pass is refused with an abort — the agent cannot
spend what the maker did not set, no matter what the runner is told to do or who is holding the agent
key. The second enforcement is the one that matters; the first is the one that is pleasant.

**The maker's exit does not go through the guard at all.** As the account's owner, the maker withdraws
through DeepBook's own owner path, which needs no capability. So a bug in the guard cannot trap
capital, and the guard being paused cannot lock funds in — the same property
[`ARCHITECTURE.md`](./ARCHITECTURE.md) calls the boundary that does not depend on the code.

---

## 3. One pass, end to end

The flow crosses into the boundary twice, in the same direction: once off-chain for sanity, once
on-chain for sovereignty.

```mermaid
sequenceDiagram
    participant A as Agent / clock / person
    participant M as mcp-server :8790
    participant R as run-grid.ts
    participant C as Sui mainnet

    A->>M: POST /grid/run
    M->>R: spawnSync([--guard, --bm, --side, --levels, --expire-min, --execute])
    R->>C: devInspect: guard getters, level-2 book, balances, open orders
    C-->>R: limits, book, funds, resting orders
    R->>R: planGrid(guard, book, open, side, levels, quantity)
    alt plan refused
        R-->>M: refusal with a reason
        M-->>A: ok false, refused
    else plan accepted
        R->>M: transaction bytes
        M->>C: signAndExecuteTransaction(bytes, signer)
        C->>C: deepbook_guard::buy / sell
        Note over C: Move re-checks: paused, agent, band, qty, budget
        C-->>M: effects and events
        R->>C: read back: open orders, committed, funds
        R-->>M: executed, digest, after-state
        M-->>A: ok true, digest, resting count
    end
```

Three details worth pointing at while presenting:

- **The refusal is a feature.** A pass that would breach the band or the budget is refused *before*
  signing, with the reason a maker understands. The chain would refuse it too, with an abort code.
- **The read-back is not a formality.** "Submitted" and "on the book" are different claims, and the
  runner reads the second one — which is why a pass reports `resting: 1` rather than a digest and a
  hope. It is also how a gap was found rather than hidden: an order left the book with no proceeds
  arriving anywhere these reads can see, and DeepBook's *owed* balance has no public accessor. That is
  **unresolved**, about 1.16 USDC, and this doc says so instead of dressing it as a fill.
- **`committed` is monotone.** The budget counts what the agent has ever asked for and never refunds,
  including on a cancel. That is deliberate — a budget that refilled itself would bound nothing.

---

## 4. The three sentences to say out loud

1. **A talent is what an agent can call.** A server, a manifest, one route per action, and a key behind
   it — in this repo, `mcp-server` on :8790, declaring `fill`, `grid.status` and `grid.run`.
2. **A boundary is what an agent cannot exceed.** A Move module holding the account and the trading
   capability, with the maker's band, per-order size and budget enforced on every order.
3. **The runner is where they meet** — spawned by the talent, reading the boundary, planning inside it,
   and submitting something the boundary checks again. One file, four callers, and the agent bounded by
   the maker's numbers rather than by anyone's good behaviour.
