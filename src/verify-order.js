/*
 * Checks for the settled-retry helper.
 *
 * It guards a real mainnet failure — a burn built before the settlement was readable — and
 * it is a loop with a bound, so "it looks right" is not enough. The failure modes that
 * matter are the ones a happy-path run would never show: retrying something it should not,
 * and never giving up.
 *
 * Run: node src/verify-order.js
 */
import { buildWithSettledRetry } from './settled-retry.js';

let failed = 0;
const check = (label, ok, detail) => {
  if (ok) {
    console.log(`ok    ${label}`);
  } else {
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log(`      ${detail}`);
    failed++;
  }
};

/** A sleep that records instead of waiting, so the checks are instant. */
function sleeper() {
  const calls = [];
  return { calls, sleep: (ms) => { calls.push(ms); return Promise.resolve(); } };
}

// 1. A build that works is not retried, and nothing sleeps.
{
  const { calls, sleep } = sleeper();
  let builds = 0;
  const bytes = await buildWithSettledRetry(async () => { builds++; return 'bytes'; }, { sleep });
  check('a successful build returns immediately', bytes === 'bytes' && builds === 1,
    `builds=${builds}`);
  check('a successful build never sleeps', calls.length === 0, `sleeps=${calls.length}`);
}

// 2. ENotSettled is waited out, and the SECOND attempt is what succeeds.
{
  const { calls, sleep } = sleeper();
  let builds = 0;
  const bytes = await buildWithSettledRetry(async () => {
    builds++;
    if (builds < 2) throw new Error("MoveAbort ... 'ENotSettled': order has not been settled");
    return 'bytes';
  }, { sleep });
  check('ENotSettled is retried until it succeeds', bytes === 'bytes' && builds === 2,
    `builds=${builds}`);
  check('the retry waited before trying again', calls.length === 1, `sleeps=${calls.length}`);
}

// 3. The message variant without the error name still matches — the abort text and the
//    error name arrive in different shapes depending on where the failure is raised.
{
  const { sleep } = sleeper();
  let builds = 0;
  const bytes = await buildWithSettledRetry(async () => {
    builds++;
    if (builds < 2) throw new Error('order has not been settled');
    return 'bytes';
  }, { sleep });
  check('the plain-text form is retried too', bytes === 'bytes' && builds === 2, `builds=${builds}`);
}

// 4. A REAL error is not retried. This is the one that would hide bugs behind a delay.
{
  const { calls, sleep } = sleeper();
  let builds = 0;
  let threw = null;
  try {
    await buildWithSettledRetry(async () => {
      builds++;
      throw new Error('ENotMaker: only the maker may reclaim this order');
    }, { sleep });
  } catch (e) { threw = e; }
  check('a different error is rethrown, not retried', Boolean(threw) && builds === 1,
    `builds=${builds} threw=${threw?.message}`);
  check('a different error does not sleep', calls.length === 0, `sleeps=${calls.length}`);
}

// 5. It GIVES UP. A loop that retried forever would hang the reclaim instead of failing it.
{
  const { calls, sleep } = sleeper();
  let builds = 0;
  let threw = null;
  try {
    await buildWithSettledRetry(async () => {
      builds++;
      throw new Error('ENotSettled');
    }, { attempts: 3, sleep });
  } catch (e) { threw = e; }
  check('it stops after the attempt budget', builds === 3 && Boolean(threw),
    `builds=${builds}`);
  check('it sleeps between attempts but not after the last', calls.length === 2,
    `sleeps=${calls.length}`);
}

console.log(`\n${9 - failed}/9 passed`);
process.exit(failed ? 1 : 0);
