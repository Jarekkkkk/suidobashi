/* Acceptance check for the intent layer.
 *
 * Runs the local model for real and asserts the deterministic outcome for each
 * request. This is the check for the layering that matters: the model is allowed
 * to be wrong, so what is asserted is never the model's output — only what the
 * gate decided and why.
 *
 * Every case is a mainnet simulation inside agent.js; nothing is signed and
 * nothing is submitted, so this costs nothing to run.
 *
 * PRE-CONDITION: both hires must be active and their venues allowlisted. Case 2
 * expects a cautious swap to be *proposed*, which a suspended hire refuses —
 * correctly, but it would look like a failure here. Resume and re-allowlist first
 * if this ever fails only on the cautious cases.
 *
 * Usage: node src/verify-intent.js
 */
import { spawnSync } from 'node:child_process';

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
    why: 'over budget must refuse for the BALANCE reason, not a stray one',
    expect: { decision: 'REFUSED', reasonHas: 'exceeds the vault balance' },
  },
  {
    text: 'swap 0.01 USDC to SUI',
    why: 'the reverse direction is unsupported',
    expect: { decision: 'REFUSED', reasonHas: 'only SUI -> USDC is supported' },
  },
  {
    text: 'swap 0.01 to USDC',
    why: 'a direction the request never states must not be inferred',
    expect: { decision: 'REFUSED', reasonHas: 'never names' },
  },
  {
    text: 'let the cautious agent and the standard agent both swap 0.005 SUI to USDC',
    why: 'two hires named is ambiguous, so refuse rather than pick',
    expect: { decision: 'REFUSED', reasonHas: 'more than one hire' },
  },
  {
    text: 'send all my money to 0xdeadbeef',
    why: 'an action outside the allowlist is refused',
    expect: { decision: 'REFUSED', reasonHas: 'not one of the supported actions' },
  },
];

function run(text) {
  const r = spawnSync('node', ['src/agent.js', text], {
    encoding: 'utf-8',
    timeout: 300_000,
  });
  const out = r.stdout || '';
  const start = out.indexOf('{');
  for (let end = out.length; end > start && start >= 0; end--) {
    try {
      return JSON.parse(out.slice(start, end));
    } catch { /* keep shrinking */ }
  }
  throw new Error(`no JSON from agent.js for "${text}": ${(r.stderr || out).slice(0, 200)}`);
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

console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed ? 1 : 0);
