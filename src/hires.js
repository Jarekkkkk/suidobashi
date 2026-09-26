/* The hires this owner holds.
 *
 * A policy is a grant, so this registry is really a list of grants: which policy
 * gates the hire, which cap keys its budget, which venue it may use. Routing a
 * request to a hire means passing its policy id — and its venue — into the
 * executing script instead of the defaults.
 *
 * Nothing here is authority. It is bookkeeping, and the chain holds the limits,
 * so a wrong entry produces a refused transaction rather than a wider permission.
 *
 * The two hires now differ in substance, not just in name:
 *
 *   standard   0.05% fee pool   budget 0.03   the default
 *   cautious   0.01% fee pool   budget 0.01   a different venue entirely
 *
 * That is the strongest difference the policy can express. Its only per-hire
 * knobs are the agent address, the destination, the venue allowlist and
 * suspension; there is no per-hire *action* allowlist, so "this agent may swap
 * but not rebalance" is not expressible without new Move.
 */
import {
  POLICY_ID, POLICY_SHARED_VERSION, SPENDER_CAP_ID,
  HIRE_B_POLICY_ID, HIRE_B_POLICY_SHARED_VERSION, HIRE_B_CAP_ID,
  POOL_ID, POOL_SHARED_VERSION, POOL_ALT_ID, POOL_ALT_SHARED_VERSION,
} from './addresses.js';

export const HIRES = {
  standard: {
    name: 'standard',
    policyId: POLICY_ID,
    policySharedVersion: POLICY_SHARED_VERSION,
    capId: SPENDER_CAP_ID,
    budgetSui: '0.03',
    venue: { id: POOL_ID, sharedVersion: POOL_SHARED_VERSION, feeBps: 5 },
  },
  cautious: {
    name: 'cautious',
    policyId: HIRE_B_POLICY_ID,
    policySharedVersion: HIRE_B_POLICY_SHARED_VERSION,
    capId: HIRE_B_CAP_ID,
    budgetSui: '0.01',
    venue: { id: POOL_ALT_ID, sharedVersion: POOL_ALT_SHARED_VERSION, feeBps: 1 },
  },
};

export const DEFAULT_HIRE = 'standard';

/** Names the model may emit. Kept as an array so the schema and the prompt agree. */
export const HIRE_NAMES = Object.keys(HIRES);

  /**
   * The hire a name refers to, or null if it names nothing.
   *
   * @param {unknown} name as the model or a form field supplied it — normalised here rather
   *   than at every call site, since it arrives from both
   * @returns {typeof HIRES[keyof typeof HIRES] | null}
   */
  export function getHire(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return HIRES[DEFAULT_HIRE];
  return HIRES[key] ?? null;
}
