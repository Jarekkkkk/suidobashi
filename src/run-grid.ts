/*
 * The strategy runner's SUBMISSION half: read a guard, plan, submit, report.
 *
 * `src/runner.ts` holds the decision half and is checked by assertions with no chain in sight. This
 * is the other half — the part that has to touch a key — kept separate so that the part which can be
 * tested is, and the part which cannot is small enough to read in one sitting.
 *
 * One pass, one transaction. It reads the guard's limits, the book, and what is already resting;
 * asks `planGrid` what should change; and submits the difference: cancels first, then placements.
 *
 * It also answers a question this project left open on purpose. Every order path takes `&mut Pool`,
 * and whether one programmable transaction may take that on the same shared object in several
 * commands was never settled — DeepBook's SDK batches orders, but this repo had not tried it. A
 * planning pass that wants a five-level ladder in one transaction IS that try. If Sui refuses, the
 * dry run says so before anything is signed, and the fallback is one transaction per level.
 *
 *   bun src/run-grid.ts --guard <id> --bm <id>
 *   bun src/run-grid.ts --guard <id> --bm <id> --execute
 */
import 'dotenv/config';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { DEEPBOOK_GUARD_PACKAGE, SUI_TYPE, USDC_TYPE } from './addresses.js';
import {
  CLOCK_ID,
  DEEPBOOK_POOL_ID,
  DEEPBOOK_TICK_SIZE,
  buyTx,
  cancelTx,
  sellTx,
  sharedVersionOf,
  type OrderRefs,
} from './deepbook.js';
import { planGrid, type GuardView, type OpenOrder } from './runner.js';

const argv = process.argv.slice(2);
const flag = (name: string, fallback = ''): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(name);

const GUARD = flag('--guard');
const BM = flag('--bm');
const LEVELS = Number(flag('--levels', '5'));
const QUANTITY = BigInt(flag('--quantity-raw', '1000000000'));
const SIDE = flag('--side', 'bid') as 'bid' | 'ask';
const EXECUTE = has('--execute');

if (!GUARD || !BM) {
  console.error('--guard and --bm are required');
  process.exit(2);
}

const client = new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' });

/** BCS comes back keyed by byte offset; this is the bytes those keys address. */
function bytesOf(bcs: Record<string, number>): Uint8Array {
  const keys = Object.keys(bcs).map(Number).sort((a, b) => a - b);
  return Uint8Array.from(keys.map((k) => bcs[String(k)]));
}

function readU64(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset).getBigUint64(0, true);
}

/** uleb128 length, then fixed-width little-endian words. */
function readVector(b: Uint8Array, width: number): bigint[] {
  let i = 0;
  let len = 0;
  let shift = 0;
  for (;;) {
    const x = b[i++];
    len += (x & 0x7f) * 2 ** shift;
    if ((x & 0x80) === 0) break;
    shift += 7;
  }
  const out: bigint[] = [];
  for (let k = 0; k < len; k++) {
    let v = 0n;
    for (let j = width - 1; j >= 0; j--) v = (v << 8n) | BigInt(b[i + k * width + j]);
    out.push(v);
  }
  return out;
}

const hexAddr = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');

/**
 * Everything one pass needs, in ONE simulation.
 *
 * One call rather than four because each is free and they must be consistent with each other: a
 * plan built from a guard read at one moment and a book read at another would be planning against
 * two different markets.
 */
async function readState(guardId: string, bmId: string) {
  const tx = new Transaction();
  const call = (fn: string, args: unknown[], typeArguments: string[]) =>
    tx.moveCall({ target: `${DEEPBOOK_GUARD_PACKAGE}::deepbook_guard::${fn}`, typeArguments, arguments: args as never });

  call('maker', [tx.object(guardId)], [SUI_TYPE, USDC_TYPE]);
  call('agent', [tx.object(guardId)], [SUI_TYPE, USDC_TYPE]);
  call('is_paused', [tx.object(guardId)], [SUI_TYPE, USDC_TYPE]);
  call('bounds', [tx.object(guardId)], [SUI_TYPE, USDC_TYPE]);
  call('budget', [tx.object(guardId)], [SUI_TYPE, USDC_TYPE]);
  call('committed', [tx.object(guardId)], [SUI_TYPE, USDC_TYPE]);
  tx.moveCall({
    target: `0x0e735f8c93a95722efd73521aca7a7652c0bb71ed1daf41b26dfd7d1ff71f748::pool::get_level2_ticks_from_mid`,
    typeArguments: [SUI_TYPE, USDC_TYPE],
    arguments: [tx.object(DEEPBOOK_POOL_ID), tx.pure.u64(1), tx.object(CLOCK_ID)],
  });
  tx.moveCall({
    target: `0x0e735f8c93a95722efd73521aca7a7652c0bb71ed1daf41b26dfd7d1ff71f748::pool::account_open_orders`,
    typeArguments: [SUI_TYPE, USDC_TYPE],
    arguments: [tx.object(DEEPBOOK_POOL_ID), tx.object(bmId)],
  });

  const sim: any = await client.simulateTransaction({ transaction: tx, include: { commandResults: true } });
  const payload = sim.Transaction ?? sim.FailedTransaction ?? {};
  if (payload.status?.success !== true) {
    throw new Error(`reading the guard failed: ${JSON.stringify(payload.status?.error).slice(0, 200)}`);
  }
  // Per COMMAND, not flattened: the level-2 query returns four vectors from ONE call, so a flat
  // list silently shifts every index after it — which is how the first run of this reader came to
  // read a one-byte bool as a triple and throw on the subarray.
  const perCommand = (sim.commandResults ?? []).map((cr: any) =>
    (cr.returnValues ?? []).map((rv: any) => bytesOf(rv.bcs)),
  );
  const [maker, agent, paused, bounds, budget, committed, book, openOrders] = perCommand;
  const [bidPrices, , askPrices] = book;
  // `bounds` returns a TUPLE, and a tuple arrives as three separate return values rather than one
  // packed blob — the exact thing that made this reader throw on a subarray until the shape was
  // printed instead of reasoned about.
  const [priceMin, priceMax, maxQty] = bounds;

  return {
    guard: {
      guardId,
      maker: hexAddr(maker[0]),
      agent: hexAddr(agent[0]),
      paused: paused[0][0] === 1,
      priceMin: readU64(priceMin),
      priceMax: readU64(priceMax),
      maxQty: readU64(maxQty),
      budget: readU64(budget[0]),
      committed: readU64(committed[0]),
    } satisfies GuardView,
    book: {
      bestBid: readVector(bidPrices, 8)[0] ?? 0n,
      bestAsk: readVector(askPrices, 8)[0] ?? 0n,
      tick: DEEPBOOK_TICK_SIZE,
    },
    open: readVector(openOrders[0], 16).map((orderId): OpenOrder => ({
      orderId,
      // A pass does not read each order's price, so every open order is treated as possibly
      // off-ladder: the plan cancels the ones it cannot match. A fuller runner would read them.
      price: -1n,
      isBid: true,
    })),
  };
}

/** The key that holds the seat. Nothing else may place an order for this guard. */
async function signerForSeat(agent: string) {
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');
  for (const name of ['SUI_SECRET_KEY', 'AGENT_SECRET_KEY'] as const) {
    const secret = process.env[name];
    if (!secret) continue;
    const kp = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(secret).secretKey);
    if (kp.toSuiAddress().toLowerCase() === agent.toLowerCase()) {
      return { signer: kp, keyName: name };
    }
  }
  throw new Error(`no key holds the seat: the guard's agent is ${agent} and neither SUI_SECRET_KEY `
    + 'nor AGENT_SECRET_KEY signs as it');
}

async function main() {
  const { guard, book, open } = await readState(GUARD, BM);
  const refs: OrderRefs = {
    guard: { objectId: GUARD, initialSharedVersion: await sharedVersionOf(client, GUARD), mutable: true },
    pool: { objectId: DEEPBOOK_POOL_ID, initialSharedVersion: await sharedVersionOf(client, DEEPBOOK_POOL_ID), mutable: true },
    balanceManager: { objectId: BM, initialSharedVersion: await sharedVersionOf(client, BM), mutable: true },
    clock: { objectId: CLOCK_ID, initialSharedVersion: await sharedVersionOf(client, CLOCK_ID), mutable: false },
  };

  const plan = planGrid({
    guard, book, open, operator: guard.agent, levels: LEVELS, quantity: QUANTITY, side: SIDE,
  });

  if (plan.refused !== null) {
    console.log(JSON.stringify({
      mode: EXECUTE ? 'execute' : 'dry-run', step: 'run-grid', refused: plan.refused,
      guard: { paused: guard.paused, committed: guard.committed.toString(), budget: guard.budget.toString() },
      book: { bestBid: book.bestBid.toString(), bestAsk: book.bestAsk.toString() },
    }, null, 2));
    return;
  }

  // A RUNNER'S pass is only worth submitting when it changes something.
  if (plan.place.length === 0 && plan.cancel.length === 0) {
    console.log(JSON.stringify({
      mode: EXECUTE ? 'execute' : 'dry-run', step: 'run-grid',
      note: 'the ladder is already as it should be; nothing to do',
      resting: open.length,
    }, null, 2));
    return;
  }

  // Cancels first, then placements — one transaction, so a pass is atomic. This is also the
  // experiment the project has been carrying: several `&mut Pool` commands in one PTB.
  const tx = new Transaction();
  for (const orderId of plan.cancel) cancelTx(tx, refs, orderId);
  for (const level of plan.place) {
    const call = {
      clientOrderId: BigInt(Date.now()),
      orderType: 3, // POST_ONLY: a grid level must REST, never cross
      price: level.price,
      quantity: level.quantity,
    };
    // Which side it rests on is decided by what the account is funded in, which is why the plan
    // carries its own side rather than the caller assuming one.
    if (plan.side === 'ask') sellTx(tx, refs, call);
    else buyTx(tx, refs, call);
  }

  const { signer, keyName } = await signerForSeat(guard.agent);
  tx.setSender(guard.agent);

  // The build RESOLVES, which simulates — so a transaction that cannot execute throws HERE rather
  // than at submission. That is the useful place for it, provided it is reported as a refusal
  // instead of a stack trace: a runner that dies on an empty account reads as broken rather than
  // as poor, and the difference matters when the same code runs unattended over many accounts.
  let bytes: Uint8Array;
  try {
    bytes = await tx.build({ client });
  } catch (e) {
    console.log(JSON.stringify({
      mode: EXECUTE ? 'execute' : 'dry-run', step: 'run-grid',
      refused: `the transaction would not execute: ${String((e as Error).message).slice(0, 240)}`,
      would: { cancel: plan.cancel.length, place: plan.place.length },
      account: { guard: GUARD, balanceManager: BM },
      hint: 'an order is paid out of the BalanceManager, not the wallet — a ladder needs that side '
        + 'funded before it can rest',
    }, null, 2));
    process.exit(1);
  }
  if (!EXECUTE) {
    const sim: any = await client.simulateTransaction({ transaction: bytes });
    const payload = sim.Transaction ?? sim.FailedTransaction ?? {};
    console.log(JSON.stringify({
      mode: 'dry-run', step: 'run-grid',
      ok: payload.status?.success === true,
      status: payload.status ?? null,
      would: { cancel: plan.cancel.length, place: plan.place.length },
      levels: plan.place.map((l) => l.price.toString()),
      inOneTransaction: plan.cancel.length + plan.place.length,
      key: keyName,
      note: 'no key used to sign — a simulation checks the caller, so this proves the gate passes',
    }, null, 2));
    if (payload.status?.success !== true) process.exit(1);
    return;
  }

  const sent: any = await client.signAndExecuteTransaction({ transaction: bytes, signer });
  const result: any = sent?.Transaction ?? sent?.FailedTransaction ?? {};
  console.log(JSON.stringify({
    mode: 'executed', step: 'run-grid',
    digest: result.digest ?? null,
    status: result.status ?? null,
    cancelled: plan.cancel.length,
    placed: plan.place.length,
    key: keyName,
  }, null, 2));

  // Read the result back rather than assuming: a submitted transaction and a ladder that is
  // actually resting are two different claims, which is the whole lesson of this project's NOTES.
  const after = await readState(GUARD, BM);
  console.log(JSON.stringify({
    step: 'run-grid:after',
    resting: after.open.length,
    committed: after.guard.committed.toString(),
  }, null, 2));
}

await main();
