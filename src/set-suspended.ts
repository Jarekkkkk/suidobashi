/* Suspend or resume a hire. Owner-gated, gas only — no funds move.
 *
 * This is the per-hire kill switch. It stops an agent acting without touching its
 * budget, its venue allowlist, or the vault: the policy's own gate refuses the
 * call. It needs no cooperation from the agent, and nothing about the agent being
 * offline, hostile, or compromised affects it.
 *
 * `set_suspended` is idempotent, unlike `set_pool_allowed` — setting the same
 * value twice is fine, because it assigns a bool rather than inserting into a set.
 *
 * Usage:
 *   HIRE=cautious SUSPEND=true  node src/set-suspended.js
 *   HIRE=cautious SUSPEND=false node src/set-suspended.js
 */
import 'dotenv/config';
import { PACKAGE_LATEST_ID, OWNER_CAP_ID, DEPLOYER } from './addresses.js';
import { HIRES, getHire } from './hires.js';

const EMIT_BYTES = process.argv.includes('--emit-bytes');
const SUSPEND = (process.env.SUSPEND ?? 'true') !== 'false';

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const name = process.env.HIRE;
  const hire = getHire(name);
  if (!hire || !name) {
    throw new Error(`HIRE must be one of: ${Object.keys(HIRES).join(', ')}`);
  }

  const sender = process.env.SUI_SENDER || DEPLOYER;
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  const tx = new Transaction();
  tx.setSender(sender);

  // The hire is a generic Policy<phantom A, phantom B>? No — `policy` is untyped,
  // so no type arguments are needed for the admin calls.
  tx.moveCall({
    target: `${PACKAGE_LATEST_ID}::policy::set_suspended`,
    arguments: [
      tx.sharedObjectRef({
        objectId: hire.policyId,
        initialSharedVersion: hire.policySharedVersion,
        mutable: true,
      }),
      tx.object(OWNER_CAP_ID),
      tx.pure.bool(SUSPEND),
    ],
  });

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
    step: SUSPEND ? 'suspend hire' : 'resume hire',
    hire: hire.name,
    policyId: hire.policyId,
    ok,
    status,
  }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
