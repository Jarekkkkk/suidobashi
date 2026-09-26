/* Set the whole policy in ONE transaction. Owner-gated, gas only — no funds move.
 *
 * Each boundary used to be its own script and its own signature: `set-budget`,
 * `set-suspended`, `hire-agent --allowlist`, `hire-agent --repoint`. Five signatures
 * is five chances for the policy to end up in a state nobody chose — the suspension
 * lands, the venue change is refused, and what is on chain is half of what was asked
 * for. There is no way to tell that from the outside except by reading the policy back.
 *
 * A PTB is the primitive for exactly this. The same `OwnerCap` is borrowed immutably
 * by every call, the `Policy` is borrowed mutably in sequence, and the budget — which
 * is NOT a policy field but an OpenZeppelin ledger entry keyed by
 * `(cap_id, coin_type)` — rides in the same block because it is a call like any other.
 *
 * ONLY THE FIELDS YOU SET ARE CALLED. An absent variable means "leave it alone", not
 * "set it to a default". That is the difference between a patch and an overwrite, and
 * it is why every field is individually optional. Setting none of them is an error
 * rather than a no-op transaction that costs gas and changes nothing.
 *
 * ORDER IS DELIBERATE. `AGENT` comes first so its bound travels with it in the same
 * instruction pair, matching `hire-agent --repoint`: a grant handed over without a
 * price bound, even for one instruction, is the case the bound exists for. The budget
 * is last because it is keyed by the cap rather than by the agent, so its position
 * relative to the agent change does not matter — and putting it last makes that
 * explicit rather than accidental.
 *
 * Usage:
 *   HIRE=standard SUSPENDED=true bun src/set-policy.ts
 *   HIRE=standard BUDGET_MIST=30000000 bun src/set-policy.ts
 *   HIRE=standard ALLOW=0x…,0x… REVOKE=0x… bun src/set-policy.ts
 *   HIRE=standard AGENT=0x… BOUND_BPS=5 bun src/set-policy.ts
 *   HIRE=standard BUDGET_MIST=30000000 AGENT=0x… BOUND_BPS=5 bun src/set-policy.ts --emit-bytes
 *
 * HIRE is resolved strictly. There is no fallback to the default on an unknown name,
 * because a typo silently reconfiguring a different policy is exactly the kind of
 * mistake worth failing loudly on.
 */
import 'dotenv/config';
import {
  PACKAGE_LATEST_ID,
  OWNER_CAP_ID,
  DEPLOYER,
  SUI_TYPE,
  VAULT_ID,
  VAULT_SHARED_VERSION,
  CLOCK_ID,
  CLOCK_SHARED_VERSION,
} from './addresses.js';
import { HIRES, getHire } from './hires.js';

const EMIT_BYTES = process.argv.includes('--emit-bytes');
const EXPIRY_MS = 4_102_444_800_000n; // 2100-01-01

/** An absent or empty variable means "do not touch this", never "use a default". */
function set(name: string): boolean {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '';
}

/** A comma-separated id list, with empties dropped so a trailing comma is harmless. */
function ids(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const name = process.env.HIRE;
  const hire = getHire(name);
  if (!hire || !name) {
    throw new Error(`HIRE must be one of: ${Object.keys(HIRES).join(', ')}`);
  }

  const agent = set('AGENT') ? String(process.env.AGENT) : null;
  const boundBps = set('BOUND_BPS') ? BigInt(String(process.env.BOUND_BPS)) : null;
  const suspended = set('SUSPENDED') ? process.env.SUSPENDED !== 'false' : null;
  const budgetMist = set('BUDGET_MIST') ? BigInt(String(process.env.BUDGET_MIST)) : null;
  const allow = ids('ALLOW');
  const revoke = ids('REVOKE');

  // Setting nothing would build a valid transaction that costs gas and changes
  // nothing, which reads as success. Refuse it instead.
  const steps: string[] = [];
  if (agent) steps.push('agent');
  if (boundBps !== null) steps.push('bound');
  if (suspended !== null) steps.push('suspended');
  if (allow.length) steps.push(`${allow.length} venue(s) allowed`);
  if (revoke.length) steps.push(`${revoke.length} venue(s) revoked`);
  if (budgetMist !== null) steps.push('budget');
  if (!steps.length) {
    throw new Error(
      'nothing to set — pass at least one of AGENT, BOUND_BPS, SUSPENDED, BUDGET_MIST, ALLOW, REVOKE',
    );
  }

  const sender = process.env.SUI_SENDER || DEPLOYER;
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  const tx = new Transaction();
  tx.setSender(sender);

  // A fresh reference per call. The cap is borrowed immutably by every one of them,
  // which is why one cap can serve the whole block; the policy is borrowed mutably
  // in sequence, which is what `--repoint` already relies on for its two calls.
  const policyMut = () =>
    tx.sharedObjectRef({
      objectId: hire.policyId,
      initialSharedVersion: hire.policySharedVersion,
      mutable: true,
    });
  const ownerCap = () => tx.object(OWNER_CAP_ID);

  // Who may act, and how far the price may move — set together so a grant is never
  // briefly handed over without its bound.
  if (agent) {
    tx.moveCall({
      target: `${PACKAGE_LATEST_ID}::policy::set_agent`,
      arguments: [policyMut(), ownerCap(), tx.pure.address(agent)],
    });
  }
  if (boundBps !== null) {
    tx.moveCall({
      target: `${PACKAGE_LATEST_ID}::policy::set_max_slippage_bps`,
      arguments: [policyMut(), ownerCap(), tx.pure.u64(boundBps)],
    });
  }

  // The kill switch. Independent of the budget, the venues and the vault: the
  // policy's own gate refuses the call and the agent's cooperation is not needed.
  if (suspended !== null) {
    tx.moveCall({
      target: `${PACKAGE_LATEST_ID}::policy::set_suspended`,
      arguments: [policyMut(), ownerCap(), tx.pure.bool(suspended)],
    });
  }

  // Venues. Both directions are idempotent in the contract, so a no-op entry in
  // either list is harmless rather than fatal.
  for (const venue of allow) {
    tx.moveCall({
      target: `${PACKAGE_LATEST_ID}::policy::set_pool_allowed`,
      arguments: [policyMut(), ownerCap(), tx.pure.id(venue), tx.pure.bool(true)],
    });
  }
  for (const venue of revoke) {
    tx.moveCall({
      target: `${PACKAGE_LATEST_ID}::policy::set_pool_allowed`,
      arguments: [policyMut(), ownerCap(), tx.pure.id(venue), tx.pure.bool(false)],
    });
  }

  // The budget. Not a policy field: this is the OZ ledger, keyed by (cap_id, coin_type),
  // and `set_allowance` upserts it in place — which is also what makes it the recovery
  // path for an exhausted hire.
  if (budgetMist !== null) {
    tx.moveCall({
      target: `${PACKAGE_LATEST_ID}::spend_vault::set_allowance`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.sharedObjectRef({
          objectId: VAULT_ID,
          initialSharedVersion: VAULT_SHARED_VERSION,
          mutable: true,
        }),
        ownerCap(),
        tx.pure.id(hire.capId),
        tx.pure.u64(budgetMist),
        tx.pure.u64(EXPIRY_MS),
        tx.pure.option('u64', null),
        tx.sharedObjectRef({
          objectId: CLOCK_ID,
          initialSharedVersion: CLOCK_SHARED_VERSION,
          mutable: false,
        }),
      ],
    });
  }

  const bytes = await tx.build({ client });
  if (EMIT_BYTES) {
    process.stdout.write(Buffer.from(bytes).toString('base64'));
    return;
  }

  const res = await client.simulateTransaction({ transaction: bytes });
  const status = res?.Transaction?.status ?? null;
  const ok = status?.success === true;
  console.log(JSON.stringify({
    mode: 'dry-run',
    hire: hire.name,
    policyId: hire.policyId,
    steps,
    agent,
    boundBps: boundBps === null ? null : String(boundBps),
    suspended,
    budgetMist: budgetMist === null ? null : String(budgetMist),
    allow,
    revoke,
    ok,
    status,
  }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
