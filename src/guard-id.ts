/*
 * Which guard is current, and how the config is re-pointed at it.
 *
 * Pure: no filesystem, no network, no side effects. That is deliberate, because the
 * two things here are the ones worth being careful about.
 *
 * A `create` mints a guard whose id is generated on the validator, so the only place
 * it exists is in that transaction's effects. And adopting it means rewriting
 * src/addresses.js, which holds every deployed id in the project — a corrupt file
 * there is far worse than a stale one. Both are tested against the real transaction
 * and the real file in src/verify-guard.js.
 */

/** A Sui object id: 0x and 64 hex characters. Used to refuse a bad write. */
const OBJECT_ID = /^0x[0-9a-f]{64}$/;

/**
 * Find the guard a `create` transaction minted, from `sui client tx-block --json`.
 *
 * Matches on the type, never on "the shared object that was created". A create also
 * writes the Cetus pool, which is shared too and already exists; picking by shape
 * rather than by type would quietly select the pool.
 *
 * @param {any} doc the parsed `sui client tx-block --json` output
 * @returns {{id: string, version: number} | {error: string}}
 */
export function findCreatedGuard(doc: any): { id: string; version: number } | { error: string } {
  const changes = doc?.objectChanges;
  if (!Array.isArray(changes)) return { error: 'no objectChanges in the transaction' };

  const created = changes.find((c) => c?.type === 'created'
    && String(c.objectType || '').includes('::position_guard::PositionGuard'));

  // The CLI has used both spellings across versions, and a missing shared version
  // means the id alone is useless — every later call needs the pair.
  const owner = created?.owner;
  const version = owner?.Shared?.initial_shared_version ?? owner?.Shared?.initialSharedVersion;
  const id = created?.objectId;

  if (!OBJECT_ID.test(String(id))) {
    return { error: 'the transaction created no position guard' };
  }
  if (!Number.isInteger(version)) {
    return { error: `found guard ${String(id).slice(0, 12)}… but no shared version to go with it` };
  }
  return { id, version };
}

/**
 * Re-point the GUARD_ID and GUARD_SHARED_VERSION lines at a new guard.
 *
 * Returns the new file contents, or null if the file did not match — in which case
 * the caller must write nothing. Both lines have to be rewritten together: changing
 * the id without its shared version, or the reverse, leaves a pair that disagrees,
 * and the resulting failure is much harder to read than not writing at all.
 *
 * @param {unknown} source the file's text, as read
 * @param {unknown} id the new guard id
 * @param {unknown} version its initial shared version
 * @returns {string | null}
 */
export function repointAddresses(source: unknown, id: unknown, version: unknown): string | null {
  if (typeof source !== 'string') return null;
  if (!OBJECT_ID.test(String(id)) || !Number.isInteger(version)) return null;

  // `id` is checked as a valid object id above, so binding it here is what lets the rest of the
  // function treat it as a string. `source` is already narrowed by its own typeof check.
  const idText = String(id);
  const withId = source.replace(/(export const GUARD_ID\s*=\s*')[0-9a-fx]+(')/, `$1${idText}$2`);
  const withBoth = withId.replace(/(export const GUARD_SHARED_VERSION\s*=\s*)\d+/, `$1${version}`);

  // Both must have actually changed, and the id must not already have been present.
  if (withId === source || withBoth === withId) return null;
  if (source.includes(idText)) return null;
  return withBoth;
}
