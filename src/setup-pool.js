/* Allowlist the pinned Cetus pool on the policy, and raise the budget.
 *
 * Both are cap-gated admin actions: the OwnerCap must be presented and its
 * vault binding must match. Gas only — no funds move.
 *
 * Budget is raised to cover the swap size. It cannot exceed the vault balance,
 * since the OZ ledger is a ceiling over a real pool, not a reservation.
 *
 * Usage:
 *   node src/setup-pool.js                  dry-run
 *   node src/setup-pool.js --emit-bytes     base64 bytes for the wallet to sign
 */
import 'dotenv/config';
import {
  PACKAGE_ID, VAULT_ID, POLICY_ID, OWNER_CAP_ID, POOL_ID, CLOCK_ID, SUI_TYPE,
  VAULT_SHARED_VERSION, POLICY_SHARED_VERSION, CLOCK_SHARED_VERSION,
  SWAP_AMOUNT_MIST, DEPLOYER,
} from './addresses.js';

const EMIT_BYTES = process.argv.includes('--emit-bytes');
const EXPIRY_MS = 4_102_444_800_000n; // 2100-01-01

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const sender = process.env.SUI_SENDER || DEPLOYER;
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  const tx = new Transaction();
  tx.setSender(sender);

  const vaultMut = tx.sharedObjectRef({
    objectId: VAULT_ID, initialSharedVersion: VAULT_SHARED_VERSION, mutable: true,
  });
  const policyMut = tx.sharedObjectRef({
    objectId: POLICY_ID, initialSharedVersion: POLICY_SHARED_VERSION, mutable: true,
  });
  const clock = tx.sharedObjectRef({
    objectId: CLOCK_ID, initialSharedVersion: CLOCK_SHARED_VERSION, mutable: false,
  });
  const ownerCap = tx.object(OWNER_CAP_ID);

  // 1. Open the venue. Pools start closed, so this is the step that makes the
  //    agent's swap possible at all.
  tx.moveCall({
    target: `${PACKAGE_ID}::policy::set_pool_allowed`,
    arguments: [policyMut, ownerCap, tx.pure.id(POOL_ID), tx.pure.bool(true)],
  });

  // 2. Raise the budget to the swap size. Overwrites the entry in place; the
  //    cap id is unchanged, which is the point of the cap-keyed ledger.
  tx.moveCall({
    target: `${PACKAGE_ID}::spend_vault::set_allowance`,
    typeArguments: [SUI_TYPE],
    arguments: [
      vaultMut,
      ownerCap,
      tx.pure.id(OWNER_CAP_ID_SPENDER()),
      tx.pure.u64(SWAP_AMOUNT_MIST),
      tx.pure.u64(EXPIRY_MS),
      tx.pure.option('u64', null),
      clock,
    ],
  });

  const bytes = await tx.build({ client });

  if (EMIT_BYTES) {
    process.stdout.write(Buffer.from(bytes).toString('base64'));
    return;
  }

  const res = await client.simulateTransaction({ transaction: bytes });
  const status = res?.Transaction?.status ?? res?.status ?? null;
  const ok = status?.success === true || status?.status === 'success';
  console.log(JSON.stringify({
    mode: 'dry-run', step: 'allowlist pool + raise budget', sender, ok, status,
  }, null, 2));
  if (!ok) process.exit(1);
}

// The spender cap id: the ledger is keyed by (cap_id, coin_type), and after
// phase B that cap is owned by the Policy.
function OWNER_CAP_ID_SPENDER() {
  return process.env.SPENDER_CAP_ID
    || '0x21b3bb053c65eed825cd7acb80417dd11dd437e057c3c056a5fab789b4c00580';
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
