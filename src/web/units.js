/*
 * Amount conversion, both directions, in exact integers.
 *
 * Pure and DOM-free so it can be tested on its own (see src/verify-page.js), and shared by
 * everything that shows an amount to a person: the page, the React app, and the CLI scripts
 * that talk to an operator. A message reading "cannot swap 10000000" is a correct number in
 * a unit nobody reads.
 *
 * ONE FORMATTER, ON PURPOSE. The React app briefly had its own, which printed a fee of
 * "0.010000" while these printed "0.01" — the same value, two spellings, because a second
 * implementation appeared next to the first. Anything here that displays money imports this
 * file; there is no second copy to drift.
 *
 * It is plain JavaScript and the app is TypeScript, which is why tsconfig sets allowJs:
 * TypeScript reads it for its shape without type-checking a module that was never written
 * under strict rules. That is a deliberate trade, not an oversight.
 *
 * This matters more than it looks: the forward parser is what turns what someone typed
 * into the integer a chain transaction will carry, and it is the piece that silently
 * broke when the page lived inside a template literal. Money arithmetic with no test is
 * how you send the wrong number.
 *
 * No floats anywhere. `Number("0.05") * 1e9` is 50000000.00000001 in binary floating
 * point, and a chain amount must be exact.
 */

export const SUI_DECIMALS = 9;
export const USDC_DECIMALS = 6;

/** Any decimal, one dot at most. A literal, so nothing is interpolated into it. */
const DECIMAL = /^[0-9]+([.][0-9]+)?$/;

/**
 * Exact decimal -> integer units, or null if the text is not a valid amount.
 *
 * Digits and the dot are matched with [0-9] and [.] rather than the usual escapes.
 * Not a style choice: code written with the backslash forms silently lost them when
 * it lived in a template literal, and the pattern then matched nothing useful.
 */
export function toUnits(text, decimals) {
  const t = String(text ?? '').trim();
  if (!DECIMAL.test(t)) return null;

  const [whole, frac = ''] = t.split('.');
  // The precision check is separate from the shape check, so the pattern stays a
  // literal. Building `{1,${decimals}}` by hand also breaks at decimals = 0, where
  // the quantifier reads `{1,0}` and throws instead of rejecting.
  if (frac.length > decimals) return null;

  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded)).toString();
}

/** SUI as typed by a person -> MIST. */
export const suiToMist = (text) => toUnits(text, SUI_DECIMALS);

/** USDC as typed by a person -> 6-decimal units. */
export const usdcToUnits = (text) => toUnits(text, USDC_DECIMALS);

/**
 * Integer units -> a decimal string. The reverse of `toUnits`, and exact for the same
 * reason: string slicing, never a division.
 *
 * For MESSAGES. A chain amount is always the integer, and anything that carries a value
 * keeps carrying the integer — this exists so a person reading a refusal sees "0.01"
 * rather than "10000", which is a number in a unit they do not have in their head.
 */
export function fromUnits(raw, decimals) {
  const s = String(raw ?? '0').replace('-', '').padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** MIST -> a decimal string, for messages. */
export const mistToSui = (raw) => fromUnits(raw, SUI_DECIMALS);

/** 6-decimal USDC units -> a decimal string, for messages. */
export const unitsToUsdc = (raw) => fromUnits(raw, USDC_DECIMALS);
