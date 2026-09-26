/* The reference QUERY server: answers balances and object lookups, and describes itself.
 *
 * A SECOND reference implementation of the contract in docs/MCP-STANDARD.md, and the first one
 * that is READ-ONLY. Two routes:
 *
 *   GET  /metadata   what this server does, and its terms
 *   POST /query      { "what": "balances", "owner": "0x…" }  — or { "what": "objects", … }
 *
 * THE POINT OF THIS SERVER is the thing it does NOT have: a key. The filler holds an agent key
 * because filling needs a signature; this one answers questions and therefore holds nothing, signs
 * nothing, and cannot move a cent even if it is fully compromised. A read is where a remote
 * server can be trusted almost for free, which is why the first remote talent is this one.
 *
 * IT ALSO HAS NO FILL ROUTE, and that is a design statement rather than a gap. The filler's fee
 * is INSIDE the order and is paid on settlement, so a second charge for a fill would be paid
 * twice; x402 therefore belongs on a route that is not a fill. There is no such route here at all,
 * which makes "never charges for a fill" true by construction rather than by care.
 *
 * x402 IS PRESENT BUT OFF, AND THAT IS THE HONEST STATE. `QUERY_PRICE_MIST` declares a price in
 * the terms, and when it is above zero every query is answered 402 with those terms. NOTHING CAN
 * PAY YET: paying means building a transaction that draws from the vault under a grant, and that
 * path does not exist. So the default is zero — free — and the manifest never advertises a price
 * this server cannot be paid. Advertising one would repeat the exact trap in NOTES: a title that
 * promised USDC -> SUI while nothing implemented it. Turn it on when the payment path exists.
 *
 * Usage:
 *   bun src/query-server.ts                     serve on 127.0.0.1:8791, free
 *   QUERY_PRICE_MIST=1000 bun src/query-server.ts   declare a price (still unpayable)
 */
import http from 'node:http';
import { SUI_TYPE, USDC_TYPE } from './addresses.js';

const PORT = Number(process.env.QUERY_PORT ?? 8791);
const HOST = process.env.QUERY_HOST ?? '127.0.0.1';

/**
 * The price of one query, in MIST, as declared in the terms.
 *
 * Zero means free, and zero is the ONLY setting that works today — see the note above. It is read
 * at startup and served in the manifest, so a client learns the price before it asks rather than
 * after being refused.
 */
export const PRICE_MIST = BigInt(process.env.QUERY_PRICE_MIST ?? '0');

/** A full 32-byte object id or address. The same shape check the filler applies to an order id. */
const ID = /^0x[0-9a-fA-F]{64}$/;

/** Typed explicitly, for the same reason as the filler's: a dynamic import infers `any` in some
 * locations and is unresolvable in others. */
let client: any;

async function getClient() {
  if (!client) {
    const { SuiGrpcClient } = await import('@mysten/sui/grpc');
    client = new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' });
  }
  return client;
}

/**
 * An address's spendable balances, in the coins' smallest units.
 *
 * Raw units and the decimals alongside them, never a pre-divided number: 1.5 USDC is
 * 1500000 here and the conversion is the client's, done once, exactly. Dividing here would put
 * a float in the one place this project has repeatedly refused to allow one.
 */
async function balances(owner: string) {
  const c = await getClient();
  const [sui, usdc] = await Promise.all([
    c.getBalance({ owner, coinType: SUI_TYPE }),
    c.getBalance({ owner, coinType: USDC_TYPE }),
  ]);
  return {
    owner,
    coins: [
      { symbol: 'SUI', decimals: 9, amount: String(sui.balance?.balance ?? 0) },
      { symbol: 'USDC', decimals: 6, amount: String(usdc.balance?.balance ?? 0) },
    ],
  };
}

/**
 * One object, as the chain reports it.
 *
 * NOT CHAIN STATE WE CACHE — this server holds nothing. It reads, answers, and forgets, which is
 * why it can be somebody else's process.
 */
async function objects(objectId: string) {
  const c = await getClient();
  let got;
  try {
    got = await c.getObject({ objectId, include: { json: true } });
  } catch (e) {
    return { error: `cannot read ${objectId}: ${(e as Error).message}` };
  }
  const o = got.object ?? got;
  return {
    objectId,
    type: o.type ?? null,
    owner: o.owner ?? null,
    json: o.json ?? null,
  };
}

/**
 * The manifest: what a publisher declares, and what a client reads before it asks.
 *
 * EXPORTED AND PURE so a check can import it without starting a server. Importing a module that
 * listens on a port is a side effect, and the trap that cost real time in this repo was exactly
 * a module whose CLI entry ran on import — see the `import.meta.main` guard below.
 */
export function manifest(priceMist: bigint = PRICE_MIST) {
  return {
    schemaVersion: '1',
    strategy: { id: 'sui-tokyo-query', version: '1.0.0' },
    actions: [
      {
        id: 'balances',
        title: "Read an address's SUI and USDC balances",
        description: 'Returns both coin balances in their smallest units, with their decimals.',
        terms: { priceMist: priceMist.toString(), asset: 'SUI', decimals: 9 },
      },
      {
        id: 'objects',
        title: 'Look up an object by id',
        description: 'Returns the type, owner and fields of a single object.',
        terms: { priceMist: priceMist.toString(), asset: 'SUI', decimals: 9 },
      },
    ],
    routes: {
      balances: 'POST /query  { "what": "balances", "owner": "0x…" }',
      objects: 'POST /query  { "what": "objects", "objectId": "0x…" }',
    },
    // Stated in the manifest rather than left to documentation, because a client should be able to
    // learn it without reading this file.
    readOnly: true,
    charges: { fills: false, reason: 'a fill is paid by the fee inside the order; there is no fill route here' },
  };
}

const json = (res: any, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** The request handler, exported so the routes can be exercised without a socket in tests. */
export async function answer(body: any): Promise<{ code: number; body: unknown }> {
  // ONE PRICE CHECK, BEFORE ANY WORK — so a refused query costs nothing to answer and the terms
  // come back in the refusal rather than the reason being inferred.
  if (PRICE_MIST > 0n) {
    return {
      code: 402,
      body: {
        error: 'payment required',
        terms: { priceMist: PRICE_MIST.toString(), asset: 'SUI' },
        note: 'settlement is not implemented in this client yet, so a priced query server cannot '
          + 'be used. See the note at the top of src/query-server.ts.',
      },
    };
  }

  const what = String(body?.what ?? '');
  if (what === 'balances') {
    const owner = String(body?.owner ?? '');
    if (!ID.test(owner)) return { code: 400, body: { error: 'owner must be a full 0x address' } };
    return { code: 200, body: await balances(owner) };
  }
  if (what === 'objects') {
    const objectId = String(body?.objectId ?? '');
    if (!ID.test(objectId)) return { code: 400, body: { error: 'objectId must be a full 0x object id' } };
    const out: any = await objects(objectId);
    return { code: out.error ? 404 : 200, body: out };
  }
  return { code: 400, body: { error: 'what must be "balances" or "objects"' } };
}

function serve() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metadata') {
      // Not gated and not charged: a description nobody can read is not a description.
      return json(res, 200, manifest());
    }

    if (req.method === 'POST' && req.url === '/query') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; if (raw.length > 8192) req.destroy(); });
      req.on('end', async () => {
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return json(res, 400, { error: 'bad body' });
        }
        try {
          const out = await answer(body);
          return json(res, out.code, out.body);
        } catch (e) {
          return json(res, 500, { error: String((e as Error)?.message ?? e) });
        }
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  });

  server.listen(PORT, HOST, () => {
    console.log(`query server on http://${HOST}:${PORT}`);
    console.log(`  read-only · holds no key · has no fill route`);
    console.log(`  price ${PRICE_MIST === 0n ? 'free' : `${PRICE_MIST} MIST (UNPAYABLE — see the header)`}`);
  });
}

// Guarded, so importing the manifest for a check does not bind a port. A module that is both a
// server and a library has to do this: the bare call is only harmless while nobody imports it.
if (import.meta.main) serve();
