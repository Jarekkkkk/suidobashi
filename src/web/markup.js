/*
 * Markup escaping for the browser page.
 *
 * Kept in its own module, free of any DOM access, for two reasons. It is security
 * relevant — values from the chain and from hire names get interpolated into
 * markup — so it must be testable on its own (see src/verify-page.js). And it is
 * the only place in the UI that is allowed to decide what counts as safe markup.
 *
 * `html` is the sanitizer. Every interpolation is escaped unless it was itself
 * produced by `html`, which is marked safe, so a raw value cannot reach innerHTML
 * even by forgetting to escape it.
 */

/**
 * Markup that has already been escaped.
 *
 * A String subclass, not a plain marker object, and that is load-bearing. A marker
 * object stringifies to "[object Object]", and the natural way to render a list is
 * to map the template over it — so an array of fragments would have become
 * "[object Object],[object Object]" on screen. Being a String means joining,
 * concatenating and interpolating each do the obvious thing, while `instanceof`
 * still lets esc() recognise the value as already safe.
 */
class SafeMarkup extends String {}

/** Mark a string as already-safe markup, so a nested template is not re-escaped. */
export const safe = (value) => new SafeMarkup(String(value));

export function esc(value) {
  // A list of fragments joins with nothing — not with the commas Array#toString
  // would insert, and not with escaped commas either.
  if (Array.isArray(value)) return value.map(esc).join('');
  if (value instanceof SafeMarkup) return String(value);
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

export const html = (strings, ...values) =>
  safe(strings.reduce((out, s, i) => out + s + (i < values.length ? esc(values[i]) : ''), ''));

/** The only place innerHTML is assigned in the UI. Raw input is escaped first. */
export function setHtml(el, markup) {
  // pi-lens-ignore: ast-grep:no-inner-html-js
  el.innerHTML = esc(markup);
}
