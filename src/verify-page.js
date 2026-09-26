/*
 * One runnable check for the page: escaping, amount parsing, and element bindings.
 *
 * src/web/markup.js is security relevant: values arriving from the chain and from
 * hire names are interpolated into markup, so if `html` ever stops escaping, or
 * `setHtml` ever stops escaping raw input, those values become script injection.
 * src/web/units.js decides the integer a transaction carries. Both are imported
 * rather than duplicated, so what is tested is what the browser is served.
 *
 *   bun run src/verify-page.js
 */
import fs from 'node:fs';
import { esc, html, setHtml } from './web/markup.js';
import { suiToMist, toUnits, usdcToUnits } from './web/units.ts';
import { EVENT_KINDS, SOURCES, TERMINAL_KINDS, event, endingFor } from './web/events.ts';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures += 1;
  console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
};

const ATTACK = '<img src=x onerror="alert(1)">';

// 1. A raw value interpolated into a template is escaped.
const one = html`<b>${ATTACK}</b>`;
check('html escapes an interpolated value', !one.includes('<img'), one);
check('html keeps the surrounding markup', one.includes('<b>') && one.includes('</b>'), one);
check('html escapes the angle brackets', one.includes('&lt;img'), one);

// 2. A nested template is NOT double escaped — the markup it produced survives.
const inner = html`<i>${ATTACK}</i>`;
const outer = html`<div>${inner}</div>`;
check('nested html keeps its markup', outer.includes('<i>') && outer.includes('</i>'), outer);
check('nested html does not double escape', !outer.includes('&amp;lt;'), outer);
check('nested html still escapes the payload',
  !outer.includes('<img') && outer.includes('&lt;img'), outer);

// 3. setHtml escapes a plain string, so a raw caller cannot inject either.
const el = { innerHTML: null };
setHtml(el, ATTACK);
check('setHtml escapes a raw string', !String(el.innerHTML).includes('<img'), String(el.innerHTML));

// 4. setHtml passes through markup produced by html, with the payload still escaped.
const el2 = { innerHTML: null };
setHtml(el2, html`<b>${ATTACK}</b>`);
check('setHtml keeps html-produced markup', String(el2.innerHTML).includes('<b>'), String(el2.innerHTML));
check('setHtml keeps the payload escaped', !String(el2.innerHTML).includes('<img'), String(el2.innerHTML));

// 5. Quotes are escaped, which is what makes attribute position safe.
const attr = html`<span title="${'" onmouseover="alert(1)'}">x</span>`;
check('quotes are escaped in attribute position', !attr.includes('onmouseover="'), attr);
check('quotes become entities', attr.includes('&quot;'), attr);

// 6. The values actually rendered by the page: a hire name from our own config and
//    a digest from the chain. Neither should be able to open a tag.
const chainish = html`<a href="https://suiscan.xyz/mainnet/tx/${'0x' + '" onmouseover="x'}">x</a>`;
check('a digest position cannot break out of the href', !chainish.includes('" onmouseover'), chainish);

// 7. The case that caught a real bug in this module: rendering a list maps the
//    template over it. Fragments must join with nothing. A marker object
//    stringifies to "[object Object]", and a naive join inserts commas — either
//    way the hires strip and the hire dropdowns render garbage.
const mapped = ['alpha', 'beta'].map((name) => html`<option>${name}</option>`);
const joined = html`<select>${mapped}</select>`;
check('a mapped list renders every fragment',
  joined.includes('<option>alpha</option>') && joined.includes('<option>beta</option>'), joined);
check('a mapped list joins with no separator',
  !joined.includes(',') && !joined.includes('[object'), joined);
check('an empty list renders nothing', html`<select>${[]}</select>`.includes('<select></select>'),
  String(html`<select>${[]}</select>`));
check('esc flattens a list of mixed values',
  esc([html`<b>x</b>`, 'raw<']).startsWith('<b>x</b>'), String(esc([html`<b>x</b>`, 'raw<'])));

// 8. Amount conversion. This is the piece that broke silently when the page lived in
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

// 9. Element bindings. page.js looks elements up by id; ui.js's template creates
//    them. A mismatch yields null, and a null at module load THROWS -- so no handler
//    attaches anywhere and every button on the page does nothing. That is exactly how
//    this project's first bug presented itself, and nothing else checks for it.
const uiSource = fs.readFileSync('src/ui.ts', 'utf8');
const pageSource = fs.readFileSync('src/web/page.js', 'utf8');

const declared = new Set([
  // ids in the served page template
  ...[...uiSource.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
  // ids page.js creates itself, e.g. the wallet connect/disconnect buttons
  ...[...pageSource.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
]);
const looked = [...pageSource.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
const missing = [...new Set(looked)].filter((id) => !declared.has(id));

check('every element the page looks up exists in the markup', missing.length === 0,
  `nothing declares id="${missing.join('", nothing declares id="')}"`);
check('the check found bindings to verify', looked.length >= 8, `found ${looked.length}`);

// 10. The pipeline's event vocabulary. Two things here are load-bearing rather than
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

  const filters = [...left.matchAll(/\.filter\(\s*\(?h\)?\s*=>\s*h\.name === '([a-z]+)'/g)].map((m) => m[1]);
  check('the grants pane filters to exactly one hire', filters.length === 1,
    `found ${filters.length} — the pane would show ${filters.length} grants`);
  check('the pane shows the default hire', filters[0] === 'standard',
    `filters to "${filters[0]}"`);

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

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('page and events: all checks passed');
