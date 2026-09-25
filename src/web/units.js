/*
 * Decimal string -> integer units, for the page's amount inputs.
 *
 * Pure and DOM-free so it can be tested on its own (see src/verify-page.js). This
 * matters more than it looks: this parser is what turns what someone typed into the
 * integer a chain transaction will carry, and it is the piece that silently broke
 * when the page lived inside a template literal. Money arithmetic with no test is
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
