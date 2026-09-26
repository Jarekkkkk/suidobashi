/* Acceptance check for the intent layer.
 *
 * Runs the local model for real and asserts the deterministic outcome for each
 * request. This is the check for the layering that matters: the model is allowed
 * to be wrong, so what is asserted is never the model's output — only what the
 * gate decided and why.
 *
 * Every case is a mainnet simulation inside agent.ts; nothing is signed and
 * nothing is submitted, so this costs nothing to run.
 *
 * HERMETIC: the wallet balance is injected rather than read, so the outcome does not
 * depend on how much the maker happens to be holding. That matters because the owner
 * legitimately moves funds around, and the happy-path cases would otherwise fail for a
 * reason that has nothing to do with the gate. The gate's balance check is advisory —
 * the chain enforces the real balance — so injecting it cannot hide a fund-safety problem.
 *
 * It reads the SENDER's balance, not the vault's: escrowed orders do not touch the vault,
 * so the vault was the wrong pool of money to compare against.
 *
 * STILL STATE-DEPENDENT, and unavoidably so: both hires must be active and their
 * venues allowlisted, because that state is read from the chain. Case 2 expects a
 * cautious swap to be *proposed*, which a suspended hire refuses -- correctly, but it
 * would look like a failure here. Resume and re-allowlist first if this ever fails
 * only on the cautious cases.
 *
 * Usage: node src/verify-intent.js
 */
import { spawnSync } from 'node:child_process';
// Read the sources the direction check compares, rather than asserting a list.
import fs from 'node:fs';

/** The same shape the other suites use, for the checks below that are not one of the cases. */
let sideChecks = 0;
function check(label, ok, detail) {
  sideChecks++;
  if (ok) { console.log(`ok    ${label}`); return; }
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`      ${detail}`);
  failed++;
}
import { installTalent, listTalents } from './db.ts';
import { talentFor } from './talents.ts';
import {
  DIRECTIONS, POOL_TYPE_ARGS, USDC_TYPE,
  directionForCoinType, orderCoinType,
} from './addresses.ts';

// ENSURE WHAT THESE CASES EXERCISE IS INSTALLED.
//
// Swap became a talent rather than built-in behaviour, so the agent refuses it until something
// provides it. That is the design working — and it means these cases were testing a state nobody
// had set up. Installing it here is part of what the check means, not a workaround: it asserts
// that the talent's actions are available, which is the thing every case below depends on.
const swapTalent = talentFor('http://127.0.0.1:8790');
if (swapTalent) installTalent(swapTalent.id, swapTalent.name, swapTalent, null);
if (!listTalents().some((t) => t.id === 'http://127.0.0.1:8790')) {
  console.error('could not install the swap talent — the cases below would all fail for the wrong reason');
  process.exit(1);
}

/** 0.1 SUI. Above every happy-path amount below, below the deliberate over-budget one. */
const INJECTED_WALLET_MIST = '100000000';

/**
 * 0.01 SUI — the grant, deliberately SMALLER than the injected wallet.
 *
 * That gap is the point: it lets a case fail the ALLOWANCE while passing the balance, so the two
 * refusals cannot be confused for each other. With them equal, a broken allowance check would
 * still look right, because the balance check would refuse the same requests first.
 */
const INJECTED_ALLOWANCE_MIST = '10000000';

const CASES = [
  {
    text: 'swap 0.005 SUI to USDC',
    why: 'the plainest request must work, on the default hire',
    expect: { decision: 'PROPOSED', hire: 'standard' },
  },
  {
    text: 'let the cautious agent swap 0.005 SUI to USDC',
    why: 'naming a hire routes to that hire, not the default',
    expect: { decision: 'PROPOSED', hire: 'cautious' },
  },
  {
    text: 'let the standard agent swap 0.005 SUI to USDC',
    why: 'naming the default explicitly still works',
    expect: { decision: 'PROPOSED', hire: 'standard' },
  },
  {
    text: 'swap 5 SUI to USDC',
    why: 'over the balance must refuse for the BALANCE reason, not a stray one',
    expect: { decision: 'REFUSED', reasonHas: 'exceeds your wallet balance' },
  },
  {
    text: 'swap 0.05 SUI to USDC',
    why: 'over the GRANT but under the balance — must refuse for the allowance, naming both figures',
    expect: { decision: 'REFUSED', reasonHas: 'more than the 0.01 SUI your grant allows' },
  },
  {
    text: 'swap 0.01 USDC to SUI',
    why: 'the reverse direction is now EXECUTABLE, so it proposes — this case used to assert the '
      + 'opposite, and it is inverted rather than deleted so the change is visible',
    expect: { decision: 'PROPOSED' },
  },
  {
    // THE BALANCE CHECK IN THE NEW COIN. The injected figures are in whatever coin is being
    // checked, so for this case they are USDC: a 100 USDC wallet and a 10 USDC grant. An amount
    // above the wallet must refuse for the BALANCE and name USDC — before the direction existed
    // this path divided by 1e9 and said "SUI" whatever the coin was.
    text: 'swap 200 USDC to SUI',
    why: 'the balance refusal must work, and read correctly, in the new direction',
    expect: { decision: 'REFUSED', reasonHas: 'USDC exceeds your wallet balance' },
  },
  {
    text: 'swap 0.01 to USDC',
    why: 'a direction the request never states must not be inferred',
    expect: { decision: 'REFUSED', reasonHas: 'never names' },
  },
  {
    text: 'let the cautious agent and the standard agent both swap 0.005 SUI to USDC',
    why: 'two hires named is ambiguous, so ASK rather than pick — and rather than refuse',
    expect: { decision: 'ASKING', options: ['standard', 'cautious'] },
  },
  {
    text: 'send all my money to 0xdeadbeef',
    why: 'an action outside the allowlist is refused',
    expect: { decision: 'REFUSED', reasonHas: 'not one of the supported actions' },
  },
];

function run(text) {
  const r = spawnSync('bun', ['src/agent.ts', text], {
    encoding: 'utf-8',
    timeout: 300_000,
    env: { ...process.env, AGENT_WALLET_BALANCE_MIST: INJECTED_WALLET_MIST, AGENT_ALLOWANCE_MIST: INJECTED_ALLOWANCE_MIST },
  });  const out = r.stdout || '';
  const start = out.indexOf('{');
  for (let end = out.length; end > start && start >= 0; end--) {
    try {
      return JSON.parse(out.slice(start, end));
    } catch { /* keep shrinking */ }
  }
  throw new Error(`no JSON from agent.ts for "${text}": ${(r.stderr || out).slice(0, 200)}`);
}

let failed = 0;
console.log('');
for (const c of CASES) {
  let got;
  try {
    got = run(c.text);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${c.text}`);
    console.log(`      ${e.message}`);
    continue;
  }

  const hire = (got.hire || {}).name;
  const reason = (got.validation || {}).reason || '';
  const problems = [];

  if (c.expect.options) {
    const opts = got.options || [];
    const missing = c.expect.options.filter((o) => !opts.includes(o));
    if (missing.length) {
      problems.push(`options missing ${missing.join(', ')} (got ${opts.join(', ') || 'none'})`);
    }
  }

  // THE TEMPLATE IS WHAT MAKES ANSWERING POSSIBLE, so it is worth asserting rather than
  // assuming. Re-sending the original request would name two hires again and ask the same
  // question forever; the template is the request rebuilt from the parsed intent, which by
  // construction has no hire name in it. If one ever leaks in, the ask becomes a loop — and a
  // loop is much harder to notice than a wrong answer.
  if (got.decision === 'ASKING') {
    const t = String(got.template || '').toLowerCase();
    // `includes` rather than a word-boundary regex: the names are fixed, and neither is a
    // substring of any other word this could contain. A regex built from a variable is also the
    // kind of thing that is safe today and a hole the moment the variable stops being fixed.
    const named = ['standard', 'cautious'].filter((n) => t.includes(n));
    if (!t) problems.push('no template, so the question cannot be answered');
    else if (named.length) {
      problems.push(`template still names ${named.join(', ')} — answering it would ask again`);
    }
  }

  if (got.decision !== c.expect.decision) {
    problems.push(`decision ${got.decision} != ${c.expect.decision}`);
  }
  if (c.expect.hire && hire !== c.expect.hire) {
    problems.push(`hire ${hire} != ${c.expect.hire}`);
  }
  if (c.expect.reasonHas && !reason.includes(c.expect.reasonHas)) {
    problems.push(`reason "${reason}" lacks "${c.expect.reasonHas}"`);
  }
  // A refusal must always explain itself — an unexplained refusal is a bug.
  if (got.decision === 'REFUSED' && !reason) problems.push('refused with no reason');

  if (problems.length) {
    failed++;
    console.log(`FAIL  ${c.text}`);
    for (const p of problems) console.log(`      ${p}`);
  } else {
    console.log(`ok    ${c.text}`);
    console.log(`      ${got.decision}${hire ? ` via ${hire}` : ''}${reason ? ` — ${reason.slice(0, 88)}` : ''}`);
  }
}

// 9. THE REAL READ PATH, without an injected balance.
//
// The injection makes every case above hermetic, which is right — but it also means a
// bug in the un-injected path is invisible to them. This caught exactly that: a missing
// import made every real run die with "DEPLOYER is not defined" while the suite stayed
// green, because the injected value made the broken function return before reaching the
// missing name.
//
// It asserts only that the agent PRODUCED a verdict, not what the verdict is — the real
// balance varies, and the point here is that the path runs at all.
let realVerdict = null;
try {
  const r = spawnSync('bun', ['src/agent.ts', 'swap 0.005 SUI to USDC'], {
    encoding: 'utf-8',
    timeout: 300_000,
    // The override is DELETED, not set to undefined: spawnSync stringifies env values,
    // so `{ KEY: undefined }` arrives as the literal string "undefined" and BigInt would
    // throw — failing this check for a reason that has nothing to do with what it tests.
    env: (({ AGENT_WALLET_BALANCE_MIST: _drop, AGENT_ALLOWANCE_MIST: _drop2, ...rest }) => rest)(process.env),
  });
  const out = r.stdout || '';
  const start = out.indexOf('{');
  for (let end = out.length; end > start && start >= 0; end--) {
    try { realVerdict = JSON.parse(out.slice(start, end)); break; } catch { /* keep shrinking */ }
  }
  if (!realVerdict) {
    console.log('FAIL  the agent runs without an injected balance');
    console.log(`      no verdict — stderr: ${(r.stderr || '').trim().slice(0, 160)}`);
    failed++;
  }
} catch (e) {
  console.log('FAIL  the agent runs without an injected balance');
  console.log(`      ${e.message}`);
  failed++;
}

// THE GATE'S DIRECTIONS MUST MATCH WHAT THE ORDER PATH CAN DO, AND WHAT THE FILLER SETTLES.
//
// The talent offered "Swap SUI for USDC, or USDC for SUI" and the gate refused the second — both
// were reading from the same facts and only one of them was right. `settle_a2b` and `settle_b2a`
// both exist on chain, so both directions LOOK reachable; what makes one of them real is whether
// anything escrows that coin and anything settles that entry point.
//
// ASSERTED AS A RELATIONSHIP OVER THE TABLE, not as expected strings. The previous version of this
// block grepped `SUPPORTED_FROM` and `SUPPORTED_TO`, which stopped existing the moment a second
// direction arrived — so it would have passed while checking nothing. A check that names a shape
// fails on correct code, and this project has now paid for that five times.
{
  const orderSrc = fs.readFileSync(new URL('./create-order.ts', import.meta.url), 'utf-8');
  const fillerSrc = fs.readFileSync(new URL('./mcp-server.ts', import.meta.url), 'utf-8');
  const gateSrc = fs.readFileSync(new URL('./agent.ts', import.meta.url), 'utf-8');

  // SIDES COME FROM THE POOL'S OWN TYPE ARGUMENTS: A is the first, B the second. An order holding
  // side A settles a2b, one holding B settles b2a. Derived rather than written out, so a reversed
  // type-argument list is caught here instead of on chain — where it would swap the wrong way.
  const [A, B] = POOL_TYPE_ARGS;
  const entryPoint = (coin) => (coin === A ? 'settle_a2b' : coin === B ? 'settle_b2a' : null);

  check('every direction settles through the entry point its input coin sits on',
    Object.values(DIRECTIONS).every((d) => d.settle === entryPoint(d.in.type)),
    Object.entries(DIRECTIONS).map(([n, d]) => `${n} -> ${d.settle}`).join(', '));

  check('each direction\'s output is the other direction\'s input',
    DIRECTIONS['SUI->USDC'].out.type === DIRECTIONS['USDC->SUI'].in.type
    && DIRECTIONS['USDC->SUI'].out.type === DIRECTIONS['SUI->USDC'].in.type,
    'the table does not describe one pair traded two ways');

  // ONE FILLER REACHES BOTH ENTRY POINTS, and it works out which from the order itself. That is
  // what was missing while `settle_a2b` existed on chain and nothing called it: the entry point has
  // to be selected, not written down per script.
  check('the filler chooses the entry point from the order rather than being told',
    fillerSrc.includes('directionForCoinType') && fillerSrc.includes('order::${seen.dir.settle}'),
    'the filler does not read the direction off the order');
  check('the filler passes the pool type arguments in the pool\'s own order',
    fillerSrc.includes('typeArguments: [...POOL_TYPE_ARGS]'),
    'written out per direction, which is how a2b gets called with its arguments reversed');

  check('the gate takes its directions from the same table',
    gateSrc.includes('Object.entries(DIRECTIONS)'),
    'the gate keeps its own list of directions, which will drift from the table');
  check('the order escrows the direction\'s input coin',
    orderSrc.includes('type: DIR.in.type') && orderSrc.includes('typeArguments: [DIR.in.type]'),
    'the escrow names a literal coin instead of the direction\'s');

  // THE LIMIT MUST SIT ON THE SIDE EACH DIRECTION HEADS — and this is the one the POOL enforces,
  // not us. `assert_within_bps` compares MAGNITUDES and is deliberately symmetric about the side,
  // so a limit on the wrong side passes our own bound and is then rejected by
  // `flash_swap_internal` before any swap happens. That is how every USDC -> SUI order came to
  // abort in the pool and expire unfilled while SUI -> USDC filled.
  check('the price limit sits on the side each direction heads',
    Object.values(DIRECTIONS).every((d) => d.limitSign === (d.settle === 'settle_b2a' ? 1 : -1)),
    Object.entries(DIRECTIONS).map(([n, d]) => `${n}: ${d.settle} sign ${d.limitSign}`).join(', '));
  check('both scripts take the sign from the direction rather than a literal',
    fillerSrc.includes('limitSign')
    && fs.readFileSync(new URL('./settle-order.ts', import.meta.url), 'utf-8').includes('limitSign'),
    'a script still hardcodes which side the limit goes');

  // ── The parsing that decides a2b from b2a ──────────────────────────────────
  //
  // This is the one piece of the filler's new logic that no transaction can exercise until a USDC
  // order exists on chain, so it is pinned here instead. It reads an ORDER OBJECT TYPE, which is
  // the only place an order's coin appears: a `Balance<T>` field arrives in `json` as a number.
  {
    const suiOrder = '0x2441fb74d7684f43019fdabf27d6de24dc8e42826ddd86ba07bc21aded80c014'
      + '::order::Order<0x2::sui::SUI>';
    const usdcOrder = '0x2441fb74d7684f43019fdabf27d6de24dc8e42826ddd86ba07bc21aded80c014'
      + `::order::Order<${USDC_TYPE}>`;

    check('the coin is read off an order object type',
      orderCoinType(suiOrder) === '0x2::sui::SUI' && orderCoinType(usdcOrder) === USDC_TYPE,
      `${orderCoinType(suiOrder)} / ${orderCoinType(usdcOrder)}`);

    // THE SIDE, which is what picks the entry point. SUI is B, USDC is A — from the pool.
    check('each order type maps to the direction its coin is the input of',
      directionForCoinType(orderCoinType(suiOrder)) === 'SUI->USDC'
      && directionForCoinType(orderCoinType(usdcOrder)) === 'USDC->SUI',
      `${directionForCoinType(orderCoinType(suiOrder))} / ${directionForCoinType(orderCoinType(usdcOrder))}`);

    // And the entry point that direction names is the side that coin sits on. `?.` rather than a
    // bare lookup: if the mapping ever breaks, this should FAIL one check rather than throw and
    // take the whole suite down with it.
    check('and to the matching settle entry point',
      DIRECTIONS[directionForCoinType(orderCoinType(usdcOrder)) ?? '']?.settle === 'settle_a2b'
      && DIRECTIONS[directionForCoinType(orderCoinType(suiOrder)) ?? '']?.settle === 'settle_b2a');

    // FAIL-CLOSED. An order of some other coin is refused rather than defaulted to a direction,
    // which on a wrong guess would swap the wrong way.
    check('an order of an unknown coin maps to no direction',
      orderCoinType('0x2::order::Order<0x2::coin::COIN>') === '0x2::coin::COIN'
      && directionForCoinType('0x2::coin::COIN') === null
      && directionForCoinType('') === null);
  }
}

const total = CASES.length + 1 + sideChecks;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
