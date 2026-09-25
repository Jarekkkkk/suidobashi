/*
 * One runnable check for the page's escaping.
 *
 * src/web/markup.js is security relevant: values arriving from the chain and from
 * hire names are interpolated into markup, so if `html` ever stops escaping, or
 * `setHtml` ever stops escaping raw input, those values become script injection.
 * This is the smallest thing that fails if that breaks.
 *
 * It imports the real module rather than duplicating or evaluating the helpers, so
 * what is tested is exactly what the browser is served.
 *
 *   bun run src/verify-page.js
 */
import { esc, html, setHtml } from './web/markup.js';
import { suiToMist, toUnits, usdcToUnits } from './web/units.js';

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

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('page escaping: all checks passed');
