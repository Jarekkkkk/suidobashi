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
  USDC_TYPE, SUI_TYPE, SLIPPAGE_BPS,
} from './addresses.js';

const PORT = Number(process.env.MCP_PORT ?? 8790);
const HOST = process.env.MCP_HOST ?? '127.0.0.1';

/**
 * The least fee this server will bother filling for, in the output coin's units.
 *
 * The server's own policy, separate from any maker's default — the maker's UI default
 * is what they OFFER, this is what the server ACCEPTS. Conflating them would put the
 * server's cost model into a number the maker controls.
 *
 * 0.01 USDC, set from a MEASURED cost rather than an estimate: a real fill paid 0.00557
 * SUI of gas (~$0.0064), so the previous 0.005 floor accepted fills that lost money.
 * A floor below cost is worse than no floor — it looks like a policy and behaves like
 * a subsidy.
 */
const MIN_FEE_OUT = BigInt(process.env.MCP_MIN_FEE_OUT ?? '10000');

let client;

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
async function readFee(orderId) {
  const c = await getClient();
  const fields = await c.listDynamicFields({ parentId: orderId, limit: 20 });
  const f = (fields.dynamicFields ?? []).find((x) =>
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
async function inspect(orderId) {
  const c = await getClient();
  let obj;
  try {
    obj = await c.getObject({ objectId: orderId, include: { json: true } });
  } catch (e) {
    return { ok: false, why: `cannot read ${orderId}: ${e.message}` };
  }
  const o = obj.object ?? obj;
  const order = o.json ?? {};
  if (!order.maker) return { ok: false, why: `${orderId} is not an order` };

  const sharedVersion = o.owner?.Shared?.initialSharedVersion;
  if (!sharedVersion) return { ok: false, why: 'order is not shared' };

  const fee = await readFee(orderId);
  const expiresAtMs = Number(order.expires_at_ms ?? 0);
  const funds = BigInt(order.funds ?? 0);
  const minOut = BigInt(order.min_out ?? 0);

  // Checked in the order that decides cheapest-first: nothing to do, too late, not
  // worth it. Each returns before the next so the reason names the real blocker.
  if (funds === 0n) return { ok: false, why: 'order is empty — already settled or refunded' };
  if (Date.now() >= expiresAtMs) return { ok: false, why: 'order has expired' };
  if (fee < MIN_FEE_OUT) {
    return {
      ok: false,
      why: `fee ${fee} is below this server's minimum ${MIN_FEE_OUT}`,
      fee: fee.toString(),
    };
  }
  return { ok: true, order, sharedVersion, fee, minOut, funds };
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
async function waitUntilSettled(client, orderId, tries = 12) {
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

async function fill(orderId) {
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

  const tx = new Transaction();
  tx.setSender(agent);
  tx.moveCall({
    // SUI in, USDC out: SUI is side B of Pool<USDC, SUI>.
    target: `${PACKAGE_LATEST_ID}::order::settle_b2a`,
    typeArguments: [USDC_TYPE, SUI_TYPE],
    arguments: [
      tx.sharedObjectRef({ objectId: POLICY_ID, initialSharedVersion: POLICY_SHARED_VERSION, mutable: false }),
      tx.sharedObjectRef({ objectId: orderId, initialSharedVersion: Number(seen.sharedVersion), mutable: true }),
      tx.sharedObjectRef({ objectId: GLOBAL_CONFIG_ID, initialSharedVersion: GLOBAL_CONFIG_SHARED_VERSION, mutable: false }),
      tx.sharedObjectRef({ objectId: POOL_ID, initialSharedVersion: POOL_SHARED_VERSION, mutable: true }),
      tx.pure.u128((sqrtNow * (10_000n + SLIPPAGE_BPS)) / 10_000n),
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
  const result = sent?.Transaction ?? sent?.FailedTransaction ?? sent ?? {};

  // Confirm the settlement is READABLE before reporting it, so a caller acting on it
  // immediately is not racing a node's view.
  if (result.status?.success === true) await waitUntilSettled(c, orderId);

  return {
    filled: result.status?.success === true,
    digest: result.digest ?? null,
    status: result.status ?? null,
    fee: seen.fee.toString(),
    minOut: seen.minOut.toString(),
  };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
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
          + 'minimum, and collects the fee the order declares.',
        // The terms a maker is agreeing to when they declare a fee.
        terms: {
          minFeeOut: MIN_FEE_OUT.toString(),
          feeAsset: 'USDC',
          window: 'fills must be requested before the order expires, which defaults to 60s',
        },
      }],
      routes: { fill: 'POST /fill  { "orderId": "0x…" }' },
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
        return json(res, 500, { filled: false, why: String(e?.message || e) });
      }
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`mcp server on http://${HOST}:${PORT}`);
  console.log(`  min fee ${MIN_FEE_OUT} (output coin units) · fills orders on request`);
  console.log(`  signing as the policy agent · key from AGENT_SECRET_KEY`);
  console.log(`  the fill is paid by the fee inside the order, not by x402`);
});
