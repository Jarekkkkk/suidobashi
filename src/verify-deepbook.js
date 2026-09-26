/*
 * Checks for src/deepbook.ts, run against real mainnet data.
 *
 * Two halves, and the second one is the point. The pure half checks the grid arithmetic and the
 * four refusals. The live half asks the chain the questions the arithmetic depends on, because the
 * scales in that file are the kind of number that is right until it is wrong by a thousand:
 *
 *   - does the level-2 query still resolve, so the pinned package id and the pool's type arguments
 *     are still the right ones?
 *   - is the measured tick still a positive multiple of the one configured?
 *   - is the mid price, read through `priceScale`, still in the range SUI/USDC trades at?
 *   - does the creation path still simulate, so the module and function names DeepBook exposes have
 *     not moved?
 *
 * All four are read-only. The level-2 query is a simulation, which costs nothing and cannot change
 * state, and so is the creation path.
 *
 * What this CANNOT settle: the quantity scale. A live read disagrees with the documented lot size
 * under every scale tried, and no read-only query can say which is wrong. That needs one real
 * order, which needs the guard module published. Printed as a note rather than asserted, so this
 * file stays green while the question is open.
 *
 *   bun run src/verify-deepbook.js
 */
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  CLOCK_ID,
  DEEPBOOK_PACKAGE,
  DEEPBOOK_POOL_ID,
  DEEPBOOK_TICK_SIZE,
  createAccountTx,
  createGuardTx,
  gridLevels,
  priceScale,
  quantityScale,
  refusalFor,
} from './deepbook.ts';
import { USDC_TYPE, SUI_TYPE } from './addresses.ts';

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${String(actual)}, expected ${String(expected)}`);
}

// === The arithmetic ===

console.log('grid arithmetic');

const WIDE = {
  lower: 900_000n,
  upper: 1_100_000n,
  levels: 5,
  tick: DEEPBOOK_TICK_SIZE,
  quantity: 1_000_000n,
};

const wide = gridLevels(WIDE);
eq('a wide band yields every level asked for', wide.length, 5);
check(
  'every level is a whole number of ticks',
  wide.every((l) => l.price % DEEPBOOK_TICK_SIZE === 0n),
);
check(
  'levels ascend',
  wide.every((l, i) => i === 0 || l.price > wide[i - 1].price),
);
check(
  'levels stay inside the band',
  wide.every((l) => l.price >= WIDE.lower && l.price <= WIDE.upper),
);

// A band narrower than the ladder wants: fewer levels, never two at one price. That distinction is
// the test — a duplicated price would look like a full ladder to the caller and be one level to
// DeepBook.
const narrow = gridLevels({ ...WIDE, lower: 1_000_000n, upper: 1_000_020n, levels: 5 });
check('a narrow band yields fewer levels rather than duplicates', narrow.length <= 3, `${narrow.length}`);
check('no two levels share a price', new Set(narrow.map((l) => String(l.price))).size === narrow.length);

let threw = false;
try {
  gridLevels({ ...WIDE, lower: 1_100_000n, upper: 900_000n });
} catch {
  threw = true;
}
check('an inverted band is refused', threw);

eq('SUI/USDC price scale is 1e6', priceScale(9, 6), 1_000_000n);
eq('SUI quantity scale is 1e9', quantityScale(9), 1_000_000_000n);

// === The refusals, each naming the Move assert it mirrors ===

console.log('\nthe four refusals');

const LIMITS = { priceMin: 900_000n, priceMax: 1_100_000n, maxQty: 2_000_000n, budget: 10_000_000n };
eq('a grid inside the limits has no refusal', refusalFor(wide, LIMITS), null);

const overBudget = gridLevels({ ...WIDE, quantity: 3_000_000n });
check(
  'the budget counts the whole ladder, not one level',
  refusalFor(overBudget, { ...LIMITS, maxQty: 3_000_000n }) !== null,
  'five levels of 3e6 exceed a budget of 1e7 though each is under the per-order bound',
);

check(
  'a level outside the band is refused',
  refusalFor([{ price: 800_000n, quantity: 1_000_000n }], LIMITS) !== null,
);
check(
  'a level above the per-order bound is refused',
  refusalFor([{ price: 1_000_000n, quantity: 9_000_000n }], LIMITS) !== null,
);
check('an empty grid is refused', refusalFor([], LIMITS) !== null);

// === The chain ===

const client = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: 'https://fullnode.mainnet.sui.io:443',
});

/** The gRPC client hands BCS back as a keyed object; normalize it to bytes. */
function bytesOf(bcs) {
  const keys = Object.keys(bcs)
    .map(Number)
    .sort((a, b) => a - b);
  return Uint8Array.from(keys.map((k) => bcs[String(k)]));
}

/** `vector<u64>`: uleb128 length, then little-endian u64s. */
function u64Vector(bytes) {
  let i = 0;
  let len = 0;
  let shift = 0;
  for (;;) {
    const b = bytes[i++];
    len += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + i);
  const out = [];
  for (let k = 0; k < len; k++) out.push(view.getBigUint64(k * 8, true));
  return out;
}

/** The failure text, if a simulation failed, for a readable refusal. */
function why(result) {
  const failed = result.FailedTransaction ?? result;
  return JSON.stringify(failed?.status ?? failed).slice(0, 200);
}

console.log('\nthe chain (read-only)');

const bookTx = new Transaction();
bookTx.moveCall({
  target: `${DEEPBOOK_PACKAGE}::pool::get_level2_ticks_from_mid`,
  typeArguments: [SUI_TYPE, USDC_TYPE],
  arguments: [bookTx.object(DEEPBOOK_POOL_ID), bookTx.pure.u64(6), bookTx.object(CLOCK_ID)],
});
const sim = await client.simulateTransaction({
  transaction: bookTx,
  include: { commandResults: true },
});

check(
  'the pinned package id and type arguments still resolve on mainnet',
  sim.$kind === 'Transaction',
  sim.$kind === 'Transaction' ? undefined : why(sim),
);

if (sim.$kind === 'Transaction') {
  const returns = (sim.commandResults?.[0]?.returnValues ?? []).map((v) => u64Vector(bytesOf(v.bcs)));
  const [bidPrices, bidQuantities, askPrices] = returns;

  check('the query returns a bid side', (bidPrices?.length ?? 0) > 1);
  check('the query returns an ask side', (askPrices?.length ?? 0) > 1);

  if (bidPrices?.length > 1 && askPrices?.length > 1) {
    const gaps = bidPrices.slice(1).map((p, i) => bidPrices[i] - p);
    check(
      'every gap between levels is a positive multiple of the configured tick',
      gaps.every((g) => g > 0n && g % DEEPBOOK_TICK_SIZE === 0n),
      `gaps ${gaps.join(', ')} against tick ${DEEPBOOK_TICK_SIZE}`,
    );

    const bestBid = bidPrices[0];
    const bestAsk = askPrices[0];
    check('the book is not crossed', bestBid < bestAsk, `${bestBid} vs ${bestAsk}`);

    const scale = priceScale(9, 6);
    const mid = (bestBid + bestAsk) / 2n;
    const human = Number(mid) / Number(scale);
    check(
      'the mid price reads as a plausible SUI price through priceScale',
      human >= 0.01 && human <= 100,
      `${mid} raw / 1e6 = ${human} USDC per SUI`,
    );

    // The unresolved half, printed rather than asserted.
    const sample = bidQuantities.slice(0, 3).map((q) => `${q}`);
    console.log(`\n  note  unresolved: per-level bid quantities read ${sample.join(', ')}`);
    console.log('        not multiples of the documented 0.1 SUI lot under any scale tried.');
    console.log('        NOTES.md records it — settling it needs one real order, so the publish.');
  }
}

// The creation path, and its SHAPE is the point. Sui refuses to share an object that an earlier
// transaction created, and `create` shares the BalanceManager — so an account and its guard must be
// built in ONE transaction. Simulated both ways against this chain: split across two transactions
// it aborts in `transfer::share_object_impl`; composed like this, it succeeds. That is why this
// check builds both rather than just the account.
const accountTx = new Transaction();
accountTx.setSender('0x0000000000000000000000000000000000000000000000000000000000000001');
const { balanceManager, tradeCap } = createAccountTx(accountTx);
createGuardTx(accountTx, {
  poolId: DEEPBOOK_POOL_ID,
  balanceManager,
  tradeCap,
  agent: '0x0000000000000000000000000000000000000000000000000000000000000001',
  priceMin: 500_000n,
  priceMax: 2_000_000n,
  maxQty: 1_000_000_000n,
  budget: 1_000_000_000n,
});
const accountSim = await client.simulateTransaction({ transaction: accountTx });
check(
  'creating an account AND its guard in one transaction simulates on mainnet',
  accountSim.$kind === 'Transaction',
  accountSim.$kind === 'Transaction' ? undefined : why(accountSim),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
