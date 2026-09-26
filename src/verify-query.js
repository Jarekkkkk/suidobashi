/* Acceptance check for the READ-ONLY path: the query talent, and the grant boundary it tests.
 *
 * WHAT THIS IS FOR. Every previous talent SPENT, so every previous talent went through a hire,
 * an allowance and a venue. The query talent is the first that moves nothing, and the claim it
 * rests on — "a talent that only reads does not need a grant" — was documentation until now. The
 * checks below are what make it a fact about the code:
 *
 *   · the action declares it does not spend, and the SPENDING ones still do (the regression that
 *     matters: making reads exempt must not make anything else exempt)
 *   · the gate PLANS it, and the plan says it went through no hire at all
 *   · fail-closed in both directions — nothing installed means no read, and an unknown action is
 *     treated as spending
 *   · the manifest describes a server that holds no key, has no fill route, and declares no price
 *     it cannot be paid
 *
 * Usage: bun src/verify-query.js
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { MARKETPLACE, actionSpends, serverForAction, talentFor } from './talents.ts';
import { installTalent, listTalents, uninstallTalent } from './db.ts';
import { PRICE_MIST, manifest } from './query-server.ts';

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (ok) { console.log(`ok    ${label}`); return; }
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`      ${detail}`);
  failed++;
}

const QUERY_ID = 'http://127.0.0.1:8791';
const SWAP_ID = 'http://127.0.0.1:8790';
const queryTalent = talentFor(QUERY_ID);
const swapTalent = talentFor(SWAP_ID);

console.log('');

// ── The talent, and which side of the money line each action is on ───────────

check('both talents are in the marketplace', Boolean(queryTalent && swapTalent));
if (!queryTalent || !swapTalent) {
  console.log(`\n0/${total} passed`);
  process.exit(1);
}

check('the read action declares that it does not spend',
  actionSpends([QUERY_ID], 'status') === false,
  `actionSpends said ${actionSpends([QUERY_ID], 'status')}`);

// THE REGRESSION THAT MATTERS. Exempting reads from the grant is only safe if nothing else
// became exempt at the same time, so the spending action is asserted here rather than assumed.
check('the swap action still spends',
  actionSpends([SWAP_ID], 'swap') === true,
  `actionSpends said ${actionSpends([SWAP_ID], 'swap')}`);

check('an action nothing provides is treated as spending (fail-closed)',
  actionSpends([], 'status') === true && actionSpends([QUERY_ID], 'swap') === true);

check('the action is paired with its OWN talent\'s server, and unknown actions have none',
  serverForAction([QUERY_ID], 'status') === QUERY_ID
  && serverForAction([QUERY_ID], 'swap') === null
  && serverForAction([], 'status') === null);

// ── Every offered action must have a plan ────────────────────────────────────
//
// A talent may only offer what the gate can actually build. This is the check the marketplace's
// own comment asked for and did not have: the first swap talent promised BOTH directions while
// the gate refused one, and a talent whose title is the only place a capability lives is a
// promise rather than a feature.
{
  const gate = fs.readFileSync(new URL('./agent.ts', import.meta.url), 'utf-8');
  const offered = MARKETPLACE.flatMap((t) => t.actions.map((a) => a.id));
  const unplannable = offered.filter((id) => !new RegExp(`case '${id}':`).test(gate));
  check('every action a talent offers has a case in the plan',
    unplannable.length === 0,
    `offered but not plannable: ${unplannable.join(', ')}`);
}

// ── The server half: a reader, not a signer ──────────────────────────────────

{
  const src = fs.readFileSync(new URL('./query-server.ts', import.meta.url), 'utf-8');
  for (const [label, pattern, want] of [
    ['the query server holds no key', /AGENT_SECRET_KEY|Keypair|signAndExecuteTransaction/, false],
    ['the query server has no fill route', /\/fill/, false],
    ['the query server never signs anything', /tx\.build|moveCall/, false],
  ]) {
    const found = pattern.test(src);
    check(label, found === want, `pattern ${pattern} ${found ? 'found' : 'not found'}`);
  }
}

// The manifest must not advertise a capability the server does not serve, or a price it cannot
// be paid. Both are the "unbuilt, not forbidden" trap in miniature.
{
  const m = manifest();
  const actionIds = m.actions.map((a) => a.id);
  check('the manifest declares no fill action',
    !actionIds.includes('fill') && m.charges.fills === false,
    `actions: ${actionIds.join(', ')}`);
  check('the manifest declares a route for every action it advertises',
    actionIds.every((id) => typeof m.routes[id] === 'string'),
    `actions ${actionIds.join(', ')} / routes ${Object.keys(m.routes).join(', ')}`);
  check('the manifest is honest about being read-only', m.readOnly === true);
  check('no price is advertised while nothing can pay one',
    PRICE_MIST === 0n && m.actions.every((a) => a.terms.priceMist === '0'),
    `PRICE_MIST=${PRICE_MIST}; prices ${m.actions.map((a) => a.terms.priceMist).join(', ')}`);
  check('a declared price is carried into the terms',
    manifest(1000n).actions.every((a) => a.terms.priceMist === '1000'));
}

// THE TWO HALVES MUST NOT COLLIDE. A manifest lists what the SERVER does and the talent lists what
// the AGENT does; offering the server's half as the agent's was a real bug, and an action that
// appeared on both sides would be the same bug in a new shape.
{
  const clientIds = MARKETPLACE.flatMap((t) => t.actions.map((a) => a.id));
  const serverIds = manifest().actions.map((a) => a.id);
  const shared = clientIds.filter((id) => serverIds.includes(id));
  check('no action appears on both sides of the protocol', shared.length === 0,
    `on both sides: ${shared.join(', ')}`);
}

// ── The gate, for real ───────────────────────────────────────────────────────
//
// One model call. The manifest content does not reach the gate — only the talent's id does — so
// what this exercises is the installed-id set and the plan.
function install() {
  installTalent(queryTalent.id, queryTalent.name, manifest(), null);
}
function run(text) {
  // NO INJECTED BALANCE, and that is itself the point: a read must not depend on wallet state.
  // The swap cases need the injection because they read a balance; this one reads nothing.
  const r = spawnSync('bun', ['src/agent.ts', text], { encoding: 'utf-8', timeout: 300_000 });
  const out = r.stdout || '';
  const start = out.indexOf('{');
  for (let end = out.length; end > start && start >= 0; end--) {
    try { return JSON.parse(out.slice(start, end)); } catch { /* keep shrinking */ }
  }
  throw new Error(`no JSON from agent.ts for "${text}": ${(r.stderr || out).slice(0, 200)}`);
}

const wasInstalled = listTalents().some((t) => t.id === QUERY_ID);
install();
try {
  const read = run('check my balances');
  check('the gate proposes a read',
    read.decision === 'PROPOSED',
    `decision ${read.decision} — ${(read.validation || {}).reason || ''}`);
  check('the plan says it is a read', read.plan?.read === true);
  // THE ASSERTION THAT MATTERS: no hire. Every other action reports one, and a read that reported
  // a hire would mean a grant was consulted for something that cannot spend.
  check('a read goes through no hire at all',
    read.hire === null,
    `hire ${JSON.stringify(read.hire)}`);
  check('no allowance was read for a read', read.allowance === null);
  // The owner is decided by our own code, not named by the page.
  check('the plan names a full owner address',
    /^0x[0-9a-f]{64}$/.test(String(read.plan?.query?.owner ?? '')),
    `owner ${read.plan?.query?.owner}`);
  check('the plan asks for balances', read.plan?.query?.what === 'balances');

  // FAIL-CLOSED. With the talent gone the same request cannot be read, and it must not fall
  // through to anything else. The reason is deliberately not asserted: with `status` out of the
  // schema the model answers something else, and any refusal is the right outcome.
  uninstallTalent(QUERY_ID);
  const without = run('check my balances');
  check('a read is refused when its talent is not installed',
    without.decision === 'REFUSED',
    `decision ${without.decision} — ${(without.validation || {}).reason || ''}`);
} finally {
  // Restore what was there before, rather than assuming: this suite must not silently change
  // which talents the app has installed.
  if (wasInstalled) install(); else uninstallTalent(QUERY_ID);
}

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
