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
// One reader of the allowance ledger. It lives in agent.ts because the GATE needs it too —
// checking it only on chain means the refusal arrives as a MoveAbort with no numbers in it.
import { allowanceMist } from './agent.js';
import { VAULT_ID, DEPLOYER, USDC_TYPE, REWARD_TYPE, PACKAGE_LATEST_ID, POOL_TICK_SPACING, GUARD_ID, GUARD_SHARED_VERSION, SLIPPAGE_BPS, COINS, DIRECTIONS, type Direction } from './addresses.js';
import { HIRES } from './hires.js';
import { MARKETPLACE, describeTalents, serverForAction, talentFor } from './talents.js';
import { findCreatedGuard, repointAddresses } from './guard-id.js';
import { event, endingFor, type EventKind } from './web/events.js';
import {
  listChats, createChat, getChat, renameChat, deleteChat, messages, append,
  listTalents, installTalent, uninstallTalent, dbPath,
} from './db.js';
import { fromUnits } from './web/units.js';

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
    // The font faces come out of the package referencing ./files/*.woff2, relative to the
    // stylesheet. Nothing serves that path, so the font would silently never load — a failure
    // that looks like "the font just didn't apply" rather than like a 404. Rewritten to a route
    // the server actually answers.
    const css = fs.readFileSync(cssPath, 'utf-8').replace(/\.\/files\//g, '/fonts/');
    const built = { js: fs.readFileSync(jsPath, 'utf-8'), css };
    fs.unlinkSync(jsPath);
    fs.unlinkSync(cssPath);
    return built;
  } catch (e) {
    console.error('app output unreadable:', errText(e));
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
<title>suidobashi</title>
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
 * src/web/wallet-entry.ts. Written to a temp path outside the project so it is
 * never mistaken for source, then removed.
 */
function buildWalletBundle() {
  const out = path.join(os.tmpdir(), `agent-wallet-bundle-${process.pid}.js`);
  const r = spawnSync(
    'bun',
    ['build', 'src/web/wallet-entry.ts', '--outfile', out, '--format=esm', '--target=browser'],
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
    console.error('wallet bundle unreadable:', errText(e));
    return null;
  }
}

/** Run the CLI with an argv array and no shell, so text cannot be interpolated. */
/**
 * @param {string} text
 * @param {string[]} [extra]
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
function runAgent(text: string, extra: string[] = []): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(RUNTIME, ['src/agent.js', text, ...extra], {
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


  /**
   * One row of the hires list.
   *
   * Declared in full rather than inline, because the object gains most of its fields AFTER its
   * literal — and in a .ts file a JSDoc @type on the literal does not carry, so the compiler
   * sees only the initial shape and every later assignment is an error.
   *
   * The chain-filled fields are optional on purpose: a failed read leaves a row with only its
   * registry fields and an `error`, and that is a state the UI genuinely renders.
   */
  type HireRow = {
    name: string;
    policyId: string;
    budgetSui: string;
    /**
     * The budget read from the OZ ledger, in mist. NULL when the read failed — and null is not
     * zero, because a failed read must not look like a budget of nothing.
     *
     * This is `remaining`, not the granted amount: the contract stores only `remaining` and
     * `expires_at_ms`, so the original grant is not recoverable. After a spend this is lower than
     * what was set, which is the honest reading — and `set_allowance` resets it.
     */
    budgetMist?: string | null;
    /**
     * The USDC ceiling, read from the same ledger as a DIFFERENT ROW — `set_allowance` is keyed by
     * (cap_id, coin_type), so the SUI figure never answers "what is the USDC ceiling". Read because
     * the sheet OFFERS a USDC field: a panel that can set a value it cannot read back leaves the
     * owner unable to see the grant they just signed, which is exactly how this was noticed.
     */
    budgetUsdc?: string | null;
    /** The registry's figure: the ORIGINAL grant, which drifts the moment anyone changes the
     *  budget. Kept only so the UI can say where a number came from when the read fails. */
    budgetLocalSui: string;
    feeBps: number;
    venueId: string;
    agent?: string;
    suspended?: boolean;
    venues?: number;
    /**
     * The allowed pools themselves, not just how many. The settings panel has to show what is
     * currently open or it cannot show what a save would change — and a count cannot tell one
     * venue from another, which is the whole content of the field.
     */
    venueIds?: string[];
    ownVenueOpen?: boolean;
    destination?: string;
    error?: string;
  };

  const out: HireRow[] = [];
  for (const [name, h] of Object.entries(HIRES)) {
      const row: HireRow = { name, policyId: h.policyId, budgetSui: h.budgetSui,
                    budgetLocalSui: h.budgetSui,
                    feeBps: h.venue.feeBps, venueId: h.venue.id };
    try {
      const o = await client.getObject({ objectId: h.policyId, include: { json: true } });
      // `any` deliberately: this is a Move struct's JSON as the chain returns it, and the shape
      // belongs to the chain rather than to us. Declaring fields here would be a second copy of
      // that contract, which is the drift this project keeps finding.
      const j: any = (o.object ?? o).json ?? {};
      row.agent = j.agent;
      row.suspended = Boolean(j.suspended);
      const list: string[] = (j.allowed_pools?.contents ?? []).map((x: unknown) => String(x).toLowerCase());
      row.venueIds = list;
      row.venues = list.length;
      // The budget, from the LEDGER rather than from hires.ts. Read after the policy object so a
      // failure here leaves the registry figure visible beside the error rather than blank.
      const mist = await allowanceMist(h.capId);
      row.budgetMist = mist === null ? null : mist.toString();
      if (mist !== null) row.budgetSui = (Number(mist) / 1e9).toString();
      // The USDC row, so the USDC field in the sheet has a baseline to diff against. `fromUnits`
      // rather than a division: the project has one formatter for money and it is exact.
      const usdcMist = await allowanceMist(h.capId, USDC_TYPE);
      row.budgetUsdc = usdcMist === null ? null : fromUnits(BigInt(usdcMist), 6);
      // Whether this hire's OWN venue is open, read from the chain. A count alone
      // hides the difference between two hires on two different pools.
      row.ownVenueOpen = list.includes(String(h.venue.id).toLowerCase());
      row.destination = j.destination;
    } catch (e) {
      row.error = String(errText(e)).slice(0, 120);
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
/**
 * The first JSON document in a script's stdout, or null.
 *
 * Some scripts print two: the proposal and then a summary. Shrinking from the end rather
 * than parsing greedily is what makes the FIRST one win, which is the one callers want.
 *
 * @param {string} stdout
 * @returns {any}
 */
function firstJson(stdout: string): any {
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
/**
 * The OUTPUT a live quote expects, in the output coin's smallest unit — or null.
 *
 * RETURNS THE QUOTE, NOT A FLOOR, and that split is the fix for a knife edge. This function used to
 * take the fee and return `quote - slippage - fee`, which made the DEFAULT FEE part of the
 * arithmetic that decides whether an order can be built at all. On a 0.01 SUI trade the flat 0.01
 * USDC default was 84% of the output, so building the order came down to whether the SUI price had
 * drifted ~16% since the default was written. A flat fee is not a bound, it is a coincidence.
 *
 * The floor is derived by the CALLER, which is the only place that knows the fee.
 */
function quoteOut(amountIn: bigint, direction: Direction): bigint | null {
  const r = spawnSync(RUNTIME, ['src/advisor.js', String(amountIn), direction], {
    encoding: 'utf-8', timeout: 60_000,
  });
  const doc = firstJson(r.stdout);
  if (!doc || !doc.admissible) return null;
  const out = BigInt(doc.quoteAmountOut ?? 0);
  return out > 0n ? out : null;
}

/**
 * The runtime every script is run with.
 *
 * ONE PLACE, so a file can convert to TypeScript on its own. bun runs both .js and .ts, which
 * is what makes the migration incremental — the alternative was converting thirty files at once
 * or keeping a runtime prefix in every script string, where a single missed one would fail at
 * the moment a user clicked something.
 *
 * Overridable so the server can be run under node again while something is being debugged.
 */
const RUNTIME = process.env.SUI_RUNTIME || 'bun';

/**
 * Requests the APP answers itself, without the model.
 *
 * Deliberately broad and deliberately a regex: a false positive answers a question the user
 * probably asked, and a false negative refuses as before. Neither can cause an action.
 */
const CAPABILITY_QUESTION = /\b(what|which|list|show)\b[^?]{0,40}\b(skill|skills|talent|talents|can you do|are you able|tools|actions)\b/i;

/**
 * The request body, as the routes pass it to the dispatcher.
 *
 * NAMED FIELDS rather than `any` or `unknown`, and both alternatives were tried:
 *
 *   Record<string, any>      compiles, and gives every caller no contract at all
 *   Record<string, unknown>  honest, and breaks every read — `body.hire` becomes `{}` and the
 *                            code that passes it where a string is expected stops compiling
 *
 * Every field is optional because each action reads a different subset, and the dispatcher
 * refuses what it needs rather than trusting the caller. The string fields are strings because
 * that is what a form and JSON both produce — they are parsed by `toMist`, which takes unknown
 * precisely so a malformed value becomes null rather than a wrong number.
 */
type ActionBody = {
  kind?: string;
  text?: string;
  hire?: string;
  agent?: string;
  venue?: string;
  orderId?: string;
  /**
   * The amount being escrowed or swapped, in the INPUT coin's SMALLEST UNIT.
   *
   * `amountMist` is the OLD name, and it is still what the `topup` and `budget` routes read — the
   * order path prefers `amountIn`. It means MIST and therefore only ever meant SUI, which is why a
   * caller escrowing USDC must use `amountIn`.
   */
  amountIn?: string;
  amountMist?: string;
  /**
   * Which way: a key of `DIRECTIONS` (`SUI->USDC`, `USDC->SUI`). Absent means SUI -> USDC, which is
   * what every caller predating a second direction means.
   */
  direction?: string;
  /** The floor and the fee, in the OUTPUT coin's smallest unit. `*Usdc` are the old names. */
  minOut?: string;
  minOutUsdc?: string;
  feeOut?: string;
  feeOutUsdc?: string;
  fixAmountUsdc?: string;
  supplySui?: string;
  boundBps?: string;
  /**
   * A form sends strings and JSON can carry anything, so the flags accept both rather than
   * claiming a type the request never guaranteed. `suspend` compares against 'true' for exactly
   * this reason — testing truthiness made "false" mean yes.
   */
  suspended?: boolean | string;
  allow?: boolean | string;
  /**
   * The policy panel's budget, in mist. Distinct from `amountMist`, which the order path uses
   * for the amount being swapped — this one is the ceiling.
   */
  budgetMist?: string;
  /** Which coin the budget is for — a key of `COINS`. Absent means SUI. */
  budgetCoin?: string;
  /**
   * Venue diffs, as id lists. NOT `allow`, which the `venue` kind already uses as the
   * allow-or-block flag for a single pool; overloading it would have made that kind's boolean
   * arrive as an array. `unknown` rather than `string[]` because a request can carry anything,
   * and the route filters rather than trusting the shape.
   */
  allowPools?: unknown;
  revokePools?: unknown;
  tickLower?: number;
  tickUpper?: number;
};

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
 *
 * @param {unknown} v
 * @returns {bigint | null}
 */
function toMist(v: unknown): bigint | null {
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
/**
 * Turn a request into a script to run, or into a refusal.
 *
 * THE CENTRAL DISPATCHER. Every action the server can build is a branch here, and each one
 * returns the same three things: a script, its environment, and a proposal describing what
 * is about to be signed. The proposal is what the signing pane shows BEFORE the wallet is
 * asked, so it is a user-facing contract and not a debug aid.
 *
 * @param {string} kind
 * @param {Record<string, any>} body
 * @returns {{ script?: string, env?: Record<string, string>, proposal?: Record<string, unknown>, error?: string, refused?: unknown }}
 */
function actionFor(kind: string, body: ActionBody): {
  script?: string;
  env?: Record<string, string>;
  proposal?: Record<string, unknown>;
  error?: string;
  refused?: unknown;
} {
  if (kind === 'swap') {
    const doc = firstJson(runAgent(body.text || '').stdout);
    if (!doc) return { error: 'could not parse a proposal from the agent' };
    if (doc.decision !== 'PROPOSED') {
      return { refused: (doc.validation && doc.validation.reason) || doc.decision };
    }
    // A DIRECTION WITH NO VAULT PATH. The plan carries no command for USDC -> SUI, because
    // `swap_and_route` escrows nothing and knows one direction only — and running a script that
    // cannot do what was asked is worse than refusing. The escrow is how that direction trades,
    // and it is built by the `order` path below.
    if (!doc.plan.command) {
      return {
        refused: `${doc.plan.env?.SWAP_DIRECTION ?? 'that direction'} has no vault path — `
          + 'the escrow is the only way to trade it',
      };
    }
    return { script: doc.plan.command, env: doc.plan.env, proposal: doc };
  }
  if (kind === 'suspend') {
    if (!body.hire || !(body.hire in HIRES)) return { error: 'unknown hire' };
    return {
      script: 'src/set-suspended.ts',
      // COMPARED, NOT TESTED FOR TRUTHINESS. `body.suspended ? …` looked harmless and was
      // not: a form sends strings, so "false" is truthy and the hire would be suspended by
      // a request to resume it. A checkbox is the only caller that could ever have been
      // right, and nothing was checking that it was one.
      env: {
        HIRE: body.hire,
        SUSPEND: (body.suspended === true || body.suspended === 'true') ? 'true' : 'false',
      },
      proposal: { action: body.suspended ? 'suspend' : 'resume', hire: body.hire },
    };
  }
  if (kind === 'topup') {
    const mist = toMist(body.amountMist);
    if (mist === null || mist <= 0n) return { error: 'amountMist must be a positive integer' };
    return {
      script: 'src/topup-vault.ts',
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
      script: 'src/set-budget.ts',
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
    const venue = body.venue || HIRES[body.hire as keyof typeof HIRES].venue.id;
    // THE SAME BUG AS `suspend`, found by fixing that one. `body.allow !== false` reads as a
    // sensible default and means a form's "false" — which is not the boolean false — allows the
    // pool. Compared explicitly, so the only things that block are the things meant to.
    const allow = !(body.allow === false || body.allow === 'false');
    return {
      script: 'src/hire-agent.ts --allowlist',
      env: { HIRE: body.hire, VENUE: venue, ALLOW: allow ? 'true' : 'false' },
      proposal: {
        action: allow ? 'allow swap pool' : 'block swap pool',
        hire: body.hire,
        venue,
      },
    };
  }
  if (kind === 'policy') {
    if (!body.hire || !(body.hire in HIRES)) return { error: 'unknown hire' };

    // ONLY WHAT CHANGED. Every field is individually optional and an absent one produces no
    // instruction at all — which is what makes this a patch rather than an overwrite. It
    // matters most for the budget: `set_allowance` upserts the ledger entry in place,
    // including resetting the spend tracking, so sending it on every save would quietly
    // restore an exhausted hire's ceiling every time the owner changed a venue.
    const env: Record<string, string> = { HIRE: body.hire };
    const steps: string[] = [];

    if (typeof body.agent === 'string' && body.agent) {
      env.AGENT = body.agent;
      steps.push('agent');
    }
    // The bound travels with the agent in the same transaction, because a grant handed over
    // without a price bound — even for one instruction — is the case the bound exists for.
    if (body.boundBps !== undefined && body.boundBps !== null && body.boundBps !== '') {
      env.BOUND_BPS = String(body.boundBps);
      steps.push('bound');
    }
    // COMPARED, NOT TESTED FOR TRUTHINESS — the bug `suspend` and `venue` both had. A form
    // sends strings, so "false" is truthy and a request to resume would suspend. Here the
    // check is `typeof … === 'boolean'`, which is stricter still: a string is not a decision
    // to change anything, so it produces no instruction rather than a wrong one.
    if (typeof body.suspended === 'boolean') {
      env.SUSPENDED = body.suspended ? 'true' : 'false';
      steps.push(body.suspended ? 'suspend' : 'resume');
    }
    // The budget is a row of the OZ ledger, keyed by (cap_id, coin_type), so WHICH COIN is part of
    // the instruction — the same digits are 0.01 SUI and 10 USDC. Absent means SUI, which is what
    // every caller meant before a second coin existed; an unknown symbol is refused rather than
    // granted against the wrong row.
    let budgetCoin: string | null = null;
    if (body.budgetMist !== undefined && body.budgetMist !== null && body.budgetMist !== '') {
      const symbol = String(body.budgetCoin ?? 'SUI').toUpperCase();
      if (!COINS[symbol]) {
        return { error: `budgetCoin must be one of ${Object.keys(COINS).join(', ')}` };
      }
      budgetCoin = symbol;
      const mist = toMist(body.budgetMist);
      if (mist === null) return { error: 'budgetMist must be a non-negative integer' };
      env.BUDGET_COIN = symbol;
      env.BUDGET_MIST = String(mist);
      steps.push(`budget (${symbol})`);
    }

    // Venues are a SET on chain, so the panel sends a diff rather than a list: it knows what
    // it changed, and nothing has to read the policy back to work out the difference.
    const venueIds = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
    const allow = venueIds(body.allowPools);
    const revoke = venueIds(body.revokePools);
    if (allow.length) {
      env.ALLOW = allow.join(',');
      steps.push(`allow ${allow.length}`);
    }
    if (revoke.length) {
      env.REVOKE = revoke.join(',');
      steps.push(`revoke ${revoke.length}`);
    }

    // Setting nothing would build a valid transaction that costs gas and changes nothing, and
    // would read as success. The script refuses it too; refusing here names the field.
    if (!steps.length) return { error: 'nothing to change' };

    return {
      script: 'src/set-policy.ts',
      env,
      proposal: {
        action: 'set policy',
        hire: body.hire,
        steps,
        // The value CARRIES its unit and its coin is named, rather than being divided by 1e9 in the
        // one place that knew nothing about coins — which printed a USDC budget as though it were
        // SUI (10 USDC came out as "0.00000001"). Same fix the order terms needed.
        budget: budgetCoin && env.BUDGET_MIST
          ? `${fromUnits(BigInt(env.BUDGET_MIST), COINS[budgetCoin].decimals)} ${budgetCoin}`
          : undefined,
        agent: env.AGENT,
        suspended: typeof body.suspended === 'boolean' ? body.suspended : undefined,
        allow,
        revoke,
      },
    };
  }
  if (kind === 'position') {
    // Provisioning: mints a new guard around a fresh Cetus position. The guard id
    // is not predictable here — object::new runs on the validator — so it has to be
    // read back from the transaction afterwards. See NOTES on the position cycle.
    return {
      script: 'src/create-position.ts',
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
      script: 'src/deposit-liquidity.ts',
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
      script: 'src/rebalance.ts',
      env: {
        NEW_TICK_LOWER: String(lo), NEW_TICK_UPPER: String(hi),
        GUARD_ID: activeGuard.id, GUARD_SHARED_VERSION: String(activeGuard.version),
      },
      proposal: { action: 'rebalance into a new range', tickLower: lo, tickUpper: hi, width },
    };
  }
  if (kind === 'redeem') {
    return {
      script: 'src/redeem.ts',
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
      script: 'src/withdraw-vault.ts',
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
      script: 'src/hire-agent.ts --repoint',
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
    let amount = toMist(body.amountIn ?? body.amountMist);
    // WHICH WAY, read from the same place the amount is: the agent's own extraction. The model is
    // never the thing that decides a direction — the gate has already refused anything outside the
    // table before this runs.
    let direction = typeof body.direction === 'string' && body.direction ? body.direction : null;
    // Set when the GATE refused the request, so that refusal is what the user hears.
    let gateRefusal: string | null = null;
    if ((amount === null || direction === null) && typeof body.text === 'string') {
      const doc = firstJson(runAgent(body.text).stdout);
      if (doc && doc.decision === 'PROPOSED') {
        if (amount === null) {
          amount = toMist(doc.plan?.env?.SWAP_AMOUNT_IN ?? doc.plan?.env?.SWAP_MIST);
        }
        if (!direction) direction = doc.plan?.env?.SWAP_DIRECTION ?? null;
      } else if (doc) {
        // The gate already turned this down, and it had a reason. Reporting a UNIT problem instead
        // — "an amount in SUI is required" for a request that asked in USDC and was refused for
        // having no USDC grant — sends the user to look in the wrong place entirely.
        gateRefusal = (doc.validation && doc.validation.reason)
          || doc.decision || 'the gate refused that request';
      }
    }
    // DEFAULTS TO SUI -> USDC. Not a fallback for a mistake: `direction` is optional, and a caller
    // that omits it is asking in the only direction there was before a second one existed.
    // Refusing it would break a working API to add a field.
    if (!direction) direction = 'SUI->USDC';
    const dir = DIRECTIONS[direction as Direction];
    if (!dir) {
      return { error: `direction must be one of ${Object.keys(DIRECTIONS).join(', ')}` };
    }
    if (gateRefusal) return { refused: gateRefusal };
    if (amount === null || amount <= 0n) {
      // NAMES THE UNIT, and that matters now: `amountMist` was 0.01 SUI and would be 0.01 USDC in
      // the other direction, so a message saying MIST for both is a unit error in prose.
      return {
        error: `an amount in ${dir.in.symbol} is required — body.amountIn, or text the agent can `
          + 'read one from',
      };
    }

    // The fee is the maker's offer to whoever fills, and it defaults to the FILLER'S OWN
    // FLOOR — MCP_MIN_FEE_OUT, 0.01 USDC. A default of zero looked reasonable and was
    // not: the reference server refuses an order below its floor, so every chat-typed
    // order would have been built, escrowed, and then quietly ignored until it expired.
    // Escrowing money nobody will take is a worse outcome than a slightly higher fee.
    //
    // The form always sends a fee (an empty field is refused, not defaulted), so this
    // only ever applies to an order the agent read from text.
    // `toMist` returns null for an unparseable value, and this did not check it — so a fee that
    // was present but not a number became `String(null)`, which is the four characters "null",
    // and that is what would have been sent as ORDER_FEE_OUT. The form refuses an empty field,
    // so this needed a malformed one rather than an absent one to fire.
    // `feeOutUsdc` / `minOutUsdc` are the OLD names, from when one direction existed. They are read
    // ONLY for a USDC-output order, because in the other direction those digits are MIST — and
    // reading them as USDC would accept a floor a thousand times too low, quietly: a maker asking
    // for 5 SUI would be agreeing to 0.005.
    const outIsUsdc = dir.out.symbol === 'USDC';
    const feeField = body.feeOut ?? (outIsUsdc ? body.feeOutUsdc : null);
    const minField = body.minOut ?? (outIsUsdc ? body.minOutUsdc : null);
    // `amount` is a `let` this branch reassigns, and TypeScript will not carry the null-check past
    // that reassignment, so it is bound to a const before anything reads it.
    const escrow = amount;

    // THE QUOTE FIRST, because the floor and the fee are both compared against it.
    //
    // It used to be the other way round: the fee was passed INTO the quote helper, which returned
    // `quote - slippage - fee`, so a default that knew nothing about the trade sat inside the
    // arithmetic deciding whether the trade could exist. Splitting them is what lets the refusals
    // below name a figure and an action instead of listing three possible causes.
    const quote = minField == null ? quoteOut(escrow, direction as Direction) : null;

    // THE DEFAULT IS THE FILLER's FLOOR — `MCP_MIN_FEE_OUT`, 0.01 of the output coin — because that
    // is an ABSOLUTE COST, not a share of the trade. A fee below it is refused by the reference
    // filler, so the order would escrow money nobody takes, which this file already calls worse than
    // refusing at build time. (Ten basis points of the quote was tried here and was wrong for
    // exactly that reason: it built 0.01 SUI orders carrying a 0.000012 USDC fee, which no filler
    // accepts.)
    //
    // It follows that a MINIMUM TRADE SIZE exists, and that is not a bug to engineer away — the
    // output has to cover the filler's floor plus something for the maker. The refusal below says so
    // and names the input that would work.
    const defaultFee = 10n ** BigInt(dir.out.decimals) / 100n;   // 0.01 of the output coin
    const feeRaw = feeField != null ? toMist(feeField) : defaultFee;
    if (feeRaw === null) {
      return { error: `the fee must be an integer in ${dir.out.symbol}'s smallest unit` };
    }
    const feeOut = feeRaw;

    // The floor. Typed by the caller, or derived: the quote less the maker's slippage tolerance,
    // less the fee — settlement asserts `output - fee >= min_out`, so `min_out` is what the maker
    // RECEIVES and the fee sits on top of it.
    const minOut = minField != null
      ? toMist(minField)
      : quote != null
        ? (quote * (10_000n - SLIPPAGE_BPS)) / 10_000n - feeOut
        : null;

    if (minOut === null || minOut <= 0n) {
      // THE REASONS ARE SPLIT, because they call for different actions: no quote is a transient
      // market-data problem, while a fee that eats the room is a number to change. The old message
      // listed three causes for every failure and named no figure, which is how a knife-edge fee
      // came to read as an aggregator outage.
      return {
        error: quote == null
          ? `no live ${dir.in.symbol} -> ${dir.out.symbol} quote is available right now, and an `
            + 'order must name its floor at creation — try again in a moment, or pass an explicit floor'
          : `the fee (${fromUnits(feeOut, dir.out.decimals)} ${dir.out.symbol}) leaves no room at `
            + `this size: ${fromUnits(escrow, dir.in.decimals)} ${dir.in.symbol} quotes `
            + `${fromUnits(quote, dir.out.decimals)} ${dir.out.symbol} — escrow more, or name a `
            + 'smaller fee',
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
      // THE IMPLIED MINIMUM INPUT, derived rather than hardcoded: the output has to reach roughly
      // twice the fee for the maker to keep as much as the filler takes. Computed from the live
      // quote, because a constant threshold would be wrong by the afternoon.
      const need = quote != null && quote > 0n
        ? (escrow * feeOut * 2n) / quote
        : null;
      return {
        error: `the fee (${fromUnits(feeOut, dir.out.decimals)} ${dir.out.symbol}) is larger than `
          + `what you would receive (${fromUnits(minOut, dir.out.decimals)} ${dir.out.symbol}) — `
          + (need != null
            ? `too small a trade for the filler's minimum fee: escrow at least `
              + `${fromUnits(need, dir.in.decimals)} ${dir.in.symbol}, or offer a smaller fee`
            : `escrow more ${dir.in.symbol}, or offer a smaller fee`),
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
    // TEN WHOLE UNITS OF THE INPUT COIN, whatever it is. The old cap was 10 SUI in MIST, which would
    // have let 10,000,000 USDC through the moment a second direction existed — a guard that stopped
    // guarding without anything failing.
    if (amount > 10n * 10n ** BigInt(dir.in.decimals)) {
      return { error: `escrow above 10 ${dir.in.symbol} is not allowed here` };
    }

    return {
      script: 'src/create-order.ts',
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
        // ORDER_AMOUNT_IN, not ORDER_AMOUNT_MIST: the unit is the INPUT coin's, and the script
        // refuses the old MIST name for a non-SUI input rather than reinterpreting it.
        ORDER_DIRECTION: direction,
        ORDER_AMOUNT_IN: String(amount),
        ORDER_MIN_OUT: String(minOut),
        ORDER_FEE_OUT: String(feeOut),
      },
      // THE TERMS, and they now carry their own units. `escrowSui` and `minOutUsdc` named the coin
      // in the KEY, which cannot survive a second direction; the pane renders these as they are.
      proposal: {
        action: 'escrow a swap order',
        direction: `${dir.in.symbol} -> ${dir.out.symbol}`,
        escrow: `${fromUnits(amount, dir.in.decimals)} ${dir.in.symbol}`,
        minOut: `${fromUnits(minOut, dir.out.decimals)} ${dir.out.symbol}`,
        feeOut: `${fromUnits(feeOut, dir.out.decimals)} ${dir.out.symbol}`,
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
      script: 'src/refund-order.ts',
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
      script: 'src/burn-order.ts',
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
 *
 * @param {string} digest
 */
function adoptGuardFrom(digest: string) {
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
  // `in` rather than a truthiness test. The success shape has no `error` property at all, so
  // reading it is an error on the union — and narrowing on `in` is what tells the compiler
  // which branch it is looking at.
  if ('error' in found) return found;
  const { id, version } = found;

  activeGuard = { id, version }; // in memory first: the transaction already happened

  const file = 'src/addresses.js';
  let before;
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { id, version, persisted: false, note: `adopted in memory; could not read ${file}: ${errText(e)}` };
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
    return { id, version, persisted: false, note: `adopted in memory; could not write ${file}: ${errText(e)}` };
  }
}

/**
 * Turn a raw chain abort into something an operator can act on.
 *
 * The dry run refusing a doomed transaction is correct — but a Move abort code is
 * not an explanation, and "borrow_child_object" tells a person nothing about what
 * to do next. These are the aborts this project actually keeps hitting.
 *
 * @param {unknown} message
 * @returns {string}
 */
function explainAbort(message: unknown): string {
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

  // ORDER MATTERS, AND THE OBVIOUS SPELLING IS SILENTLY IGNORED.
  //
  // `order: 'descending'` returns the newest transactions first. `descending: true` — the
  // name that reads as correct — is accepted, does not error, and returns the OLDEST. That
  // is how this shipped broken: the scan dutifully read fifteen ancient transactions and
  // never reached anything recent, so an order created a minute earlier was invisible while
  // the call looked perfectly healthy.
  //
  // This is the THIRD silently-ignored option in this project, after listEvents' filters and
  // the aggregator's provider string. The pattern is consistent enough to state: an option is
  // not verified by the call succeeding. It is verified by checking that the OUTPUT changed
  // in the direction asked for.
  const list = await client.listTransactions({
    filter: { sender: maker },
    limit: SCAN,
    order: 'descending',
  });
  // `Transaction` and `FailedTransaction` are different shapes and only the first has a digest.
  // This is a documented trap in NOTES — the earlier code read the success shape alone and
  // reported digest: null for precisely the failures the --no-simulate mode exists to produce.
  const digests = (list.transactions ?? [])
    .map((t: any) => t.Transaction?.digest ?? t.FailedTransaction?.digest)
    .filter(Boolean) as string[];

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
  const got = await client.getObjects({ objectIds: [...ids] as string[], include: { json: true } });
  const rows: any[] = (got as any).objects ?? [];

  const orders = [];
  let orderObjects = 0;
  for (const row of rows) {
    const o: any = row.object ?? row;
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
 *
 * @param {string} digest
 * @returns {string | null}
 */
function findCreatedOrder(digest: string): string | null {
  const r = spawnSync('sui', ['client', 'tx-block', digest, '--json'],
    { encoding: 'utf-8', timeout: 120_000 });
  let doc;
  try {
    doc = JSON.parse(r.stdout || '');
  } catch {
    return null;
  }
  const created = (doc.objectChanges || []).find((c: any) => c.type === 'created'
    && String(c.objectType || '').includes('::order::Order<'));
  return created?.objectId ?? null;
}

/**
 * The message from a caught value.
 *
 * `catch` binds `unknown`, because anything can be thrown — an Error, a string, a rejected
 * promise's reason. Reading `.message` off it is the mistake TypeScript is right to flag: an
 * Error has one and a thrown string does not, where the string IS the message.
 *
 * The previous code read `e.message` directly, which works for everything this project throws
 * and would print `undefined` for the one thing it does not.
 *
 * @param {unknown} e
 * @returns {string}
 */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : (JSON.stringify(e) ?? String(e));
}

/**
 * The ending for a TERMINAL kind, which always has wording.
 *
 * `endingFor` returns `string | null`, because a non-terminal kind has no ending — `filling`
 * is not an outcome. Every call site here passes a terminal kind, where it is always a string,
 * and the type cannot express that.
 *
 * A cast would silence the compiler and keep the real hazard: calling it with a kind that has
 * no wording would put `null` in an event's text, which the client renders as nothing at all.
 * This throws instead, which is the same rule the rest of this file follows — a mistake should
 * fail where it is made, not become a blank line in a browser.
 *
 * @param {import('./web/events.js').EventKind} kind
 * @param {Record<string, unknown>} [detail]
 * @returns {string}
 */
function ending(kind: EventKind, detail?: Record<string, unknown>): string {
  const text = endingFor(kind, detail);
  if (text === null) {
    throw new Error(`no ending wording for "${kind}" — it is not a terminal kind`);
  }
  return text;
}

/**
 * Build the transaction and hold the bytes. No key, no signature, no submission —
 * `tx.build({ client })` runs a resolution pass that simulates, so a doomed
 * transaction fails here rather than after the user has approved it.
 *
 * @param {string} kind
 * @param {Record<string, any>} body
 * @returns {{ id?: string, bytes?: string, proposal?: Record<string, unknown>, error?: string, refused?: unknown }}
 */
function build(kind: string, body: ActionBody): {
  id?: string;
  bytes?: string;
  proposal?: Record<string, unknown>;
  error?: string;
  refused?: unknown;
} {
  const a = actionFor(kind, body);
  if (a.error || a.refused) return a;
  // The script is optional on the dispatcher's return type — an error or a refusal is the other
  // shape. Checked rather than asserted, because a branch added without a script should refuse
  // here rather than fail on `undefined.split`.
  if (!a.script) return { error: `no script for "${kind}"` };

  // The script string names the FILE; the runtime is the constant above, so converting a file
  // to .ts is a one-word edit here rather than a hunt through thirteen strings.
  const args = a.script.split(/\s+/);
  const built = spawnSync(RUNTIME, [...args, '--emit-bytes'], {
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

  // THE OUTPUT MUST ACTUALLY BE BYTES, and this boundary is the only place that can tell.
  //
  // This used to trust stdout completely. refund-order.js documented `--emit-bytes` and never
  // implemented it, so it printed its dry-run JSON instead — which became "the bytes", was
  // handed to the wallet, and produced an internal error inside Slush that named neither the
  // script nor the flag. Five rounds of theories about the wallet, the sender and object
  // encodings, when the transaction had never been sent anywhere.
  //
  // base64 only. A JSON object, a stack trace, a warning line and an empty string all fail
  // this, and every one of them is better refused here than decoded by a wallet.
  if (bytes.length < 32 || !/^[A-Za-z0-9+/]+={0,2}$/.test(bytes)) {
    return {
      error: 'the build script did not produce transaction bytes — it printed '
        + `${bytes.slice(0, 100)}${bytes.length > 100 ? '…' : ''}. `
        + 'Every script the server runs must implement --emit-bytes.',
    };
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
 *
 * @param {string} id
 * @param {string} signature
 * @returns {{ digest?: string, status?: string, output?: string, guard?: unknown, error?: string }}
 */
function submit(id: string, signature: string): {
  digest?: string;
  status?: string;
  output?: string;
  guard?: unknown;
  error?: string;
} {
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
  const at = async (owner: string, coinType: string) => {
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


// A THROW IN A REQUEST HANDLER MUST NOT KILL THE SERVER.
//
// This server died exactly that way: a new route emitted an event kind that was not in the
// closed vocabulary, `event()` threw — correctly, a typo should fail loudly — and because the
// throw happened inside a request handler it took the whole process down. The browser saw
// only `ERR_CONNECTION_REFUSED`, which points at the network and says nothing about the cause.
//
// The closed vocabulary stays. What changes is that "fail loudly" now means a logged error
// and a served response, not a dead server: a typo should cost one request, not the session.
//
// Loud, not silent: both handlers name the error and its first frames, because a crash that
// leaves no trace is how this one hid.
const complain = (label: string, err: unknown) => {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(`\n!! ${label}: ${errText(e)}`);
  console.error((e.stack ?? '').split('\n').slice(1, 4).join('\n'));
  console.error('!! the server is still running; the request that caused this was not answered\n');
};
process.on('uncaughtException', (e) => complain('uncaught exception', e));
process.on('unhandledRejection', (e) => complain('unhandled rejection', e));

const server = http.createServer((req, res) => {
  // `string | Uint8Array`, because a font is bytes and `res.end` takes either. Narrowing this
  // to string made the /fonts/ route fail to compile the moment it was written — which is the
  // compiler doing its job on a helper that was only ever used with JSON before.
  const send = (code: number, body: string | Uint8Array, type = 'application/json') => {
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


  if (req.method === 'GET' && (req.url ?? '').startsWith('/fonts/')) {
    // Only ever a font file, named from a fixed set. `basename` is what keeps a crafted path
    // from walking out of the package directory.
    const name = path.basename((req.url ?? '').split('?')[0]);
    if (!/^[a-z0-9-]+\.woff2$/.test(name)) return send(404, 'not found', 'text/plain; charset=utf-8');
    // The theme's two families, and only these. Each package writes its faces to ./files/, which
    // the CSS build rewrites to /fonts/, so one flat namespace is enough: the package name is a
    // prefix of every file, which is what keeps the basename unique across the two directories.
    // Both are searched rather than one path being derived, so neither can be guessed at.
    const fontDirs = [
      'node_modules/@fontsource-variable/nunito/files',
      'node_modules/@fontsource/pt-serif/files',
    ];
    for (const dir of fontDirs) {
      try {
        // Annotated explicitly because two configs were disagreeing about it. `readFileSync`
        // without an encoding returns a Buffer, which IS a Uint8Array — the compiler agreed
        // with that and the editor did not, depending on which tsconfig each had loaded. Saying
        // the type rather than inferring it removes the question, and costs nothing.
        const file: Uint8Array = fs.readFileSync(path.join(dir, name));
        return send(200, file, 'font/woff2');
      } catch {
        // Not in this package. Try the next, and only 404 once every one has been tried.
      }
    }
    return send(404, 'no such font', 'text/plain; charset=utf-8');
  }

  if (req.method === 'GET' && (req.url ?? '').startsWith('/icons/')) {
    // The identity illustrations. A FIXED NAME LIST, like the fonts route: `basename` is what keeps
    // a crafted path from walking out of the directory, and the whitelist keeps this route from
    // serving anything else that ever lands in that folder.
    const name = path.basename((req.url ?? '').split('?')[0]);
    if (!/^(pink|blonde|black|teal|blue)\.png$/.test(name)) {
      return send(404, 'not found', 'text/plain; charset=utf-8');
    }
    try {
      const file: Uint8Array = fs.readFileSync(`src/web/app/icons/${name}`);
      return send(200, file, 'image/png');
    } catch {
      return send(404, 'no such icon', 'text/plain; charset=utf-8');
    }
  }

  if (req.method === 'GET' && req.url === '/mask-shape-5.svg') {
    // The avatar mask: the theme's shape 5, which is a soft-edged blob (its source SVG carries an
    // feGaussianBlur, so `mask-image` keeps the feather and `clip-path` would not). A literal path
    // like the texture's, and an SVG, so it is 904 bytes and resolution-free.
    try {
      const file: Uint8Array = fs.readFileSync('src/web/app/mask-shape-5.svg');
      return send(200, file, 'image/svg+xml');
    } catch {
      return send(404, 'no mask', 'text/plain; charset=utf-8');
    }
  }

  if (req.method === 'GET' && req.url === '/suidobashi.jpg') {
    // The home page's hero — Suidobashi, for the name. A literal path like the texture's, so the
    // request cannot steer the read out of src/web/app/. Served at 1536×1024 (re-encoded from the
    // 1536×1024 PNG, 2.8 MB → 580 KB): the hero fills half the viewport, so 1536 is the width a
    // retina laptop actually asks for, and PNG was simply the wrong container for an RGB image.
    try {
      const file: Uint8Array = fs.readFileSync('src/web/app/suidobashi.jpg');
      return send(200, file, 'image/jpeg');
    } catch {
      return send(404, 'no hero', 'text/plain; charset=utf-8');
    }
  }

  if (req.method === 'GET' && req.url === '/texture.png') {
    // The theme's paper grain. A literal path, like the page modules above, so the request can
    // never steer the read out of src/web/app/. Bytes rather than text: it is a PNG, and it is
    // served from here rather than fetched from the theme's CDN for the same reason the fonts
    // and the wallet bundle are.
    try {
      const file: Uint8Array = fs.readFileSync('src/web/app/texture.png');
      return send(200, file, 'image/png');
    } catch {
      return send(404, 'no texture', 'text/plain; charset=utf-8');
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
    // `/` IS THE SAME PAGE. ONE bundle serves both, and it decides which of the two states to show
    // from the wallet's own connection state — which the server cannot know, since the wallet lives
    // in the browser. A second bundle for the way in would be a second startup build step and a
    // second thing to keep in step, for a page whose whole content is one button.
    //
    // The token is injected here for the same reason as at /app: the page never has to ask for it,
    // and a cross-origin caller can reach the port but cannot read this response.
    return send(200, APP_PAGE.replace('__TOKEN__', TOKEN), 'text/html; charset=utf-8');
  }


  if (req.url?.startsWith('/api/')) {
    if (req.headers['x-agent-token'] !== TOKEN) {
      return send(403, JSON.stringify({ error: 'bad or missing token' }));
    }
  }

  if (req.method === 'GET' && req.url === '/api/state') {
    return state().then((s) => send(200, JSON.stringify(s))).catch((e) => send(500, JSON.stringify({ error: errText(e) })));
  }

  if ((req.url ?? '').startsWith('/api/chats')) {
    // Parsed by hand rather than with a router: five routes, one shape, and a dependency for
    // this would be more code than it replaces.
    const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean); // ['api','chats',id?]
    const id = parts[2];

    if (req.method === 'GET' && !id) {
      return send(200, JSON.stringify({ chats: listChats(), db: dbPath }));
    }
    if (req.method === 'POST' && !id) {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
      req.on('end', () => {
        let title = 'new chat';
        try {
          const body = JSON.parse(raw || '{}');
          if (typeof body.title === 'string' && body.title.trim()) title = body.title.trim().slice(0, 80);
        } catch { /* a missing body just means the default title */ }
        return send(200, JSON.stringify(createChat(title)));
      });
      return;
    }
    if (req.method === 'GET' && id) {
      const chat = getChat(id);
      if (!chat) return send(404, JSON.stringify({ error: 'no such chat' }));
      return send(200, JSON.stringify({ chat, messages: messages(id) }));
    }
    if (req.method === 'POST' && id) {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
      req.on('end', () => {
        let role: any = 'pipeline', kind = '', text = '';
        try {
          const body = JSON.parse(raw || '{}');
          role = body.role ?? role;
          // The KIND travels with the message, because it is what the transcript renders from:
          // `role` says who spoke, the kind says whether it was an answer or a step.
          kind = String(body.kind ?? '');
          text = String(body.text ?? '');
        } catch {
          return send(400, JSON.stringify({ error: 'bad body' }));
        }
        if (!text) return send(400, JSON.stringify({ error: 'text required' }));
        return send(200, JSON.stringify(append(id, role, kind, text)));
      });
      return;
    }
    if (req.method === 'PATCH' && id) {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
      req.on('end', () => {
        let title = '';
        try {
          const body = JSON.parse(raw || '{}');
          title = String(body.title ?? '').trim();
        } catch {
          return send(400, JSON.stringify({ error: 'bad body' }));
        }
        // Refused rather than defaulted: an empty title is a mistake, and silently naming the
        // chat "new chat" would hide it. Capped because it is a label in a narrow list.
        if (!title) return send(400, JSON.stringify({ error: 'title required' }));
        if (!getChat(id)) return send(404, JSON.stringify({ error: 'no such chat' }));
        renameChat(id, title.slice(0, 80));
        return send(200, JSON.stringify({ ok: true }));
      });
      return;
    }
    if (req.method === 'DELETE' && id) {
      deleteChat(id);
      return send(200, JSON.stringify({ ok: true }));
    }
  }

  if ((req.url ?? '').startsWith('/api/talents')) {
    const parts = (req.url ?? '').split('?')[0].split('/').filter(Boolean);
    const id = parts[2];

    if (req.method === 'GET' && !id) {
      // THE MARKETPLACE AND WHAT IS INSTALLED, as two lists. The tab shows the first as things
      // you can add and marks the ones already in the second — which is what a marketplace is,
      // and why nobody types a URL any more.
      // ORPHANS ARE DROPPED, not shown. An id that is no longer in the marketplace is a row from
      // before a rename — three iterations left two behind, and the pane matched the first, so the
      // server's side showed a stale copy of a talent that had moved on.
      const live = listTalents().filter((t) => talentFor(t.id) !== null);
      return send(200, JSON.stringify({
        marketplace: MARKETPLACE,
        installedIds: live.map((t) => t.id),
        // The stored manifest is the SERVER's side — what it can do. Shown beside the
        // talent's own actions so the two halves of the protocol are visible as two.
        installed: live,
      }));
    }

    if (req.method === 'POST' && !id) {
      // INSTALLING FETCHES THE MANIFEST HERE, not in the browser.
      //
      // An MCP server will not send CORS headers — it is not a website — so a browser fetch of
      // /metadata fails on a cross-origin request. And the server is the side that actually talks
      // MCP, so it is the side that should hold the description of what it can do.
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
      req.on('end', async () => {
        let wanted = '';
        try {
          // `id` from the marketplace, or `url` for something not listed. Both accepted because
          // the marketplace is a convenience, not a gate.
          const body = JSON.parse(raw || '{}');
          wanted = String(body.id ?? body.url ?? '').trim();
        } catch {
          return send(400, JSON.stringify({ error: 'bad body' }));
        }

        // The marketplace entry names the server, so the address is never typed. The name comes
        // from the entry too: a talent is how the agent reaches a server, and the client's half
        // of the protocol is ours to declare rather than the server's to announce.
        const listed = talentFor(wanted);
        const url = (listed?.server ?? wanted).replace(/\/+$/, '');
        if (!/^https?:\/\/[^\s]+$/.test(url)) {
          return send(400, JSON.stringify({
            error: 'not in the marketplace, and not an http(s) address either',
          }));
        }

        try {
          const r = await fetch(`${url}/metadata`, { signal: AbortSignal.timeout(8000) });
          if (!r.ok) {
            return send(200, JSON.stringify({
              ok: false, why: `${url}/metadata answered ${r.status}`,
            }));
          }
          const manifest: any = await r.json();
          // The name comes from the manifest, so a talent says what it is rather than being
          // labelled by whoever installed it. The URL is the id: it is unique, and it is what
          // the server would have to reach anyway.
          const name = listed?.name || String(manifest?.strategy?.id || url);
          installTalent(url, name, manifest, null);
          return send(200, JSON.stringify({ ok: true, id: url, name }));
        } catch (e) {
          // A talent that cannot be reached is not an error on our side, so it reads as one
          // sentence rather than a stack.
          return send(200, JSON.stringify({
            ok: false, why: `could not reach ${url}: ${errText(e)}`,
          }));
        }
      });
      return;
    }

    if (req.method === 'DELETE' && id) {
      uninstallTalent(decodeURIComponent(id));
      return send(200, JSON.stringify({ ok: true }));
    }
  }

  if (req.method === 'GET' && req.url === '/api/outstanding') {
    return outstandingOrders()
      .then((o) => send(200, JSON.stringify(o)))
      .catch((e) => send(500, JSON.stringify({ error: errText(e) })));
  }

  if (req.method === 'GET' && req.url === '/api/hires') {
    return hires().then((h) => send(200, JSON.stringify(h))).catch((e) => send(500, JSON.stringify({ error: errText(e) })));
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
        // ANSWERED BY THE APP, NOT THE MODEL, and it has to come first.
        //
        // The local model is an EXTRACTOR: it turns a sentence into an action, a direction and an
        // amount. Ask it what it can do and it correctly reports an action it does not recognise,
        // which the gate refuses — so "what skills do you have" came back as a refusal, from a
        // system that knows the answer perfectly well and simply was not asked.
        //
        // A heuristic rather than a classifier, and deliberately: the alternative is asking a 0.6B
        // model to decide whether it is being asked a question, which is exactly the kind of
        // judgement it is bad at. If this misses a phrasing, the user gets a refusal — the same
        // behaviour as before, not a wrong action.
        if (CAPABILITY_QUESTION.test(body.text)) {
          // FROM WHAT IS INSTALLED, so the answer and the agent agree by construction rather
          // than by both being written correctly.
          const installed = listTalents();
          const { text: capabilities } = describeTalents(installed.map((t) => t.id));
          const text = [
            capabilities ? 'I can do these:' : 'Nothing is installed yet — add a talent first.',
            capabilities,
          ].filter(Boolean).join('\n');
          return send(200, JSON.stringify({
            decision: 'ANSWERED',
            events: [event('answered', 'pipeline', text)],
          }));
        }

        const r = runAgent(body.text);
        // The events this step produced. `extracting` is MODEL-sourced because the
        // model's part is advisory; the verdict is PIPELINE, because the gate is our
        // own code. Neither is CHAIN — nothing has touched the chain yet.
        const doc = firstJson(r.stdout);
        // THREE OUTCOMES, not two. `proposed` allowed it, `refused` declined it, and `asking`
        // could not decide because the request named more than one thing — which is a QUESTION,
        // and rendering it as a refusal gave the user a dead end where they needed a choice.
        const decision = doc?.decision;
        const options = Array.isArray(doc?.options) ? doc.options : [];
        // The request rebuilt from the parsed intent, with no hire name in it — so a client
        // can answer by naming one without re-naming both.
        const template = typeof doc?.template === 'string' ? doc.template : '';

        // A READ IS ANSWERED HERE, not proposed.
        //
        // There is nothing to sign and nothing to approve — the action IS the answer — so the flow
        // ends one step earlier than a swap's. The page needs no branch of its own: it already
        // stops on any decision that is not PROPOSED, which is the same shape the capability
        // question above returns. Emitting the answer here rather than teaching the client about
        // reads is what keeps the browser ignorant of the difference.
        if (decision === 'PROPOSED' && doc?.plan?.read) {
          const server = serverForAction(listTalents().map((t) => t.id), String(doc?.intent?.action ?? ''));
          // A SERVER, NOT A DIFFERENT ACTION. The talent says which server answers this action,
          // so a talent whose server is missing is a refusal rather than a quiet fallback.
          const refusal = (reason: string) => send(200, JSON.stringify({
            ...r, decision: 'REFUSED',
            events: [event('refused', 'pipeline', ending('refused', { reason }))],
          }));
          if (!server) return refusal('no installed talent answers that read');

          const url = `${server}/query`;
          try {
            // The query comes from the PLAN, which is our own code's, not from the page — the
            // same rule the swap path follows for amounts and venues. The browser names the
            // action and nothing else.
            const reply = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(doc.plan.query ?? {}),
              signal: AbortSignal.timeout(10_000),
            });
            const out: any = await reply.json();
            if (!reply.ok) {
              return refusal(`${server} answered ${reply.status}: ${out?.error ?? 'no reason given'}`);
            }
            // The answer, in the units a person reads. `fromUnits` rather than a division: it is
            // the project's one formatter, and money never goes through a float.
            const coins: any[] = Array.isArray(out?.coins) ? out.coins : [];
            const text = coins.length
              ? `balances for ${out.owner}\n`
                + coins.map((c) => `${c.symbol} ${fromUnits(c.amount, Number(c.decimals))}`).join('\n')
              : 'the query server returned no balances';
            // CHAIN-sourced, because these numbers came back from a read of the chain. That is the
            // one thing the source means: not a guess, and not our own progress.
            return send(200, JSON.stringify({
              ...r, decision: 'ANSWERED',
              events: [event('answered', 'chain', text)],
            }));
          } catch (e) {
            return refusal(`query server unreachable at ${url}: ${errText(e)}`);
          }
        }

        const events = [
          event('extracting', 'model', 'the local model is reading the request'),
          decision === 'PROPOSED'
            ? event('proposed', 'pipeline', 'the gate allowed it')
            : decision === 'ASKING'
              ? event('asking', 'pipeline', 'the request names more than one — which one?',
                  { options, template })
              : event('refused', 'pipeline', ending('refused', {
                // `doc.reason` as well as the validation's: the gate refuses in two places —
                // a verdict that says no, and a plan that cannot be built — and reading only the
                // first reported the second as the decision STRING, which is how a user came to
                // see "refused — REFUSED". The decision is not a reason and never was.
                reason: (doc && doc.validation && doc.validation.reason)
                  || (doc && doc.reason) || 'the request could not be turned into an action',
              })),
        ];
        return send(200, JSON.stringify({ ...r, decision, options, template, events }));
      }

      // /api/build: returns bytes to sign, or a refusal with its reason.
      const kind = body.kind || 'swap';
      try {
        const out = build(kind, body);
        // A build either produced bytes or was refused. Both are events, and a refusal
        // is not a transport failure — it is the gate doing its job.
        const events = out.error || out.refused
          ? [event('refused', 'pipeline', ending('refused', {
            reason: ((out.refused as any)?.validation?.reason)
              || out.refused || out.error,
          }))]
          : [event('building', 'pipeline', 'the transaction is built and simulated')];
        return send(out.error ? 400 : 200, JSON.stringify({ ...out, events }));
      } catch (e) {
        return send(500, JSON.stringify({ error: String(errText(e)) }));
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
          events: [event('refused', 'pipeline', ending('refused', { reason: 'no order in that transaction' }))],
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
             event('filled', 'chain', ending('filled', { received: out.received ?? 'the output' }))]
          : [event('notified', 'pipeline', 'the filler was told'),
             event('expired', 'chain', ending('expired'))];
        return send(200, JSON.stringify({ orderId, ...out, events }));
      } catch (e) {
        return send(200, JSON.stringify({
          orderId,
          filled: false,
          why: `mcp server unreachable at ${url}: ${errText(e)}`,
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
