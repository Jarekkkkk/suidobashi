/*
 * Checks for src/runner.ts — the example operator's decision half.
 *
 * No chain, no key, no guard: the policy is a pure function of the guard's state, the book, and
 * what is already resting, so all of it can be checked here. That is the reason the runner is split
 * at all — the submission half cannot be tested until the guard module is published, and this half
 * should not have to wait for it.
 *
 * The property worth the most attention is idempotence. A runner is a loop: it wakes, looks, and
 * acts, over and over, and a guard's budget counts every order the agent ever asks for. A runner
 * that re-places its own ladder on each pass burns that budget on orders that already exist, so
 * "already on the ladder, therefore place nothing" is load-bearing rather than tidy.
 *
 *   bun run src/verify-runner.js
 */
import { planGrid } from './runner.ts';
import { DEEPBOOK_TICK_SIZE } from './deepbook.ts';

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
  check(name, String(actual) === String(expected), `got ${actual}, expected ${expected}`);
}

const OPERATOR = '0xAB3Fc76800000000000000000000000000000000000000000000000000000000';
const OTHER = '0x199ca42b00000000000000000000000000000000000000000000000000000000';

/** A guard on the ladder's band, unpaused, held by OPERATOR, with room to spare. */
function guard(over = {}) {
  return {
    guardId: '0xguard',
    maker: '0xmaker',
    agent: OPERATOR,
    paused: false,
    priceMin: 900_000n,
    priceMax: 1_100_000n,
    maxQty: 2_000_000n,
    budget: 10_000_000n,
    committed: 0n,
    ...over,
  };
}

const BOOK = { bestBid: 1_000_000n, bestAsk: 1_000_050n, tick: DEEPBOOK_TICK_SIZE };
const LADDER = ['900000', '925000', '950000', '975000', '1000000'];

function plan(over = {}) {
  return planGrid({
    guard: guard(over.guard),
    book: over.book ?? BOOK,
    open: over.open ?? [],
    operator: over.operator ?? OPERATOR,
    levels: over.levels ?? 5,
    quantity: over.quantity ?? 1_000_000n,
  });
}

// === Stillness: the several ways a runner stands down ===

console.log('standing down');

let p = plan({ guard: { paused: true } });
eq('a paused guard is quoted nothing', p.place.length, 0);
check('and the reason names the pause', /paused/.test(p.refused ?? ''), p.refused);

p = plan({ operator: OTHER });
eq('a guard whose seat this runner does not hold is left alone', p.place.length, 0);
check('and the reason says so', /seat/.test(p.refused ?? ''), p.refused);

p = plan({ operator: OPERATOR.toLowerCase() });
check('the seat is matched without regard to hex case', p.refused === null, p.refused);

// The market has fallen out of the band. A runner that crashed here would be a runner that dies on
// a price move, which is the one moment it must not.
p = plan({ book: { ...BOOK, bestBid: 800_000n, bestAsk: 800_050n } });
eq('a market below the band places nothing', p.place.length, 0);
check('and says the market is below it', /below the band/.test(p.refused ?? ''), p.refused);

// === The ladder ===

console.log('\nthe ladder');

p = plan();
eq('an empty book gets every level', p.place.length, 5);
eq('and nothing is cancelled', p.cancel.length, 0);
check(
  'the ladder is the expected one',
  p.place.map((l) => String(l.price)).join(',') === LADDER.join(','),
  p.place.map((l) => l.price).join(','),
);
check(
  'every level is a whole number of ticks',
  p.place.every((l) => l.price % DEEPBOOK_TICK_SIZE === 0n),
);

// The never-cross rule. The band here reaches 2e6 and the market is at 1e6, so a ladder that
// respected only the band would quote through the ask — paying taker fees, filling at prices the
// grid never chose, and aborting outright if the order were post-only.
p = plan({ guard: { priceMax: 2_000_000n } });
check(
  'no level reaches the best ask, even when the band does',
  p.place.every((l) => l.price < BOOK.bestAsk),
  `highest ${p.place.at(-1)?.price} against best ask ${BOOK.bestAsk}`,
);
check(
  'and the band still bounds the ladder from below',
  p.place.every((l) => l.price >= 900_000n),
);

// === Idempotence, and the diff against what is resting ===

console.log('\nidempotence and the diff');

const resting = LADDER.map((price, i) => ({ orderId: BigInt(i + 1), price: BigInt(price), isBid: true }));

p = plan({ open: resting });
eq('a ladder already resting places nothing', p.place.length, 0);
eq('and cancels nothing', p.cancel.length, 0);
check('so a second pass is free', p.refused === null);

p = plan({ open: [{ orderId: 9n, price: 933_330n, isBid: true }] });
eq('a stale bid is cancelled', p.cancel.join(','), '9');
eq('while the ladder is still placed', p.place.length, 5);

p = plan({ open: [{ orderId: 7n, price: 1_200_000n, isBid: false }] });
eq('a sell is left alone', p.cancel.length, 0);
check(
  'and does not stop the ladder being placed',
  p.place.length === 5,
  p.place.length,
);

// Half the ladder already resting: only the missing half is asked for, so the budget is charged
// for five levels once rather than five levels per pass.
p = plan({ open: resting.slice(0, 3) });
eq('only the missing levels are placed', p.place.length, 2);
check(
  'and they are the upper ones',
  p.place.map((l) => String(l.price)).join(',') === LADDER.slice(3).join(','),
);

// === The budget, in the maker's terms ===

console.log('\nthe budget');

p = plan({ guard: { committed: 8_000_000n } });
eq('a ladder larger than what is left is refused', p.place.length, 0);
check('and the refusal counts the remainder', /2000000/.test(p.refused ?? ''), p.refused);

p = plan({ guard: { committed: 5_000_000n } });
check('a ladder that exactly fits the remainder is allowed', p.refused === null, p.refused);

// A refused ladder still clears quotes that are no longer wanted: refusing to place is a reason to
// stand down, not a reason to leave stale orders resting on the maker's account.
p = plan({ guard: { committed: 9_000_000n }, open: [{ orderId: 4n, price: 933_330n, isBid: true }] });
eq('a refused ladder still cancels off-ladder bids', p.cancel.join(','), '4');
eq('but places none', p.place.length, 0);

// === The level itself ===

p = plan({ guard: { maxQty: 500_000n } });
eq('a level above the per-order bound is refused', p.place.length, 0);
check('and the refusal is the guard bound', /per-order bound/.test(p.refused ?? ''), p.refused);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
