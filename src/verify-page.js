/*
 * One runnable check for the shared web layer: amount parsing, the event vocabulary, and the source
 * relationships the served app depends on.
 *
 * IT USED TO COVER THE OLD PAGE AS WELL — its escaping module (`src/web/markup.js`), the elements it
 * looked up by id, and the markup it found them in. All three went with the page: the React app is
 * bundled, so it neither fetches `markup.js` nor looks anything up by id, and a check for a deleted
 * module is not a check. The name stays because the app is a served page too.
 *
 * src/web/units.ts decides the integer a transaction carries, which is why it is imported here
 * rather than duplicated: what is tested is what the app and the CLI scripts both use.
 *
 *   bun run src/verify-page.js
 */
import fs from 'node:fs';
import { suiToMist, toUnits, usdcToUnits } from './web/units.ts';
import { EVENT_KINDS, SOURCES, TERMINAL_KINDS, event, endingFor } from './web/events.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures += 1;
  console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
};

// 1. Amount conversion. This is the piece that broke silently when the page lived in
//    a template literal (the backslash in its regex was eaten, so every valid amount
//    returned null and the buttons looked dead). It is also the piece that decides
//    what integer a transaction carries, so it gets real cases.
const amounts = [
  ['sui 0.05', suiToMist('0.05'), '50000000'],
  ['sui 1', suiToMist('1'), '1000000000'],
  ['sui 0.6', suiToMist('0.6'), '600000000'],
  ['sui 13.165', suiToMist('13.165'), '13165000000'],
  ['sui 0', suiToMist('0'), '0'],
  ['sui padded', suiToMist(' 0.05 '), '50000000'],
  ['usdc 0.5', usdcToUnits('0.5'), '500000'],
  ['usdc 0.692638', usdcToUnits('0.692638'), '692638'],
  ['usdc 1', usdcToUnits('1'), '1000000'],
];
for (const [name, got, want] of amounts) {
  check(`amount ${name}`, got === want, `got ${got}, want ${want}`);
}

const rejections = [
  ['sui empty', suiToMist('')],
  ['sui letters', suiToMist('abc')],
  ['sui 10 decimals', suiToMist('0.1234567890')],
  ['sui two dots', suiToMist('1.2.3')],
  ['sui negative', suiToMist('-1')],
  ['sui only a dot', suiToMist('.')],
  ['sui trailing dot', suiToMist('1.')],
  ['usdc 7 decimals', usdcToUnits('0.1234567')],
];
for (const [name, got] of rejections) {
  check(`amount rejects ${name}`, got === null, `got ${got}, want null`);
}

// The reason this is integer arithmetic at all: in binary floating point,
// Number('0.05') * 1e9 is 50000000.00000001, and a chain amount must be exact.
check('amounts are exact, not float-derived', suiToMist('0.05') === '50000000',
  `got ${suiToMist('0.05')} (float would give ${Number('0.05') * 1e9})`);
check('6 and 9 decimals are not interchangeable', usdcToUnits('0.5') !== suiToMist('0.5'),
  `both gave ${usdcToUnits('0.5')}`);
check('toUnits honours its decimals argument', toUnits('1', 2) === '100' && toUnits('1', 0) === '1',
  `${toUnits('1', 2)} / ${toUnits('1', 0)}`);

// 2. The pipeline's event vocabulary. Two things here are load-bearing rather than
//     cosmetic: a typo must fail at the point it is written instead of reaching a
//     browser that does not know how to render it, and the wording of the states a flow
//     ENDS in must not describe a working outcome as a failure.
let threw = false;
try { event('not-a-kind', 'chain', 'x'); } catch { threw = true; }
check('an unknown event kind throws', threw, 'a typo should fail where it is written');

threw = false;
try { event('filled', 'not-a-source', 'x'); } catch { threw = true; }
check('an unknown event source throws', threw);

const filled = event('filled', 'chain', 'done', { received: '0.0067 USDC' });
check('a terminal kind is marked terminal', filled.terminal === true);
check('a working kind is not marked terminal',
  event('filling', 'pipeline', 'x').terminal === false);
check('an event carries its source', filled.source === 'chain');

// The vocabulary must be internally consistent: a terminal kind that is not also a
// known kind could never be emitted, so its ending wording would be unreachable.
check('every event kind is a non-empty string',
  EVENT_KINDS.length > 0 && EVENT_KINDS.every((k) => typeof k === 'string' && k.length > 0));
check('every source is a non-empty string',
  SOURCES.length > 0 && SOURCES.every((s) => typeof s === 'string' && s.length > 0));
check('every terminal kind is a known kind',
  TERMINAL_KINDS.every((k) => EVENT_KINDS.includes(k)),
  'a terminal kind outside the vocabulary could never be emitted');

// Every terminal kind needs wording, or a flow can end with nothing to show.
for (const k of TERMINAL_KINDS) {
  check(`terminal kind ${k} has wording`,
    typeof endingFor(k, { reason: 'r', received: 'x' }) === 'string',
    'a flow that ends must say what happened');
}
check('a non-terminal kind has no ending wording', endingFor('filling') === null);

// The UX rule, as an assertion: with a one-minute window and a self-funding refund,
// "nobody filled it" is routine. Wording it as an error makes a working system feel
// broken, and this is the cheapest place to notice that.
const ERROR_WORDS = /fail|error|invalid|wrong|problem/i;
for (const k of TERMINAL_KINDS) {
  const w = endingFor(k, { reason: 'the pool is not allowed', received: '0.0067 USDC' });
  check(`ending ${k} is not worded as a failure`, !ERROR_WORDS.test(w), `"${w}"`);
}

// EVERY KIND THE SERVER EMITS MUST BE IN THE CLOSED SET.
//
// This is the check that was missing when a new route emitted `revoking`, which was not in
// EVENT_KINDS. `event()` threw — correctly, a typo should fail loudly — but the throw happened
// inside a request handler, so it killed the whole server. The browser saw only
// ERR_CONNECTION_REFUSED, which points at the network and says nothing about the cause.
//
// The vocabulary being closed is the point, so the check is that the CODE agrees with it.
// Read from the source rather than from a hand-kept list, because a list would be one more
// thing to keep in step — and the failure mode here is precisely a list that got out of step.
// The server is TypeScript now. Read from the file that exists rather than a path that was
// correct yesterday — this broke silently on the rename and only the count check caught it.
const serverSrc = fs.readFileSync(new URL('./ui.ts', import.meta.url), 'utf-8');
const emitted = [...serverSrc.matchAll(/\bevent\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
check('the server emits at least one event kind', emitted.length > 0,
  `found ${emitted.length} — the regex may have stopped matching`);
for (const k of new Set(emitted)) {
  check(`server-emitted kind "${k}" is in the vocabulary`, EVENT_KINDS.includes(k),
    'a kind outside EVENT_KINDS throws inside a request handler');
}

// EVERY SCRIPT THE SERVER RUNS MUST IMPLEMENT --emit-bytes.
//
// The server appends the flag to whatever `actionFor` returns and takes stdout as the
// transaction. A script that documents the flag but never reads it prints its dry-run JSON
// instead — which becomes "the bytes" and is handed to the wallet, producing a failure inside
// the extension that points nowhere near the cause.
//
// That is not hypothetical: refund-order.js was exactly that, and it cost five rounds of
// theories about the wallet, the sender and object encodings before anyone checked whether a
// transaction had been sent at all.
//
// Read from the source, like the event-kind check above, so a new script that forgets the flag
// fails HERE rather than in someone's wallet.
const scriptNames = [...serverSrc.matchAll(/script:\s*'(?:node |bun )?src\/([a-z0-9-]+\.(?:js|ts))/g)]
  .map((m) => m[1]);
check('the server runs at least one script', scriptNames.length > 0,
  `found ${scriptNames.length} — the regex may have stopped matching. It has before: the script`
  + ' strings lost their runtime prefix when the server moved to bun.');
for (const name of new Set(scriptNames)) {
  let src = '';
  try {
    src = fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf-8');
  } catch {
    check(`src/${name} exists`, false, 'the server names a script that is not there');
    continue;
  }
  check(`src/${name} implements --emit-bytes`,
    src.includes("process.argv.includes('--emit-bytes')"),
    'the server appends --emit-bytes; ignoring it prints JSON as if it were transaction bytes');
}

// THE DRIFT CHECK IS GONE, because what it guarded is gone.
//
// It asserted that a .d.ts matched the .js beside it, and it found a real drift on its first
// run — a declaration that invented an export the code did not provide. That is the same
// failure as --emit-bytes: a contract in one file the code in another does not honour.
//
// events.ts and units.ts are TypeScript now, so their types live IN the file. There is no
// second source of truth left to disagree with, which is a better answer than checking one.

// THE DESIGN TOKENS MUST BE IN A SELECTOR THAT APPLIES.
//
// They were in a .dark block and nothing ever set that class, so every var() resolved to nothing
// and the whole app rendered black on white. Undefined custom properties do not error — they fall
// back — so the failure is invisible to every check that looks for the token's NAME rather than
// for whether it takes effect. Which is exactly what I did: grep found --sidebar in the built
// stylesheet and I called it verified.
//
// :root always applies. This asserts the tokens are there and not only somewhere unreachable.
const appCss = fs.readFileSync(new URL('./web/app/app.css', import.meta.url), 'utf-8');
const rootBlock = appCss.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
check('the stylesheet has a :root block', rootBlock.length > 0,
  'a palette with no always-applying selector renders as black on white');
for (const token of ['--background', '--foreground', '--sidebar', '--card', '--brand', '--border']) {
  check(`${token} is defined in :root`, rootBlock.includes(token),
    'a token behind a selector nothing applies is a token that does not exist');
}

// THE FOLD MUST NOT HIDE AN ENDING.
//
// `answered` was missing from TERMINAL_KINDS, so every capabilities answer was classified as
// progress — counted as a step and folded away. The user's questions survived and the answers to
// them did not, and it read as the app having lost the replies.
//
// The two lists live in different files, which is exactly why they drifted: one is the vocabulary
// and the other is a rendering decision. Read from the source rather than imported, so the check
// sees what is actually shipped.
{
  const chatSrc = fs.readFileSync(
    new URL('./web/app/components/Chat.tsx', import.meta.url), 'utf-8');
  const block = chatSrc.match(/const PROGRESS_KINDS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  const progressKinds = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

  check('the fold names what it hides', progressKinds.length > 0,
    `found ${progressKinds.length} — the regex may have stopped matching`);

  for (const k of TERMINAL_KINDS) {
    check(`the fold does not hide "${k}"`, !progressKinds.includes(k),
      'an ending the fold puts away is an answer nobody reads');
  }
}

/*
 * The policy panel: one grant SHOWN, both KEPT in the registry.
 *
 * Hiding a hire from the pane and removing it from `hires.ts` are different acts, and the
 * difference is invisible until something breaks. The pane is a thing you manage, so it shows
 * one. The registry is what the model extracts names from and what the ambiguous-request case
 * counts, so it keeps both — and deleting `cautious` as "unused" would look like tidying.
 */
{
  const left = fs.readFileSync('src/web/app/components/LeftPane.tsx', 'utf8');
  const registry = fs.readFileSync('src/hires.ts', 'utf8');
  const intent = fs.readFileSync('src/verify-intent.js', 'utf8');

  // THE PANE DOES NOT ENUMERATE HIRES AT ALL. A grant is one thing you have, not a set you
  // choose between, so the pane offers the two things you can DO with it and lists nothing.
  // The check is therefore the ABSENCE of a list rather than the width of a filter — and it
  // replaced a check that asserted the filter, which passed until the list was removed.
  check('the grants pane does not map over hires', !/hires\s*\?\?\s*\[\]\)?\.map\(/.test(left),
    'the pane is enumerating grants again — a grant is one thing, not a list');
  check('the grants pane does not filter by hire name', !/h\.name === '/.test(left),
    'a hire-name comparison in the pane — the sheet targets one hire by name instead');
  check('the sheet targets exactly one hire', /x\.name === 'standard'/.test(left),
    'no single-hire target — the sheet would have nothing to read a baseline from');

  for (const name of ['standard', 'cautious']) {
    check(`the registry still holds "${name}"`, new RegExp(`^\\s+${name}: \\{`, 'm').test(registry),
      'removed from hires.ts — the ambiguous-request case needs two names to exist');
  }
  check('the ambiguous-request case still asks between two', /decision: 'ASKING'/.test(intent),
    'no ASKING case in verify-intent.js');
}

/*
 * The truthiness bug, which both older kinds had and which is why the policy kind compares.
 *
 * `body.suspended ? …` and `body.allow !== false` both read as sensible defaults and both meant
 * that a form's "false" — a non-empty string, therefore truthy — SUSPENDED a hire when the
 * request was to resume it. Read from the source because that is where the difference lives.
 */
{
  const ui = fs.readFileSync('src/ui.ts', 'utf8');
  const start = ui.indexOf("kind === 'policy'");
  const policy = start < 0 ? '' : ui.slice(start, ui.indexOf("kind === 'position'", start));

  check('the policy kind exists in the build route', policy.length > 0,
    'no kind === \'policy\' branch — the panel has nothing to call');
  check('the policy kind compares suspended rather than testing truthiness',
    policy.includes("typeof body.suspended === 'boolean'"),
    'a string "false" would suspend a hire instead of resuming it');
  // The ternary that follows is SAFE BECAUSE of the guard, so asserting the guard exists is not
  // enough — a bare `body.suspended ? …` would satisfy that too. What matters is that the guard
  // comes first. The first version of this check looked for the substring alone, flagged the
  // guarded use as the bug it was guarding against, and never passed once.
  const guardAt = policy.indexOf("typeof body.suspended === 'boolean'");
  const useAt = policy.indexOf('body.suspended ?');
  check('the guard precedes any use of the value',
    guardAt >= 0 && (useAt < 0 || guardAt < useAt),
    `guard at ${guardAt}, use at ${useAt} — the value is read before it is checked`);
}

/*
 * The budget must come from the LEDGER, not from the registry.
 *
 * `hires.ts` carries a `budgetSui` that is the ORIGINAL grant, and `/api/hires` handed it out as
 * the current budget — so the policy panel showed 0.03 for a hire whose allowance had been set to
 * 0.01, and the old page had known all along (it labelled the figure "local").
 *
 * The registry figure drifts the moment anyone calls set_allowance, which is the whole point of
 * the field, so this asserts the route reads the chain and does not pass the constant through.
 */
{
  const ui = fs.readFileSync('src/ui.ts', 'utf8');
  // The WHOLE file, not a slice from `async function hires()`. The allowance read is a NESTED
  // function inside it, so searching for the next `async function` cut the region off before the
  // body — and the checks read an empty string and failed against nothing. Three of them reported
  // FAIL on correct code, which is the same class of mistake as the substring check earlier.
  const fn = ui;

  // ONE READER, and it lives in agent.ts. COUNTED rather than merely present: "exactly one" is the
  // claim in the label, and two readers of one ledger would drift.
  //
  // COMMENT LINES ARE STRIPPED FIRST. The string also appears in the doc comment that explains why
  // the read is a simulate rather than a getObject, so counting raw occurrences reported a second
  // reader that does not exist — a check that counts prose measures the prose.
  const agentSrc = fs.readFileSync('src/agent.ts', 'utf8');
  const agentCode = agentSrc.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const ledgerReads = (agentCode.match(/spend_vault::allowance/g) ?? []).length;
  check('the allowance is read by exactly one function, in agent.ts',
    agentSrc.includes('export async function allowanceMist') && ledgerReads === 1,
    `spend_vault::allowance appears ${ledgerReads} time(s) in code — the gate and the hires route both depend on it`);
  check('the hires route uses that reader rather than its own copy',
    fn.includes("import { allowanceMist } from './agent.js'") && fn.includes('allowanceMist(h.capId)'),
    'a second copy of the read — two readers of one ledger will drift');
  // THE ARGUMENT LIST IS DELIBERATELY NOT PINNED. A coin type was added to this call when a second
  // direction arrived, and a check naming the old shape failed on correct code — the fifth time
  // this project has paid for asserting a shape instead of an invariant. ONE READER is the
  // invariant; which arguments it takes is not.
  check('the gate reads the allowance too',
    /await allowanceMist\(hire\.capId[^)]*\)/.test(agentSrc),
    'the gate does not read it, so an over-grant request would only fail on chain, as an abort');
  check('the ledger value overwrites the registry figure',
    /row\.budgetSui = \(Number\(mist\) \/ 1e9\)/.test(fn),
    'the chain figure is read but not used for budgetSui');
  check('a failed read is null, not zero',
    fn.includes('budgetMist = mist === null ? null'),
    'a failed read would render as a budget of nothing');
  check('the registry figure is kept separately, labelled',
    fn.includes('budgetLocalSui:'),
    'no local figure — the UI cannot say where a number came from when the read fails');
}

/*
 * The sheet makes claims about order.move, so they are checked against it.
 *
 * The allowance one FLIPPED when create_with_policy landed. It used to assert that order.move did
 * NOT check the allowance — which was true, and was why the budget bounded nothing reachable. Now
 * it asserts the opposite, and it caught the stale hint the moment the contract changed: verify
 * went red with "order.move now checks the allowance — the sheet hint must be rewritten".
 *
 * A check written to fail on improvement is only useful if the failure is acted on. It was not,
 * the first time: the commit that added create_with_policy pushed a red verify, which is the same
 * mistake already in NOTES about batching verify with git.
 */
{
  const order = fs.readFileSync('move/sources/order.move', 'utf8');
  const sheet = fs.readFileSync('src/web/app/components/PolicySheet.tsx', 'utf8');

  check('the sheet says the budget bounds one order',
    sheet.includes('BOUNDS ONE ORDER'),
    'the field no longer says what it does');
  check('the sheet says it is not a spending total',
    sheet.includes('NOT a spending total'),
    'the per-order ceiling reads as a total, which it is not');

  check('order.move enforces the allowance, so the sheet is true',
    /EExceedsAllowance/.test(order),
    'create_with_policy lost its allowance check — the sheet claim is now false');
  check('order.move does not check is_suspended, so that warning is true',
    !/is_suspended/.test(order),
    'order.move now checks is_suspended — the sheet hint must be rewritten');

  // The two settle gates, so a future edit cannot quietly drop one.
  check('order.move still gates on the agent', /policy::agent\(policy\)/.test(order),
    'the settler gate is gone');
  check('order.move still gates on the pool allowlist', /is_pool_allowed/.test(order),
    'the venue gate is gone');
}

// THE BUDGET IS PER COIN, AND THE COIN HAS TO SURVIVE THE WHOLE HOP.
//
// `set_allowance` is keyed by (cap_id, coin_type), so a SUI grant and a USDC grant are different
// rows of the ledger — and this path hardcoded SUI in the type argument, so a USDC order could not
// be granted a ceiling at all and aborted `EExceedsAllowance` against a grant of zero. The
// relationship asserted here is the HOP: the sheet names the coin, the route passes it, the script
// uses it. Checking any one of the three alone would have passed while the chain stayed pinned.
{
  const sheet = fs.readFileSync('src/web/app/components/PolicySheet.tsx', 'utf8');
  const route = fs.readFileSync('src/ui.ts', 'utf8');
  const script = fs.readFileSync('src/set-policy.ts', 'utf8');
  check('the sheet names the coin it is granting against',
    sheet.includes('body.budgetCoin'),
    'the sheet sends a budget without saying which ledger row it is');
  check('the route passes that coin through to the script',
    route.includes('env.BUDGET_COIN'),
    'the coin stops at the route, so the script cannot know which row to write');
  check('the script uses the coin as the type argument',
    /typeArguments:\s*\[COIN\.type\]/.test(script) && !/typeArguments:\s*\[SUI_TYPE\]/.test(script),
    'the ledger write is pinned to one coin');
  // AND A FIELD THE SHEET CAN WRITE MUST BE ONE THE ROUTE READS BACK. It could set a USDC ceiling
  // and not read one, so the owner granted 0.5 USDC and the panel showed an empty box — the grant
  // looked like it had not landed, and the agent was blamed for reading a stale figure.
  check('the route reads back the coin the sheet offers to set',
    /allowanceMist\(h\.capId,\s*USDC_TYPE\)/.test(route),
    'the sheet can set a USDC ceiling but cannot read one, so the grant is invisible after signing');
}

// AN ORDER IS GENERIC, SO ITS TYPE ARGUMENT HAS TO COME FROM THE OBJECT.
//
// `burn-order.ts` and `refund-order.ts` both wrote `typeArguments: [SUI_TYPE]`, so a USDC order
// failed the VM's own type check with `CommandArgumentError { kind: TypeMismatch }` — the recovery
// path for precisely the trades the new USDC direction makes. The check is a RELATIONSHIP: every
// script that calls `order::burn` or `order::refund` must read the coin off the object rather than
// naming one. `settle_*` is excluded on purpose — its type arguments are the POOL's `[USDC, SUI]`,
// which are the same in both directions and are not the order's coin.
{
  const offenders = [];
  for (const f of fs.readdirSync('src').filter((n) => n.endsWith('.ts'))) {
    const src = fs.readFileSync(`src/${f}`, 'utf8');
    if (!/::order::(burn|refund)\b/.test(src)) continue;
    if (!src.includes('orderCoinType')) offenders.push(`${f}: no orderCoinType`);
    if (/typeArguments:\s*\[(SUI_TYPE|USDC_TYPE)\]/.test(src)) offenders.push(`${f}: literal coin`);
  }
  check('every order::burn or order::refund takes its coin type from the object',
    offenders.length === 0,
    offenders.join('; '));
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('page and events: all checks passed');
