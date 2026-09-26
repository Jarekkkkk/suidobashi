/* The reference MCP server: fills escrowed swap orders, and describes itself.
 *
 * A REFERENCE IMPLEMENTATION of the contract in docs/MCP-STANDARD.md, and the first
 * thing that holds an agent key. Two routes:
 *
 *   GET  /metadata   what this server does, and the terms it fills on
 *   POST /fill       { orderId } — fill an order, or say why not
 *
 * WHY IT IS NOTIFIED RATHER THAN WATCHING. A watcher would poll for new orders, and
 * that is not possible with the available tooling: the SDK's `listEvents` silently
 * ignores every filter shape (verified: MoveModule, eventType and sender all returned
 * the same unfiltered results), and there is no query for shared objects by type. So
 * the maker's client tells this server the order id, and the server fills inside the
 * order's window. That window is a minute by default, which is why the notification
 * has to be immediate rather than something a person does.
 *
 * WHO PAYS. The fee is INSIDE the order, paid on settlement to whoever fills it — so
 * this server must not also charge x402 for a fill, or it would be paid twice. x402
 * belongs to the other routes. There is one price and it is the one the maker declared.
 *
 * THE KEY. This process signs, using AGENT_SECRET_KEY. That is the one place in this
 * project where a key lives in a running server, and it is deliberate: the agent key
 * holds no funds, only a bounded permission, and the on-chain gates bound what it can
 * do even if the process is compromised.
 *
 * Usage:
 *   node src/mcp-server.js                 serve on 127.0.0.1:8790
 *   MCP_MIN_FEE_OUT=0 node src/mcp-server.js   fill orders with no fee too
 */
import 'dotenv/config';
import http from 'node:http';
import {
  PACKAGE_LATEST_ID, POLICY_ID, POLICY_SHARED_VERSION, POOL_ID, POOL_SHARED_VERSION,
  GLOBAL_CONFIG_ID, GLOBAL_CONFIG_SHARED_VERSION, CLOCK_ID, CLOCK_SHARED_VERSION,
  POOL_TYPE_ARGS, DIRECTIONS, SLIPPAGE_BPS,
  directionForCoinType, orderCoinType, type Direction,
} from './addresses.js';

const PORT = Number(process.env.MCP_PORT ?? 8790);
const HOST = process.env.MCP_HOST ?? '127.0.0.1';

/**
 * The least fee this server will bother filling for, PER OUTPUT COIN.
 *
 * The server's own policy, separate from any maker's default — the maker's UI default
 * is what they OFFER, this is what the server ACCEPTS. Conflating them would put the
 * server's cost model into a number the maker controls.
 *
 * 0.01 USDC, set from a MEASURED cost rather than an estimate: a real fill paid 0.00557
 * SUI of gas (~$0.0064), so the previous 0.005 floor accepted fills that lost money.
 * A floor below cost is worse than no floor — it looks like a policy and behaves like
 * a subsidy.
 *
 * A MAP RATHER THAN ONE NUMBER, because the fee is denominated in the OUTPUT coin and there are
 * two outputs now: a USDC order pays in USDC, a SUI order in SUI. A single figure would have been
 * read as USDC units against a SUI-denominated fee — 0.01 SUI against a floor of 10000, which is
 * 0.00001 SUI, so the floor would have stopped existing. The SUI floor is 0.01 SUI, which is the
 * same 1.8x margin over gas as the USDC one, and needs no conversion to pay that gas.
 *
 * A coin with no entry here is REFUSED rather than defaulted: an unknown output is not a cheap
 * fill, it is one this server has no cost model for.
 */
const MIN_FEE_OUT: Record<string, bigint> = {
  USDC: BigInt(process.env.MCP_MIN_FEE_OUT ?? '10000'),      // 0.01 USDC
  SUI: BigInt(process.env.MCP_MIN_FEE_SUI ?? '10000000'),    // 0.01 SUI
};

// Typed explicitly: inferred from a dynamic import inside a function, it is `any` in some
// locations and unresolvable in others — which is exactly what the compiler said.
let client: any;

async function getClient() {
  if (!client) {
    const { SuiGrpcClient } = await import('@mysten/sui/grpc');
    client = new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' });
  }
  return client;
}

/**
 * The fee an order pays for a fill, read from its DYNAMIC FIELD.
 *
 * Not from the order's own fields, because the fee is not one: `Order` is published and
 * its layout is frozen, so `create_with_fee` stores the fee as a dynamic field. Reading
 * `json.fee_out` finds nothing, and `?? 0` turns "not where I looked" into "no fee".
 *
 * That is exactly what happened — every order was reported as zero-fee while carrying
 * 5000 on chain, and this server declined them all as below its minimum. The same shape
 * of mistake as the page's fee field silently defaulting to zero: a fallback that
 * cannot tell a real zero from a wrong lookup.
 *
 * Absent DOES mean zero here, and legitimately: `create_with_fee` stores nothing for a
 * zero fee. But that is only true once the lookup is known to be right.
 */
async function readFee(orderId: string) {
  const c = await getClient();
  const fields = await c.listDynamicFields({ parentId: orderId, limit: 20 });
  const f = (fields.dynamicFields ?? []).find((x: any) =>
    String(x.name?.type ?? '').includes('::order::FeeKey'));
  if (!f) return 0n;
  const o = await c.getObject({ objectId: f.fieldId, include: { json: true } });
  const raw = (o.object ?? o).json?.value;
  // If the field exists but has no readable value, that is a lookup failure rather than
  // a zero fee, and saying so beats reporting a number nobody can reproduce.
  if (raw === undefined || raw === null) {
    throw new Error(`FeeKey field on ${orderId} has no readable value`);
  }
  return BigInt(raw);
}

/** Read an order and decide whether this server will fill it. */
/**
 * The result of inspecting an order.
 *
 * TYPED EXPLICITLY, and not for tidiness: an object literal's `ok: true` WIDENS to `boolean`, so
 * without this the two branches are not a discriminated union and `seen.dir` reads as "possibly
 * undefined" in the success branch. That is the compiler saying it cannot tell the outcomes apart,
 * and it is right — `dir` genuinely does not exist on the refusal branch.
 */
type Inspection =
  | { ok: false; why: string; fee?: string }
  | {
      ok: true;
      order: any;
      sharedVersion: unknown;
      fee: bigint;
      minOut: bigint;
      funds: bigint;
      direction: Direction;
      dir: (typeof DIRECTIONS)[Direction];
    };

async function inspect(orderId: string): Promise<Inspection> {
  const c = await getClient();
  let obj;
  try {
    obj = await c.getObject({ objectId: orderId, include: { json: true } });
  } catch (e) {
    return { ok: false, why: `cannot read ${orderId}: ${(e as any).message}` };
  }
  const o = obj.object ?? obj;
  const order = o.json ?? {};
  if (!order.maker) return { ok: false, why: `${orderId} is not an order` };

  const sharedVersion = o.owner?.Shared?.initialSharedVersion;
  if (!sharedVersion) return { ok: false, why: 'order is not shared' };

  // WHICH SIDE OF THE POOL, read from the object's own type — because the coin an order escrows is
  // NOT in its `json`. `funds` is a `Balance<T>` and the field is a plain number, so the type
  // argument is the only place the coin appears. This is what lets one filler settle both
  // directions instead of being told which one to expect.
  const coin = orderCoinType(o.type);
  const direction = coin ? directionForCoinType(coin) : null;
  if (!direction) {
    return {
      ok: false,
      why: `${orderId} escrows ${coin ?? 'nothing this server recognises'}, `
        + 'which this server cannot settle',
    };
  }
  const dir = DIRECTIONS[direction];
  const floor = MIN_FEE_OUT[dir.out.symbol];
  if (floor === undefined) {
    return { ok: false, why: `no cost model for a ${dir.out.symbol} fill` };
  }

  const fee = await readFee(orderId);
  const expiresAtMs = Number(order.expires_at_ms ?? 0);
  const funds = BigInt(order.funds ?? 0);
  const minOut = BigInt(order.min_out ?? 0);

  // Checked in the order that decides cheapest-first: nothing to do, too late, not
  // worth it. Each returns before the next so the reason names the real blocker.
  if (funds === 0n) return { ok: false, why: 'order is empty — already settled or refunded' };
  if (Date.now() >= expiresAtMs) return { ok: false, why: 'order has expired' };
  if (fee < floor) {
    return {
      ok: false,
      why: `fee ${fee} ${dir.out.symbol} is below this server's minimum ${floor} ${dir.out.symbol}`,
      fee: fee.toString(),
    };
  }
  return { ok: true, order, sharedVersion, fee, minOut, funds, direction, dir };
}

/**
 * Fill the order and return the digest.
 *
 * The whole fill is one transaction — gates, swap, `output - fee >= min_out`, the fee
 * to this server, the rest to the maker. Nothing is held in between, which is why a
 * compromised server cannot skim: the output never passes through it.
 */
/**
 * Wait until the order READS as settled — its balance emptied — or give up.
 *
 * Polls the OBJECT rather than the transaction, because the object is what the next reader
 * consults. This is the fix for a real failure: the burn was built moments after the fill
 * returned, resolved the order against a node whose view had not caught up, and aborted with
 * ENotSettled at the funds check — reading a pre-settlement version. The swap had filled and
 * the money had moved; only the cleanup was early.
 *
 * "Executed" and "visible to the next reader" are different claims, and the reclaim acts on
 * the second. Returning only after the first is what made the race possible.
 *
 * A timeout is NOT a failure. The settlement has landed either way, and the retry on the
 * burn's build covers a reader still behind.
 */
async function waitUntilSettled(client: any, orderId: string, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try {
      const o = await client.getObject({ objectId: orderId, include: { json: true } });
      const funds = (o.object ?? o).json?.funds;
      // A settled order has its balance emptied by `split`, so this reads as 0. Absent is
      // NOT settled — that would be reading the wrong thing, which is the mistake that has
      // already caused three bugs here.
      if (funds !== undefined && String(funds) === '0') return true;
    } catch { /* a transient read failure is the same as not-yet-visible */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function fill(orderId: string) {
  const seen = await inspect(orderId);
  if (!seen.ok) return { filled: false, ...seen };

  const secret = process.env.AGENT_SECRET_KEY;
  if (!secret) return { filled: false, why: 'AGENT_SECRET_KEY is not set' };

  const c = await getClient();
  const { Transaction } = await import('@mysten/sui/transactions');
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');

  const policyObj = await c.getObject({ objectId: POLICY_ID, include: { json: true } });
  const agent = (policyObj.object ?? policyObj).json?.agent;
  if (!agent) return { filled: false, why: 'cannot read the policy agent' };

  // A price bound relative to now. With a maker-committed floor this is no longer the
  // protection — that is the floor, asserted against the real output — but a sane
  // bound still avoids handing the pool a nonsense limit.
  const poolObj = await c.getObject({ objectId: POOL_ID, include: { json: true } });
  const sqrtNow = BigInt(String((poolObj.object ?? poolObj).json?.current_sqrt_price ?? 0));
  if (sqrtNow === 0n) return { filled: false, why: 'cannot read the pool price' };

  // THE LIMIT SITS ON THE SIDE THE SWAP IS HEADING — `DIRECTIONS.limitSign`, read off the order's
  // own coin. Selling A pushes the pool price down (a2b) and selling B pushes it up (b2a); a limit
  // on the wrong side is already crossed when the swap starts, so the pool aborts in
  // `flash_swap_internal` and the order never fills. This expression was `10_000n + SLIPPAGE_BPS`
  // unconditionally: right for b2a, which is the direction this server was written for, and the
  // reason every USDC -> SUI order expired unfilled while SUI -> USDC filled.
  const sqrtPriceLimit =
    (sqrtNow * (10_000n + BigInt(seen.dir.limitSign) * SLIPPAGE_BPS)) / 10_000n;

  const tx = new Transaction();
  tx.setSender(agent);
  tx.moveCall({
    // THE ENTRY POINT IS A PROPERTY OF THE DIRECTION, and the direction came off the order's own
    // type. `settle_a2b` fills an order holding side A, `settle_b2a` one holding side B — both take
    // the same `<A, B>` because the POOL fixes those, and both enforce the maker's floor the same
    // way. Move is statically typed and cannot infer the side, which is why there are two.
    target: `${PACKAGE_LATEST_ID}::order::${seen.dir.settle}`,
    typeArguments: [...POOL_TYPE_ARGS],
    arguments: [
      tx.sharedObjectRef({ objectId: POLICY_ID, initialSharedVersion: POLICY_SHARED_VERSION, mutable: false }),
      tx.sharedObjectRef({ objectId: orderId, initialSharedVersion: Number(seen.sharedVersion), mutable: true }),
      tx.sharedObjectRef({ objectId: GLOBAL_CONFIG_ID, initialSharedVersion: GLOBAL_CONFIG_SHARED_VERSION, mutable: false }),
      tx.sharedObjectRef({ objectId: POOL_ID, initialSharedVersion: POOL_SHARED_VERSION, mutable: true }),
      tx.pure.u128(sqrtPriceLimit),
      tx.sharedObjectRef({ objectId: CLOCK_ID, initialSharedVersion: CLOCK_SHARED_VERSION, mutable: false }),
    ],
  });

  // The normal build, which simulates: a fill that cannot clear the floor is refused
  // here rather than submitted, so a lost race or a moved price costs no gas.
  const bytes = await tx.build({ client: c });

  const { secretKey } = decodeSuiPrivateKey(secret);
  const signer = Ed25519Keypair.fromSecretKey(secretKey);
  const sent = await c.signAndExecuteTransaction({ transaction: bytes, signer });
  // A failed transaction comes back under FailedTransaction, not Transaction.
  // `any` because the fallback chain can land on the WRAPPER, which carries no digest —
    // the wrapper shape is { $kind, Transaction } and the payload is one level down.
    const result: any = sent?.Transaction ?? sent?.FailedTransaction ?? {};

  // Confirm the settlement is READABLE before reporting it, so a caller acting on it
  // immediately is not racing a node's view.
  if (result.status?.success === true) await waitUntilSettled(c, orderId);

  return {
    filled: result.status?.success === true,
    digest: result.digest ?? null,
    status: result.status ?? null,
    direction: seen.direction,
    fee: String(seen.fee ?? 0n),
    feeAsset: seen.dir.out.symbol,
    minOut: String(seen.minOut ?? 0n),
  };
}

import { spawnSync } from 'node:child_process';
import { DEEPBOOK_GUARD_ID, DEEPBOOK_BALANCE_MANAGER_ID } from './addresses.js';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  markScheduleFired,
} from './db.js';

/**
 * Run the grid runner and hand back what it printed.
 *
 * A shell-out to the same CLI a person runs, NOT a second implementation of it. One behaviour with
 * three entry points — a person, an agent, and the clock below — and none of them can disagree with
 * the others about what a pass does. It is slower, and it is the only version that stays true when
 * the runner changes.
 */
function runGrid(extra: string[]) {
  const out = spawnSync(
    'bun',
    ['src/run-grid.ts', '--guard', DEEPBOOK_GUARD_ID, '--bm', DEEPBOOK_BALANCE_MANAGER_ID, ...extra],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 },
  );
  // The runner prints one JSON object per step, each starting a line.
  const steps = (out.stdout ?? '').split(/\n(?=\{)/).flatMap((chunk) => {
    try {
      return [JSON.parse(chunk)];
    } catch {
      return [];
    }
  });
  return { status: out.status, steps, stderr: (out.stderr ?? '').trim().slice(0, 400) || null };
}

/**
 * The clock. Whatever a user asked for and has not happened yet.
 *
 * The stamp is written BEFORE the work rather than after: a pass that dies half way would otherwise
 * still be due on the next tick, and be retried every thirty seconds forever. Late is a schedule
 * that runs a moment after it was asked to; the alternative is one that never stops asking.
 */
async function fireDueSchedules() {
  const now = Date.now();
  for (const s of listSchedules()) {
    if (!s.enabled) continue;
    const due = s.lastFiredAt === null || now - s.lastFiredAt >= s.everySeconds * 1000;
    if (!due) continue;
    markScheduleFired(s.id, now);
    try {
      const side = String(s.params.side ?? 'ask');
      const out = runGrid(['--side', side, '--levels', '1', '--execute']);
      // The DIGEST, not only a count. A scheduled pass places real orders, and a log line that says
      // "two steps" leaves whoever reads it with no way to find what was placed — which is exactly
      // how one 1 SUI order became unfindable after the first live fire.
      const digest = (out.steps as { digest?: string | null }[]).find((st) => st.digest)?.digest ?? null;
      console.log(JSON.stringify({
        scheduled: s.id, action: s.action, ok: out.status === 0, steps: out.steps.length, digest,
      }));
    } catch (e) {
      console.log(JSON.stringify({ scheduled: s.id, action: s.action, error: String((e as Error).message).slice(0, 200) }));
    }
  }
}

const json = (res: any, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  // === the grid, as a talent ===
  // A person can run this from a terminal and an agent can call it here; both reach the same
  // runner, so the manifest below describes something that is already true.
  if (req.method === 'GET' && req.url === '/grid/status') {
    const out = runGrid(['--side', 'ask', '--levels', '1']);
    return json(res, 200, { ok: out.status === 0, steps: out.steps, stderr: out.stderr });
  }

  if (req.method === 'POST' && req.url === '/grid/run') {
    const out = runGrid(['--side', 'ask', '--levels', '1', '--execute']);
    return json(res, 200, { ok: out.status === 0, steps: out.steps, stderr: out.stderr });
  }

  // Schedules by QUERY rather than by body: three small verbs against one table, and reading a
  // request body to learn a number is a parser this does not need.
  if ((req.url ?? '').startsWith('/schedule')) {
    // Wrapped because a bad URL throws, and a throw inside the request handler is an unanswered
    // request rather than an error the caller can see.
    let url: URL;
    try {
      url = new URL(`http://local${req.url}`);
    } catch {
      return json(res, 400, { error: 'bad request URL' });
    }
    if (req.method === 'GET') {
      return json(res, 200, { schedules: listSchedules() });
    }
    if (req.method === 'DELETE') {
      deleteSchedule(url.searchParams.get('id') ?? '');
      return json(res, 200, { schedules: listSchedules() });
    }
    if (req.method === 'POST') {
      // A floor of 15 seconds. A schedule that can be set to zero is a loop, and the thing it loops
      // is a signed transaction.
      const every = Math.max(Number(url.searchParams.get('every')) || 0, 15);
      const id = createSchedule('grid.run', { side: 'ask', levels: 1 }, every);
      return json(res, 200, { created: id, everySeconds: every, schedules: listSchedules() });
    }
  }

  if (req.method === 'GET' && req.url === '/metadata') {
    // What a publisher would declare in a manifest. Not token-gated and not charged:
    // a description nobody can read is not a description.
    return json(res, 200, {
      schemaVersion: '1',
      strategy: { id: 'sui-tokyo-swap', version: '1.0.0' },
      actions: [{
        id: 'fill',
        title: 'Fill an escrowed swap order',
        description: 'Swaps the funds an order escrows, delivers at least the maker\'s '
          + 'minimum, and collects the fee the order declares. BOTH DIRECTIONS: which side of the '
          + 'pool the order holds is read from the order object itself.',
        // The terms a maker is agreeing to when they declare a fee.
        terms: {
          minFeeOut: Object.fromEntries(Object.entries(MIN_FEE_OUT).map(([k, v]) => [k, v.toString()])),
          feeAsset: 'the output coin — USDC for a SUI order, SUI for a USDC one',
          directions: Object.keys(DIRECTIONS),
          window: 'fills must be requested before the order expires, which defaults to 60s',
        },
      }, {
        id: 'grid.status',
        title: 'Read the DeepBook guard',
        description: 'The account an agent may trade: its limits, the book, the funds it holds, and '
          + 'what a pass would do. Changes nothing and signs nothing.',
      }, {
        id: 'grid.run',
        title: 'Run one grid pass',
        description: 'Places one ladder level through the guard, signed by whoever holds the seat. '
          + 'The guard enforces the band, the per-order bound, the budget and the pause, so this '
          + 'cannot exceed what the maker set.',
      }],
      routes: {
        fill: 'POST /fill  { "orderId": "0x…" }',
        'grid.status': 'GET /grid/status',
        'grid.run': 'POST /grid/run',
        schedule: 'GET /schedule · POST /schedule?every=60 · DELETE /schedule?id=…',
      },
    });
  }

  if (req.method === 'POST' && req.url === '/fill') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let orderId;
      try {
        ({ orderId } = JSON.parse(raw || '{}'));
      } catch {
        return json(res, 400, { filled: false, why: 'bad body' });
      }
      if (!/^0x[0-9a-f]{64}$/.test(String(orderId))) {
        return json(res, 400, { filled: false, why: 'orderId must be a full 0x object id' });
      }
      try {
        const out = await fill(orderId);
        return json(res, out.filled ? 200 : 409, out);
      } catch (e) {
        return json(res, 500, { filled: false, why: String((e as any)?.message ?? e) });
      }
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

// The clock starts with the server, and only here: this process holds the signing key, so a
// scheduled pass has no new key to find and no new place for one to leak from.
setInterval(() => {
  void fireDueSchedules();
}, 30_000);

server.listen(PORT, HOST, () => {
  console.log(`mcp server on http://${HOST}:${PORT}`);
  const floors = Object.entries(MIN_FEE_OUT).map(([k, v]) => `${v} ${k}`).join(', ');
  console.log(`  min fee ${floors} · fills orders on request, either direction`);
  console.log(`  signing as the policy agent · key from AGENT_SECRET_KEY`);
  console.log(`  the fill is paid by the fee inside the order, not by x402`);
});
