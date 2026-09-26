/* Three-pane UI over the intent loop.
 *
 * Pane 1  what you said, and the intent the local model extracted from it
 * Pane 2  the deterministic decision — the gate, not the model
 * Pane 3  what actually happened on-chain, with a digest anyone can look up
 *
 * Deliberately a single file with no framework and no build step. It shells out
 * to `src/agent.js`, which is the thing already proven to work, so the UI adds no
 * new trust surface: it cannot sign, cannot reach a key, and cannot bypass the
 * gate. Everything it shows is what the CLI reported.
 *
 * Bound to loopback only. If this were reachable from the network, the boundary
 * underneath it would be decoration.
 *
 * Usage: node src/ui.js   →  http://127.0.0.1:8788
 */
import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VAULT_ID, DEPLOYER, USDC_TYPE, REWARD_TYPE, PACKAGE_LATEST_ID, POOL_TICK_SPACING, GUARD_ID, GUARD_SHARED_VERSION, SLIPPAGE_BPS } from './addresses.js';
import { HIRES } from './hires.js';
import { findCreatedGuard, repointAddresses } from './guard-id.js';
import { event, endingFor } from './web/events.js';
import { unitsToUsdc } from './web/units.js';

const PORT = Number(process.env.UI_PORT ?? 8788);
const HOST = process.env.UI_HOST ?? '127.0.0.1';
/** Where the reference MCP server listens, for the fill notification. */
const MCP_HOST = process.env.MCP_HOST ?? '127.0.0.1';
const MCP_PORT = Number(process.env.MCP_PORT ?? 8790);

/**
 * Refuse to listen anywhere but loopback unless explicitly forced. This page can
 * spend, so binding it to a routable address would expose the agent to the
 * network — the kind of change that should be deliberate and loud, not a config
 * edit that slips through.
 */
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/;
if (!LOOPBACK.test(HOST) && process.env.UI_ALLOW_NON_LOOPBACK !== '1') {
  console.error(
    `refusing to bind ${HOST}: this serves an agent that can spend.\n` +
    'Set UI_ALLOW_NON_LOOPBACK=1 if you genuinely mean to expose it.',
  );
  process.exit(1);
}

/**
 * Per-run token, injected into the page we serve and required on every /api call.
 *
 * Loopback is not user-scoped, so any local process can reach this port. The
 * token stops a *remote* page from driving the agent through a cross-origin
 * request — it cannot read the token, because same-origin policy blocks reading
 * our response body. It does not defend against malware already running as this
 * user, and nothing on loopback would.
 */
const TOKEN = crypto.randomBytes(24).toString('hex');

/**
 * Build the React app and its CSS at startup, the same way the wallet bundle is.
 *
 * TWO build steps, because they are genuinely two tools: bun bundles the TSX, and
 * Tailwind's CLI turns the CSS-first config into the classes actually used. Both write
 * to a temp path outside the project and are removed, so nothing generated is ever
 * mistaken for source — and neither can be stale relative to src/web/app/.
 */
function buildAppBundle() {
  const jsPath = path.join(os.tmpdir(), `sui-tokyo-app-${process.pid}.js`);
  const cssPath = path.join(os.tmpdir(), `sui-tokyo-app-${process.pid}.css`);

  const b = spawnSync(
    'bun',
    ['build', 'src/web/app/main.tsx', '--outfile', jsPath, '--format=esm', '--target=browser'],
    { encoding: 'utf-8', timeout: 120_000 },
  );
  if (b.status !== 0) {
    console.error('app bundle build failed:', ((b.stderr || b.stdout) || 'no output').slice(-400));
    return null;
  }

  const c = spawnSync(
    'bunx',
    ['@tailwindcss/cli', '-i', 'src/web/app/app.css', '-o', cssPath],
    { encoding: 'utf-8', timeout: 120_000 },
  );
  if (c.status !== 0) {
    console.error('app css build failed:', ((c.stderr || c.stdout) || 'no output').slice(-400));
    return null;
  }

  try {
    const built = { js: fs.readFileSync(jsPath, 'utf-8'), css: fs.readFileSync(cssPath, 'utf-8') };
    fs.unlinkSync(jsPath);
    fs.unlinkSync(cssPath);
    return built;
  } catch (e) {
    console.error('app output unreadable:', e.message);
    return null;
  }
}

/**
 * The React app's shell.
 *
 * Served ALONGSIDE the original page, not in place of it. The old UI is the reference the
 * port is checked against, and it stays until the new one is confirmed working —
 * deleting it first would throw away the only thing that can tell us the port is faithful.
 *
 * The wallet bundle is a separate script because it installs window.agentWallet, which the
 * app uses. The app also waits for that bridge rather than assuming script order, so
 * changing this line cannot silently break signing.
 */
const APP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sui-tokyo</title>
<link rel="stylesheet" href="/app.css">
</head>
<body data-token="__TOKEN__">
<div id="app"></div>
<script type="module" src="/wallet.js"></script>
<script type="module" src="/app.js"></script>
</body>
</html>`;

/**
 * Build the wallet bundle at startup and hold it in memory.
 *
 * Generated rather than committed: 850 KB of transpiled libraries does not belong
 * in the tree, and building at start means it can never be stale relative to
 * src/web/wallet-entry.js. Written to a temp path outside the project so it is
 * never mistaken for source, then removed.
 */
function buildWalletBundle() {
  const out = path.join(os.tmpdir(), `agent-wallet-bundle-${process.pid}.js`);
  const r = spawnSync(
    'bun',
    ['build', 'src/web/wallet-entry.js', '--outfile', out, '--format=esm', '--target=browser'],
    { encoding: 'utf-8', timeout: 120_000 },
  );
  if (r.status !== 0) {
    console.error('wallet bundle build failed:', ((r.stderr || r.stdout) || 'no output').slice(-400));
    return null;
  }
  try {
    const js = fs.readFileSync(out, 'utf-8');
    fs.unlinkSync(out);
    return js;
  } catch (e) {
    console.error('wallet bundle unreadable:', e.message);
    return null;
  }
}

/** Run the CLI with an argv array and no shell, so text cannot be interpolated. */
function runAgent(text, extra = []) {
  const r = spawnSync('node', ['src/agent.js', text, ...extra], {
    encoding: 'utf-8',
    timeout: 300_000,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status ?? 1 };
}

/**
 * Read each hire's state straight off its policy object. These are the fields the
 * chain enforces, so they are read rather than remembered — the local registry
 * only supplies the human-readable name and the granted figure.
 */
async function hires() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  const out = [];
  for (const [name, h] of Object.entries(HIRES)) {
    const row = { name, policyId: h.policyId, budgetSui: h.budgetSui,
                  feeBps: h.venue.feeBps, venueId: h.venue.id };
    try {
      const o = await client.getObject({ objectId: h.policyId, include: { json: true } });
      const j = (o.object ?? o).json ?? {};
      row.agent = j.agent;
      row.suspended = Boolean(j.suspended);
      const list = (j.allowed_pools?.contents ?? []).map((x) => String(x).toLowerCase());
      row.venues = list.length;
      // Whether this hire's OWN venue is open, read from the chain. A count alone
      // hides the difference between two hires on two different pools.
      row.ownVenueOpen = list.includes(String(h.venue.id).toLowerCase());
      row.destination = j.destination;
    } catch (e) {
      row.error = String(e?.message || e).slice(0, 120);
    }
    out.push(row);
  }
  return out;
}

/**
 * Builds awaiting a signature, keyed by id. The bytes stay HERE.
 *
 * The browser receives the bytes to sign and returns only a signature, so a
 * stale tab or a tampered page cannot substitute a different transaction — the
 * signature would not verify against these bytes. And because the entry is
 * single-use and short-lived, a captured id is not replayable past one submit.
 */
const pending = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function prunePending() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, v] of pending) if (v.at < cutoff) pending.delete(id);
}

/** First complete JSON document on stdout — agent.js may print more than one. */
function firstJson(stdout) {
  const s = stdout || '';
  const start = s.indexOf('{');
  for (let end = s.length; end > start && start >= 0; end--) {
    try {
      return JSON.parse(s.slice(start, end));
    } catch { /* keep shrinking */ }
  }
  return null;
}

/** Parse a MIST amount from request input, tolerating strings. Null if unusable. */
/**
 * The floor for an escrowed order, from a live quote.
 *
 * An order needs a CONCRETE min_out. A swap does not: its protection is the policy's
 * on-chain bound, checked at execution time. An order fixes its floor when it is created
 * and the settlement asserts against that number later, so it cannot be left for the
 * chain to decide — something has to name it now.
 *
 * The bound is SLIPPAGE_BPS, the SAME constant the swap path, the settlement and the MCP
 * server use, so a chat-typed order and a swap agree on what "too much slippage" means.
 * If nobody can fill inside it, the order expires and refunds — the designed outcome, not
 * a failure.
 *
 * The advisor is run as a subprocess rather than reimplemented: it already prints JSON,
 * and it refuses a quote that is off reference market. That refusal must be respected,
 * not papered over with a guessed floor — a floor invented here would either shortchange
 * the maker or make the order unfillable, and both look like success until money moves.
 *
 * ADMISSIBLE, NOT DIRECT. The advisor also reports whether a single-hop Cetus path exists,
 * because a multi-hop route is not executable by our module. That matters for EXECUTION
 * and not for PRICING: the filler trades the direct pool itself, while this number only
 * has to be a real market price to anchor a floor. At 0.01 SUI the aggregator finds no
 * direct path but does quote an admissible price, and demanding a direct path here would
 * refuse a perfectly good floor for a reason that belongs to the other side of the trade.
 *
 * THE FEE COMES OUT OF THE SLIPPAGE BUDGET, not on top of it. Settlement asserts
 * `output - fee >= min_out`, so the floor is what the maker RECEIVES while the total
 * output has to cover the fee as well. Setting the floor at the full 99%-of-quote and then
 * adding a fee demands MORE than the market will produce — at 0.01 SUI the required output
 * came to 184% of the quote, an order that could never fill and would sit there looking
 * fine until it expired. Subtracting the fee here means both the tolerance and the tip
 * are paid for out of the same 1%, which is the only way the arithmetic closes.
 *
 * Returns null when the fee leaves no room — that is a real answer, not a failure to quote.
 */
function quoteMinOut(amountMist, feeOut) {
  const r = spawnSync('node', ['src/advisor.js', String(amountMist)], {
    encoding: 'utf-8', timeout: 60_000,
  });
  const doc = firstJson(r.stdout);
  if (!doc || !doc.admissible) return null;
  const out = BigInt(doc.quoteAmountOut ?? 0);
  if (out <= 0n) return null;
  const floor = (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  return floor > feeOut ? floor - feeOut : null;
}

/**
 * Parse a decimal string of base units, or null if it is not one.
 *
 * NULL MEANS ABSENT OR UNPARSEABLE. This used to coerce an absent value to '0' before
 * parsing, which made `toMist(undefined)` return 0n — so "missing" and "zero" were the
 * same answer. That is not a cosmetic difference: it silently turned a missing order TTL
 * into a ZERO-length order, and it made `x ?? default` dead code everywhere, because a
 * missing value never produced the null the default was waiting for.
 *
 * The order-amount check below hit it a third time. Three bugs from one cause means the
 * cause is here, not in the three call sites — every one of which already handled null
 * correctly and was defeated by never being given one.
 *
 * Empty string is treated as absent rather than as zero, for the same reason: a blank
 * input field is not a typed zero.
 */
function toMist(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  try {
    const b = BigInt(s);
    return b >= 0n ? b : null;
  } catch {
    return null;
  }
}

/**
 * The guard's tick-width bounds, mirrored from the chain so a bad range gets a
 * clear refusal. The chain re-checks them (assert_range_in_bounds), so a stale
 * copy here can only ever refuse something legal — never allow something illegal.
 */
const GUARD_MIN_WIDTH = 100;
const GUARD_MAX_WIDTH = 2_000;

/**
 * Resolve an action to a script and its environment, server-side.
 *
 * The browser names an *action*, never a script or an amount: a swap's plan comes
 * from re-deriving it here off the user's own words, so a tampered page cannot ask
 * for a different amount, policy or venue than the gate approved.
 */
function actionFor(kind, body) {
  if (kind === 'swap') {
    const doc = firstJson(runAgent(body.text || '').stdout);
    if (!doc) return { error: 'could not parse a proposal from the agent' };
    if (doc.decision !== 'PROPOSED') {
      return { refused: (doc.validation && doc.validation.reason) || doc.decision };
    }
    return { script: doc.plan.command, env: doc.plan.env, proposal: doc };
  }
  if (kind === 'suspend') {
    if (!body.hire || !(body.hire in HIRES)) return { error: 'unknown hire' };
    return {
      script: 'node src/set-suspended.js',
      env: { HIRE: body.hire, SUSPEND: body.suspended ? 'true' : 'false' },
      proposal: { action: body.suspended ? 'suspend' : 'resume', hire: body.hire },
    };
  }
  if (kind === 'topup') {
    const mist = toMist(body.amountMist);
    if (mist === null || mist <= 0n) return { error: 'amountMist must be a positive integer' };
    return {
      script: 'node src/topup-vault.js',
      // SKIP_BUDGET: funding and granting are separate operations here, so the
      // vault figure changes without silently moving anyone's ceiling.
      env: { TOPUP_MIST: String(mist), SKIP_BUDGET: '1' },
      proposal: { action: 'fund the vault', amountSui: (Number(mist) / 1e9).toString() },
    };
  }
  if (kind === 'budget') {
    if (!body.hire || !(body.hire in HIRES)) return { error: 'unknown hire' };
    const mist = toMist(body.amountMist);
    if (mist === null) return { error: 'amountMist must be a non-negative integer' };
    return {
      script: 'node src/set-budget.js',
      env: { HIRE: body.hire, BUDGET_MIST: String(mist) },
      proposal: {
        action: 'set budget',
        hire: body.hire,
        amountSui: (Number(mist) / 1e9).toString(),
      },
    };
  }
  if (kind === 'venue') {
    if (!body.hire || !(body.hire in HIRES)) return { error: 'unknown hire' };
    const venue = body.venue || HIRES[body.hire].venue.id;
    const allow = body.allow !== false;
    return {
      script: 'node src/hire-agent.js --allowlist',
      env: { HIRE: body.hire, VENUE: venue, ALLOW: allow ? 'true' : 'false' },
      proposal: {
        action: allow ? 'allow swap pool' : 'block swap pool',
        hire: body.hire,
        venue,
      },
    };
  }
  if (kind === 'position') {
    // Provisioning: mints a new guard around a fresh Cetus position. The guard id
    // is not predictable here — object::new runs on the validator — so it has to be
    // read back from the transaction afterwards. See NOTES on the position cycle.
    return {
      script: 'node src/create-position.js',
      env: {},
      proposal: { action: 'open a guarded position' },
    };
  }
  if (kind === 'deposit') {
    const usdc = toMist(body.fixAmountUsdc);
    const sui = toMist(body.supplySui);
    if (usdc === null || usdc <= 0n) return { error: 'fixAmountUsdc must be a positive integer' };
    if (sui === null || sui <= 0n) return { error: 'supplySui must be a positive integer' };
    // Ceilings, not policy: this path is owner-gated and owner-signed, but a
    // tampered page should not be able to name an arbitrary withdrawal.
    if (usdc > 10_000_000n) return { error: 'fixAmountUsdc above 10 USDC is not allowed here' };
    if (sui > 5_000_000_000n) return { error: 'supplySui above 5 SUI is not allowed here' };
    return {
      script: 'node src/deposit-liquidity.js',
      // SUPPLY_SUI is headroom, not a spend: the module adds a fixed USDC amount and
      // routes whatever the SUI side does not consume back to the destination.
      env: {
        FIX_AMOUNT: String(usdc), SUPPLY_SUI: String(sui),
        GUARD_ID: activeGuard.id, GUARD_SHARED_VERSION: String(activeGuard.version),
      },
      proposal: {
        action: 'fund the position',
        usdc: (Number(usdc) / 1e6).toString(),
        suiHeadroom: (Number(sui) / 1e9).toString(),
      },
    };
  }
  if (kind === 'rebalance') {
    const lo = Number(body.tickLower);
    const hi = Number(body.tickUpper);
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return { error: 'ticks must be integers' };
    if (lo >= hi) return { error: 'tickLower must be below tickUpper' };
    if (lo % POOL_TICK_SPACING !== 0 || hi % POOL_TICK_SPACING !== 0) {
      return { error: `ticks must be multiples of the pool spacing (${POOL_TICK_SPACING})` };
    }
    const width = hi - lo;
    if (width < GUARD_MIN_WIDTH || width > GUARD_MAX_WIDTH) {
      return {
        error: `width ${width} is outside the guard's bounds ${GUARD_MIN_WIDTH}..${GUARD_MAX_WIDTH}`,
      };
    }
    return {
      script: 'node src/rebalance.js',
      env: {
        NEW_TICK_LOWER: String(lo), NEW_TICK_UPPER: String(hi),
        GUARD_ID: activeGuard.id, GUARD_SHARED_VERSION: String(activeGuard.version),
      },
      proposal: { action: 'rebalance into a new range', tickLower: lo, tickUpper: hi, width },
    };
  }
  if (kind === 'redeem') {
    return {
      script: 'node src/redeem.js',
      env: { GUARD_ID: activeGuard.id, GUARD_SHARED_VERSION: String(activeGuard.version) },
      proposal: { action: 'exit the position' },
    };
  }
  if (kind === 'withdraw') {
    // Owner-gated, and the only route back to custody. Deliberately takes no amount
    // from the browser: the operation that matters is emptying the vault, and an
    // amount field here would only be a way to get a partial withdrawal wrong. The
    // script still accepts WITHDRAW_MIST for taking part of it by hand.
    //
    // This is also the step that must happen BEFORE a package upgrade: an upgrade
    // replaces code, and the safe moment to change code is while the vault is empty.
    return {
      script: 'node src/withdraw-vault.js',
      env: {},
      proposal: { action: 'withdraw the whole vault', destination: DEPLOYER },
    };
  }
  if (kind === 'repoint') {
    if (!body.hire || !(body.hire in HIRES)) return { error: 'unknown hire' };
    const agent = String(body.agent || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(agent)) {
      return { error: 'agent must be a full 0x address (64 hex characters)' };
    }
    // toMist parses any non-negative integer; a basis-point bound is a u64 too.
    const bps = toMist(body.boundBps);
    if (bps === null) return { error: 'boundBps must be a non-negative integer' };
    // The chain refuses this too, but saying it here saves a signature.
    if (bps > 500n) return { error: 'the policy refuses a bound above 500 bps' };

    return {
      script: 'node src/hire-agent.js --repoint',
      env: { HIRE: body.hire, AGENT: agent, BOUND_BPS: String(bps) },
      proposal: {
        action: 'hand the grant to a different agent, and bound its price',
        hire: body.hire,
        agent,
        boundBps: String(bps),
      },
    };
  }
  if (kind === 'order') {
    // Escrow a swap order: step 1 of the escrow flow, and the ONLY step where money
    // moves. The coin leaves the wallet here and sits inside the order until someone
    // fills it or it expires.
    //
    // The amount can arrive two ways. From the form, as amountMist — the user typed it.
    // From the chat, as text — and then the AGENT reads it, exactly as the swap path
    // does, so the model is never the thing that decides a number. Both routes land on
    // the same field, and by the time we are here the gate has already run on the text.
    let amount = toMist(body.amountMist);
    if (amount === null && typeof body.text === 'string') {
      const doc = firstJson(runAgent(body.text).stdout);
      if (doc && doc.decision === 'PROPOSED') amount = toMist(doc.plan?.env?.SWAP_MIST);
    }
    if (amount === null || amount <= 0n) {
      return { error: 'amountMist must be a positive integer, or text the agent can read one from' };
    }

    // The fee is the maker's offer to whoever fills, and it defaults to the FILLER'S OWN
    // FLOOR — MCP_MIN_FEE_OUT, 0.01 USDC. A default of zero looked reasonable and was
    // not: the reference server refuses an order below its floor, so every chat-typed
    // order would have been built, escrowed, and then quietly ignored until it expired.
    // Escrowing money nobody will take is a worse outcome than a slightly higher fee.
    //
    // The form always sends a fee (an empty field is refused, not defaulted), so this
    // only ever applies to an order the agent read from text.
    const feeOut = body.feeOutUsdc != null ? toMist(body.feeOutUsdc) : 10_000n;

    // The floor is REQUIRED here, unlike a swap whose bound the policy enforces at
    // execution. An order fixes its floor at creation and the settlement asserts against
    // that number later, so it has to be named now. From the form it is typed; from the
    // chat it comes from a live quote, with the fee taken out of the same budget.
    const minOut = body.minOutUsdc != null ? toMist(body.minOutUsdc) : quoteMinOut(amount, feeOut);
    if (minOut === null || minOut <= 0n) {
      return {
        error: 'no floor is available for this order — either minOutUsdc was not a positive '
          + 'integer, or a live quote could not be had, or the fee leaves no room at this size',
      };
    }

    // A PRINCIPLED LINE, not a tuned threshold: the tip must not exceed what the maker
    // keeps. At 0.01 SUI the quote is ~0.0118 USDC and a 0.01 fee leaves the maker 0.0017
    // — a trade being done FOR the tip rather than with it. Both numbers are arithmetically
    // valid and the order would fill, which is exactly why this needs saying: it would look
    // like a success while handing over 85% of the trade. Refusing with the numbers named
    // lets the user escrow more or offer less, and neither is something we should choose
    // for them.
    if (minOut < feeOut) {
      return {
        error: `the fee (${unitsToUsdc(feeOut)} USDC) is larger than what you would receive `
          + `(${unitsToUsdc(minOut)} USDC) — escrow more SUI, or offer a smaller fee`,
      };
    }
    // A TYPO GUARD, not a security boundary. What protects the maker is their
    // SIGNATURE: every order needs wallet approval, so a tampered page cannot escrow
    // anything without it. This exists only to catch a fat-fingered amount.
    //
    // Set well above any plausible test for that reason. The first version capped at
    // 1 SUI and blocked a legitimate 10 SUI order — a typo guard that refuses real
    // intent has quietly become a limit, which is the wrong thing to have built by
    // accident.
    if (amount > 10_000_000_000n) return { error: 'escrow above 10 SUI is not allowed here' };

    return {
      script: 'node src/create-order.js',
      // No TTL from the browser: the UI has no field for it, so the script's own default
      // applies — 60 seconds, set in create-order.js. (This comment said 24 hours, which
      // was never true; the TTL has always been a minute, and ORDER-ESCROW.md and
      // MCP-STANDARD.md both say so.)
      //
      // Passing one through was a bug, and the fix for it was deeper than this call site:
      // `toMist(undefined)` returned 0n, and `0n ?? default` is 0n, so a missing value
      // silently became a ZERO-length order that `create` refused as already expired. That
      // is fixed at the source — toMist now returns null for absent input, which is what
      // makes `??` work at all.
      env: {
        ORDER_AMOUNT_MIST: String(amount),
        ORDER_MIN_OUT: String(minOut),
        ORDER_FEE_OUT: String(feeOut),
      },
      proposal: {
        action: 'escrow a swap order',
        escrowSui: (Number(amount) / 1e9).toString(),
        minOutUsdc: (Number(minOut) / 1e6).toString(),
        feeOutUsdc: (Number(feeOut) / 1e6).toString(),
      },
    };
  }
  if (kind === 'revoke' || kind === 'refund') {
    // Revoking an expired order: taking back your own escrow, which is why "refund" was the
    // wrong name for it. It read as paying someone out.
    //
    // Permissionless on chain — anyone may call it, and the funds ALWAYS go to the maker — so
    // this is not gated to the maker. Maker-only was considered and rejected: it would mean a
    // lost key loses the money permanently, and ENotExpired already prevents anyone pulling an
    // order out from under a live fill.
    //
    // Both names accepted so an older caller does not silently stop working.
    const orderId = String(body.orderId || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(orderId)) {
      return { error: 'orderId must be a full 0x object id (64 hex characters)' };
    }
    return {
      script: 'node src/refund-order.js',
      env: { ORDER_ID: orderId },
      proposal: { action: 'revoke an expired order', orderId },
    };
  }
  if (kind === 'burn') {
    // Step 3: reclaim the storage of a settled order. Maker-gated on chain, so a
    // stranger cannot take the rebate — but the id is checked here too, because a
    // malformed one produces an unreadable failure from the resolver.
    const orderId = String(body.orderId || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(orderId)) {
      return { error: 'orderId must be a full 0x object id (64 hex characters)' };
    }
    return {
      script: 'node src/burn-order.js',
      env: { ORDER_ID: orderId },
      proposal: { action: 'reclaim a settled order\u2019s storage', orderId },
    };
  }
  return { error: `unknown action "${kind}"` };
}

/**
 * Which guard to operate on. Runtime state, not a constant.
 *
 * A guard is emptied for good when its position is exited, and the next `create` mints
 * a new one with a new id generated on the validator. This process is the authority:
 * it passes the value to every guard script and adopts the new one after a create, so
 * the scripts, the messages and the config cannot disagree about which guard is meant.
 * addresses.js is where it is persisted, and where it starts from.
 */
let activeGuard = { id: GUARD_ID, version: GUARD_SHARED_VERSION };

/**
 * Adopt the guard that a just-submitted `position` transaction minted.
 *
 * Without this, the next deposit, rebalance or redeem targets the previous guard --
 * which a prior exit left empty -- and fails with `borrow_child_object`, a message
 * that reads like "you forgot to open a position" when the operator just did.
 *
 * Persisted back into addresses.js so it survives a restart and shows up in git.
 * The write is checked before it happens: this file holds every deployed id, and a
 * corrupt one is far worse than a stale one.
 */
function adoptGuardFrom(digest) {
  const r = spawnSync('sui', ['client', 'tx-block', digest, '--json'],
    { encoding: 'utf-8', timeout: 120_000 });

  let doc;
  try {
    doc = JSON.parse(r.stdout || '');
  } catch {
    return { error: 'could not read the transaction back to find the new guard' };
  }

  // Reading the guard out of the effects, and rewriting the config to point at it,
  // both live in src/guard-id.js and are tested against a real transaction by
  // src/verify-guard.js. They are not written inline here on purpose: the first
  // version of this function kept its own copy, so the check tested a module nothing
  // ran while the code that did run went untested -- and the two had already drifted.
  const found = findCreatedGuard(doc);
  if (found.error) return found;
  const { id, version } = found;

  activeGuard = { id, version }; // in memory first: the transaction already happened

  const file = 'src/addresses.js';
  let before;
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { id, version, persisted: false, note: `adopted in memory; could not read ${file}: ${e.message}` };
  }

  // null means the file did not match, and nothing should be written. See
  // repointAddresses: a half-updated pair is worse than a stale one.
  const after = repointAddresses(before, id, version);
  if (!after) {
    return { id, version, persisted: false, note: `adopted in memory; ${file} did not match and was left alone` };
  }

  try {
    fs.writeFileSync(`${file}.tmp`, after);
    fs.renameSync(`${file}.tmp`, file);
    return { id, version, persisted: true };
  } catch (e) {
    // Swallowed on purpose. The transaction succeeded and the guard is adopted in
    // memory, so the caller still needs an answer about it; letting this throw would
    // escape submit() into the request handler and return nothing at all.
    return { id, version, persisted: false, note: `adopted in memory; could not write ${file}: ${e.message}` };
  }
}

/**
 * Turn a raw chain abort into something an operator can act on.
 *
 * The dry run refusing a doomed transaction is correct — but a Move abort code is
 * not an explanation, and "borrow_child_object" tells a person nothing about what
 * to do next. These are the aborts this project actually keeps hitting.
 */
function explainAbort(message) {
  const m = String(message || '');
  if (m.includes('borrow_child_object') && m.includes('abort code: 1')) {
    // Deliberately does not say "open a position first". That was the first version
    // of this message, and it was wrong: the usual cause is not a missing position
    // but a guard that was already exited, so the operator is told to do something
    // they just did. Names the guard it actually checked, so a mismatch is visible.
    return `there is no position inside the guard this server is using `
      + `(${activeGuard.id.slice(0, 12)}…). Either no position has been opened yet, or this is `
      + 'a guard that was exited earlier: exiting empties a guard for good, and the next open '
      + 'mints a new one whose id this process adopts from that transaction. The order is: '
      + 'open, fund, rebalance, exit.';
  }
  return m.slice(-400);
}

/**
 * How far back the outstanding scan looks. A BOUND, not a preference: each transaction in the
 * window costs one chain read, so this is the knob that decides whether the tab answers in two
 * seconds or twenty. Raise it when the history is longer than the window, and consider the
 * cost rather than assuming it is free.
 */
const SCAN = Number(process.env.OUTSTANDING_SCAN ?? '15');

/**
 * Every order the maker has left in a state that needs acting on.
 *
 * Discovery works because `listTransactions` HONOURS its filter and validates it — unlike
 * `listEvents`, which silently ignores every shape. This project spent a long time believing
 * a watcher was impossible on the strength of the wrong method.
 *
 * Two shapes are outstanding, and they need different actions:
 *
 *   funds != 0        LIVE — unfilled. Revocable once expired; a refund before then aborts
 *                     with ENotExpired, which is the guard stopping a maker racing their own
 *                     order.
 *   funds == 0        SETTLED — unburned. The storage rebate is the maker's to reclaim, and
 *                     burn is maker-gated so nobody else can take it.
 *
 * An order that was already burned is gone from the chain and simply does not appear.
 *
 * IT IS A SNAPSHOT, NOT A LIVE FEED. Bounded at SCAN transactions, and the caller is told
 * when it was taken so the UI can say so rather than implying it is current.
 */
async function outstandingOrders() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });
  const maker = process.env.SUI_SENDER || DEPLOYER;

  const list = await client.listTransactions({ filter: { sender: maker }, limit: SCAN });
  const digests = (list.transactions ?? []).map((t) => (t.Transaction ?? t).digest).filter(Boolean);

  // The created ids from each transaction. Sequential rather than parallel: this is a chain
  // read per transaction and a burst of them is how a public node starts rate-limiting.
  const ids = new Set();
  for (const digest of digests) {
    try {
      const r = await client.getTransaction({ digest, include: { effects: true } });
      const t = r.Transaction ?? r.FailedTransaction ?? r;
      for (const ch of t.effects?.changedObjects ?? []) {
        if (ch.idOperation === 'Created') ids.add(ch.objectId);
      }
    } catch { /* a transaction we cannot read contributes nothing */ }
  }
  if (ids.size === 0) {
    return { orders: [], scanned: digests.length, candidates: 0, orderObjects: 0, at: Date.now() };
  }

  // ONE batched read for every candidate, rather than one each. The type check happens here
  // because a create also mints other objects — the coin, for instance — and `order::Order`
  // is what distinguishes them.
  const got = await client.getObjects({ objectIds: [...ids], include: { json: true } });
  const rows = got.objects ?? got.data ?? [];

  const orders = [];
  let orderObjects = 0;
  for (const row of rows) {
    const o = row.object ?? row;
    const type = String(o.type ?? '');
    if (!type.includes('::order::Order<')) continue;
    orderObjects++;
    const j = o.json ?? {};
    const funds = BigInt(String(j.funds ?? '0'));
    orders.push({
      orderId: o.objectId,
      maker: j.maker ?? null,
      destination: j.destination ?? null,
      minOut: String(j.min_out ?? '0'),
      expiresAtMs: String(j.expires_at_ms ?? '0'),
      pool: j.pool_id ?? null,
      state: funds === 0n ? 'settled' : 'live',
      /** What to do about it, so the UI never has to infer it from the state name. */
      action: funds === 0n ? 'burn' : 'revoke',
      expired: BigInt(j.expires_at_ms ?? '0') < BigInt(Date.now()),
    });
  }

  // THE COUNTERS ARE THE POINT, not decoration. An empty `orders` is indistinguishable from a
  // broken scan — the mistake this project has already made twice, with listEvents and with a
  // build artefact. `candidates` says the creates were found and read; `orderObjects` says how
  // many were still on chain. A scan reporting 0 candidates is BROKEN; one reporting candidates
  // and 0 order objects has simply found nothing left to do, because burned orders are gone.
  return {
    orders,
    scanned: digests.length,
    candidates: ids.size,
    orderObjects,
    at: Date.now(),
    maker,
  };
}

/**
 * The order a create transaction minted, read from its effects.
 *
 * Needed because an order id is generated on chain, so the browser cannot know it —
 * and the MCP server has to be told inside the order's window. With a one-minute
 * default that notification cannot be a person relaying a digest.
 */
function findCreatedOrder(digest) {
  const r = spawnSync('sui', ['client', 'tx-block', digest, '--json'],
    { encoding: 'utf-8', timeout: 120_000 });
  let doc;
  try {
    doc = JSON.parse(r.stdout || '');
  } catch {
    return null;
  }
  const created = (doc.objectChanges || []).find((c) => c.type === 'created'
    && String(c.objectType || '').includes('::order::Order<'));
  return created?.objectId ?? null;
}

/**
 * Build the transaction and hold the bytes. No key, no signature, no submission —
 * `tx.build({ client })` runs a resolution pass that simulates, so a doomed
 * transaction fails here rather than after the user has approved it.
 */
function build(kind, body) {
  const a = actionFor(kind, body);
  if (a.error || a.refused) return a;

  const [cmd, ...args] = a.script.split(/\s+/);
  const built = spawnSync(cmd, [...args, '--emit-bytes'], {
    env: { ...process.env, ...a.env },
    encoding: 'utf-8',
    timeout: 300_000,
  });
  const bytes = (built.stdout || '').trim();
  if (built.status !== 0 || !bytes) {
    // Strip the CLI's "fatal:" prefix — this text goes to a person in the UI.
    const raw = ((built.stderr || built.stdout) || 'build failed').trim();
    return { error: explainAbort(raw.replace(/^fatal:\s*/i, '')) };
  }

  prunePending();
  const id = crypto.randomUUID();
  pending.set(id, { bytes, proposal: a.proposal, at: Date.now(), kind });
  return { id, bytes, proposal: a.proposal };
}

/**
 * Submit bytes we built, with a signature we did not provide.
 *
 * `execute-signed-tx` cannot sign anything — it submits already-signed bytes. So
 * the process that runs it holds no key.
 */
function submit(id, signature) {
  const entry = pending.get(id);
  if (!entry) return { error: 'unknown or expired build id — build it again' };
  pending.delete(id); // single use, regardless of outcome

  const r = spawnSync(
    'sui',
    ['client', 'execute-signed-tx', '--tx-bytes', entry.bytes, '--signatures', signature],
    { encoding: 'utf-8', timeout: 300_000 },
  );
  const all = `${r.stdout || ''}${r.stderr || ''}`;
  const digest = all.match(/Transaction Digest: (\w+)/)?.[1];
  const status = all.match(/Status: (\w+)/)?.[1];

  // A create changes which guard everything else must address, so adopt it here,
  // immediately and in one place, rather than leaving the value to be hand-edited
  // between one click and the next.
  const guard = entry.kind === 'position' && digest && status === 'Success'
    ? adoptGuardFrom(digest)
    : null;

  return {
    digest,
    status,
    output: all.slice(0, 800),
    ...(guard ? { guard } : {}),
  };
}

async function state() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });
  const at = async (owner, coinType) => {
    const b = await client.getBalance({ owner, coinType });
    return b.balance?.balance ?? '0';
  };
  return {
    vaultSuiMist: await at(VAULT_ID, '0x2::sui::SUI'),
    walletSuiMist: await at(DEPLOYER, '0x2::sui::SUI'),
    usdc: await at(DEPLOYER, USDC_TYPE),
    cetus: await at(DEPLOYER, REWARD_TYPE),
    vaultId: VAULT_ID,
    packageId: PACKAGE_LATEST_ID,
  };
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>on-device agent wallet</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
         background:#111; color:#ddd; }
  header { padding:14px 18px; border-bottom:1px solid #262626; }
  h1 { margin:0; font-size:15px; font-weight:600; letter-spacing:.02em; }
  header .sub { color:#777; font-size:12px; margin-top:4px; }
  .wrap { display:grid; grid-template-columns:1fr 1fr 1fr; gap:1px;
          background:#262626; min-height:calc(100vh - 108px); }
  .pane { background:#111; padding:14px 16px; overflow:auto; }
  .pane h2 { margin:0 0 10px; font-size:12px; text-transform:uppercase;
             letter-spacing:.08em; color:#666; font-weight:600; }
  .ask { display:flex; gap:8px; margin:12px 18px 0; }
  input[type=text] { flex:1; background:#1a1a1a; border:1px solid #333; color:#eee;
                     padding:10px 12px; border-radius:6px; font:inherit; }
  input[type=text]:focus { outline:none; border-color:#4a7; }
  button { background:#1f6f4a; border:0; color:#fff; padding:10px 16px;
           border-radius:6px; font:inherit; cursor:pointer; }
  button:disabled { background:#2a2a2a; color:#666; cursor:not-allowed; }
  button.ghost { background:#1d1d1d; border:1px solid #333; }
  pre { margin:0; white-space:pre-wrap; word-break:break-word; font:inherit; }
  .k { color:#666; }
  .ok { color:#5c8; } .bad { color:#e77; } .warn { color:#db3; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:3px 0; }
  a { color:#6af; }
  .stats { padding:12px 18px; border-top:1px solid #262626; color:#888; font-size:12px;
           display:flex; gap:22px; flex-wrap:wrap; }
  .stats b { color:#ccc; font-weight:600; }
  .hires { padding:10px 18px; display:flex; gap:12px; flex-wrap:wrap;
           align-items:center; border-bottom:1px solid #262626; }
  .hires .label { color:#666; font-size:12px; text-transform:uppercase;
                  letter-spacing:.08em; }
  .hires .legend { color:#555; font-size:11px; width:100%; margin-top:2px; }
  .wallet { padding:8px 18px; border-bottom:1px solid #262626; display:flex;
            gap:10px; align-items:center; }
  .wallet button { padding:5px 12px; font-size:12px; }
  .owner { padding:10px 18px; display:flex; gap:16px; flex-wrap:wrap;
           align-items:center; border-bottom:1px solid #262626; }
  .owner .label { color:#666; font-size:12px; text-transform:uppercase;
                  letter-spacing:.08em; }
  .owner .grp { display:flex; gap:6px; align-items:center; color:#888; }
  .owner input, .owner select { background:#1a1a1a; border:1px solid #333; color:#eee;
                                padding:4px 6px; border-radius:4px; font:inherit;
                                font-size:12px; }
  .owner input { width:5.5em; }
  /* Event sources are styled apart on purpose: a model's words are advisory, our own
     progress is unconfirmed, and a chain-read fact is authoritative. */
  .ev { font-size:12px; padding:2px 0; border-left:2px solid #333; padding-left:8px; }
  .ev.model { border-color:#7a6a2a; color:#c9b26a; }
  .ev.pipeline { border-color:#3a4a5a; color:#8fa8c0; }
  .ev.chain { border-color:#2a5a3a; color:#8fd0a0; }
  .ev.terminal { font-weight:600; }
  .owner button { padding:4px 10px; font-size:12px; }
  .hire { border:1px solid #2a2a2a; border-radius:6px; padding:6px 10px;
          display:flex; gap:10px; align-items:center; }
  .hire.off { opacity:.6; border-color:#5c2a2a; }
  .hire button { padding:4px 10px; font-size:12px; }
</style>
<body data-token="__TOKEN__">
<header>
  <h1>on-device agent wallet</h1>
  <div class="sub">model extracts &rarr; this code computes &rarr; the gate decides &rarr; the chain enforces</div>
</header>

<div class="wallet" id="wallet"><span class="k">wallet: not connected</span></div>

<div class="ask">
  <input id="q" type="text" placeholder="swap 0.05 SUI into USDC" autocomplete="off">
  <button id="ask">Ask</button>
  <button id="run" class="ghost" disabled>Run on-chain</button>
</div>

<div class="owner" id="owner">
  <span class="label">owner actions</span>
  <span class="grp">fund vault <input id="topupAmt" type="text" value="0.05"> SUI
    <button class="ghost" id="topup">Fund</button></span>
  <span class="grp">budget <select id="budHire"></select>
    <input id="budAmt" type="text" value="0.03"> SUI
    <button class="ghost" id="setBud">Set</button></span>
  <span class="grp">swap pool <select id="poolHire"></select>
    <button class="ghost" id="poolAllow">Allow</button>
    <button class="ghost" id="poolBlock">Block</button></span>
  <span class="grp">agent <input id="agentAddr" type="text" placeholder="0x…" size="10">
    bound <input id="agentBps" type="text" value="5"> bps
    <button class="ghost" id="handOver">Hand over</button></span>
  <span class="grp"><button class="ghost" id="withdraw">Withdraw all</button></span>
  <div class="legend">each of these asks the wallet to sign — nothing is signed by this page.
    The hire selector above applies to both <b>swap pool</b> and <b>hand over</b>.
    <b>swap pool</b> is the Cetus pool a hire may trade on: it edits the policy's allowlist, and a
    new hire starts with none allowed. It does not stop the agent — use <b>Suspend</b> on the hire
    below for that. <b>hand over</b> moves the grant to a different address and sets how far a swap
    may move the price; the old agent loses every agent path, and the owner keeps every admin path.</div>
  <div class="msg" id="ownerMsg"></div>
</div>

<div class="owner" id="position">
  <span class="label">position</span>
  <span class="grp"><button class="ghost" id="posOpen">Open guarded position</button></span>
  <span class="grp">fund <input id="depUsdc" type="text" value="0.5"> USDC
    <input id="depSui" type="text" value="0.6"> SUI headroom
    <button class="ghost" id="depBtn">Fund</button></span>
  <span class="grp">range <input id="rebLo" type="text" value="68800"> ->
    <input id="rebHi" type="text" value="69200">
    <button class="ghost" id="rebBtn">Rebalance</button></span>
  <span class="grp"><button class="ghost" id="redBtn">Exit</button></span>
  <div class="legend">in order: open, fund, move the range. Exit closes the position for good and
    leaves the guard holding a position that no longer exists, so open again before moving or exiting
    once more. Rebalance is the <b>guard's</b> agent — a different agent from the policy's, and
    currently your own address, which is why it still passes here. Swaps answer to the policy's
    agent instead: whoever <b>hand over</b> names.</div>
</div>

<div class="owner" id="escrow">
  <span class="label">escrow swap</span>
  <span class="grp">escrow <input id="ordAmt" type="text" value="0.01"> SUI
    floor <input id="ordMin" type="text" value="0.005"> USDC
    fee <input id="ordFee" type="text" value="0.01"> USDC
    <button class="ghost" id="ordMake">Create order</button></span>
  <span class="grp">burn settled <input id="ordId" type="text" placeholder="0x…" size="10">
    <button class="ghost" id="ordBurn">Burn</button></span>
  <div class="legend">step 1 of the escrow flow, and the only step where money moves — the coin
    leaves your wallet here and sits inside the order until an agent fills it, or it expires and
    anyone may refund it to you. Your floor is enforced by the same function that moves the funds,
    so it cannot be undercut. An agent fills the order with <b>settle-order.js</b>; you reclaim its
    storage afterwards.</div>
</div>

<div class="hires" id="hires"><span class="label">hires</span></div>

<div class="wrap">
  <div class="pane">
    <h2>1 &middot; agent</h2>
    <div id="agent" class="k">waiting for a request…</div>
  </div>
  <div class="pane">
    <h2>2 &middot; gate</h2>
    <div id="gate" class="k">nothing to decide</div>
  </div>
  <div class="pane">
    <h2>3 &middot; chain</h2>
    <div id="chain" class="k">nothing submitted</div>
  </div>
</div>

<div class="stats" id="stats"></div>

<!-- The page's code lives in src/web/page.js, where the linter and node --check can see
     it. Embedding it here as inline text is what broke it twice: an escape in a regex
     and an escape in a string were both consumed before reaching the browser. The token
     rides on the body tag as a data attribute rather than a script tag, so nothing is
     injected into script context at all. -->
<script type="module" src="/wallet.js"></script>
<script type="module" src="/page.js"></script>`;

const server = http.createServer((req, res) => {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(body);
  };

  if (req.method === 'GET' && req.url === '/wallet.js') {
    // Served from memory, never a CDN: a local-first tool that fetches its wallet
    // code off the internet at page load has given back the property it was
    // selling. Contains no secrets, so it is not token-gated.
    if (!walletBundleJs) {
      return send(503, 'wallet bundle unavailable — server log has the build error',
        'text/plain; charset=utf-8');
    }
    return send(200, walletBundleJs, 'text/javascript; charset=utf-8');
  }

  // The page's own modules. Read on every request rather than cached at startup:
  // editing one and reloading the browser is the whole dev loop, and a
  // startup-cached copy would quietly serve something nobody wrote any more.
  //
  // Names are matched literally above, so the path handed to readFileSync is never
  // derived from the request and cannot be steered out of src/web/.
  const moduleRoutes = { '/page.js': 'page.js', '/markup.js': 'markup.js', '/units.js': 'units.js', '/events.js': 'events.js' };
  if (req.method === 'GET' && moduleRoutes[req.url]) {
    const name = moduleRoutes[req.url];
    try {
      return send(200, fs.readFileSync(`src/web/${name}`, 'utf8'),
        'text/javascript; charset=utf-8');
    } catch (e) {
      return send(500, `src/web/${name} unreadable: ${e.message}`, 'text/plain; charset=utf-8');
    }
  }

  if (req.method === 'GET' && (req.url === '/app.js' || req.url === '/app.css')) {
    // Not token-gated, for the same reason wallet.js is not: these contain no secrets,
    // and a page that cannot load its own script cannot ask for a token anyway.
    if (!appBundle) {
      return send(503, 'app bundle unavailable — server log has the build error',
        'text/plain; charset=utf-8');
    }
    return req.url === '/app.js'
      ? send(200, appBundle.js, 'text/javascript; charset=utf-8')
      : send(200, appBundle.css, 'text/css; charset=utf-8');
  }

  if (req.method === 'GET' && (req.url === '/app' || req.url === '/app/')) {
    return send(200, APP_PAGE.replace('__TOKEN__', TOKEN), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && req.url === '/') {
    // Token injected here rather than fetched, so the page itself never has to ask
    // for it. A cross-origin caller can reach the port but cannot read this.
    //
    // It rides on the body tag as a data attribute, not in a <script> block: the
    // value is hex today, but keeping it out of script context means the injection
    // cannot become script injection whatever the token's shape becomes.
    return send(200, PAGE.replace('__TOKEN__', TOKEN), 'text/html; charset=utf-8');
  }

  if (req.url?.startsWith('/api/')) {
    if (req.headers['x-agent-token'] !== TOKEN) {
      return send(403, JSON.stringify({ error: 'bad or missing token' }));
    }
  }

  if (req.method === 'GET' && req.url === '/api/state') {
    return state().then((s) => send(200, JSON.stringify(s))).catch((e) => send(500, JSON.stringify({ error: e.message })));
  }

  if (req.method === 'GET' && req.url === '/api/outstanding') {
    return outstandingOrders()
      .then((o) => send(200, JSON.stringify(o)))
      .catch((e) => send(500, JSON.stringify({ error: e.message })));
  }

  if (req.method === 'GET' && req.url === '/api/hires') {
    return hires().then((h) => send(200, JSON.stringify(h))).catch((e) => send(500, JSON.stringify({ error: e.message })));
  }

  if (req.method === 'POST' && (req.url === '/api/propose' || req.url === '/api/build')) {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return send(400, JSON.stringify({ error: 'bad body' }));
      }

      if (req.url === '/api/propose') {
        if (typeof body.text !== 'string' || !body.text.trim()) {
          return send(400, JSON.stringify({ error: 'text required' }));
        }
        const r = runAgent(body.text);
        // The events this step produced. `extracting` is MODEL-sourced because the
        // model's part is advisory; the verdict is PIPELINE, because the gate is our
        // own code. Neither is CHAIN — nothing has touched the chain yet.
        const doc = firstJson(r.stdout);
        const events = [
          event('extracting', 'model', 'the local model is reading the request'),
          doc && doc.decision === 'PROPOSED'
            ? event('proposed', 'pipeline', 'the gate allowed it')
            : event('refused', 'pipeline', endingFor('refused', {
              reason: (doc && doc.validation && doc.validation.reason)
                || (doc && doc.decision) || 'could not parse a proposal',
            })),
        ];
        return send(200, JSON.stringify({ ...r, decision: doc?.decision, events }));
      }

      // /api/build: returns bytes to sign, or a refusal with its reason.
      const kind = body.kind || 'swap';
      try {
        const out = build(kind, body);
        // A build either produced bytes or was refused. Both are events, and a refusal
        // is not a transport failure — it is the gate doing its job.
        const events = out.error || out.refused
          ? [event('refused', 'pipeline', endingFor('refused', {
            reason: (out.refused && out.refused.validation && out.refused.validation.reason)
              || out.refused || out.error,
          }))]
          : [event('building', 'pipeline', 'the transaction is built and simulated')];
        return send(out.error ? 400 : 200, JSON.stringify({ ...out, events }));
      } catch (e) {
        return send(500, JSON.stringify({ error: String(e?.message || e) }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/fill') {
    // Tell the MCP server about an order the browser just created. The browser cannot
    // know the order id — it is generated on chain — so the digest comes here and the
    // id is read from its effects.
    //
    // Everything returns 200 with a reason rather than an error code: "nobody filled
    // it" is a normal outcome for a one-minute order, not a transport failure, and the
    // UI should be able to say so plainly.
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let digest;
      try {
        ({ digest } = JSON.parse(raw || '{}'));
      } catch {
        return send(400, JSON.stringify({ error: 'bad body' }));
      }
      if (!digest) return send(400, JSON.stringify({ error: 'digest required' }));

      const orderId = findCreatedOrder(digest);
      if (!orderId) {
        return send(200, JSON.stringify({
          filled: false,
          why: 'no order in that transaction',
          events: [event('refused', 'pipeline', endingFor('refused', { reason: 'no order in that transaction' }))],
        }));
      }

      const url = `http://${MCP_HOST}:${MCP_PORT}/fill`;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId }),
        });
        const out = await r.json();
        // `filled` is CHAIN-sourced: it comes from a settlement that either landed or
        // did not. `expired` is likewise a fact about the order rather than a failure
        // of ours, and it is worded as the routine outcome it is.
        const events = out.filled
          ? [event('filling', 'pipeline', 'a filler took it'),
             event('filled', 'chain', endingFor('filled', { received: out.received ?? 'the output' }))]
          : [event('notified', 'pipeline', 'the filler was told'),
             event('expired', 'chain', endingFor('expired'))];
        return send(200, JSON.stringify({ orderId, ...out, events }));
      } catch (e) {
        return send(200, JSON.stringify({
          orderId,
          filled: false,
          why: `mcp server unreachable at ${url}: ${e.message}`,
          events: [event('notified', 'pipeline', 'the filler could not be reached')],
        }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/submit') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
    req.on('end', () => {
      let id, signature;
      try {
        ({ id, signature } = JSON.parse(raw || '{}'));
      } catch {
        return send(400, JSON.stringify({ error: 'bad body' }));
      }
      if (!id || !signature) return send(400, JSON.stringify({ error: 'id and signature required' }));
      const out = submit(id, signature);
      send(out.error ? 400 : 200, JSON.stringify(out));
    });
    return;
  }

  send(404, JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, HOST, () => {
  console.error(`ui on http://${HOST}:${PORT}  (loopback only)`);
  console.error(`token: ${TOKEN}`);
  console.error('the page carries the token itself; this line is for curl and debugging');
  console.error('signing is done by the wallet extension — this process holds no key');
});

// Build once at start so /wallet.js can never be stale.
const walletBundleJs = buildWalletBundle();
const appBundle = buildAppBundle();
console.error(walletBundleJs
  ? `wallet bundle ready (${(walletBundleJs.length / 1024).toFixed(0)} KB, served from memory)`
  : 'wallet bundle FAILED — the page will show a connect error');
