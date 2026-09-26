/* Redeem the guard's position — the owner's full exit.
 *
 * Removes all liquidity, collects fees and rewards, closes the position, and
 * routes everything to the destination. Cap-holder gated, so it needs no agent
 * cooperation: if the agent is gone, misbehaving, or suspended, the owner still
 * gets everything back. That is the property this script exists to demonstrate,
 * and it is the one path whose failure would be unrecoverable.
 *
 * Carries the same reward-collection requirement as rebalance: Cetus refuses to
 * close a position while any reward is still owed, so the reward coin arrives as
 * a type parameter.
 *
 * Usage:
 *   node src/redeem.js                 dry-run
 *   node src/redeem.js --emit-bytes
 */
import 'dotenv/config';
import {
  PACKAGE_LATEST_ID, GUARD_ID, OWNER_CAP_ID, POOL_ID, GLOBAL_CONFIG_ID, CLOCK_ID,
  USDC_TYPE, SUI_TYPE, REWARD_TYPE, REWARDER_VAULT_ID,
  GUARD_SHARED_VERSION, POOL_SHARED_VERSION, GLOBAL_CONFIG_SHARED_VERSION,
  CLOCK_SHARED_VERSION, REWARDER_VAULT_SHARED_VERSION, DEPLOYER,
} from './addresses.js';

const EMIT_BYTES = process.argv.includes('--emit-bytes');

/**
 * The guard to operate on, overridable by env.
 *
 * A guard is emptied for good when its position is exited, and the next `create`
 * mints a new one with a new id, so "which guard" is runtime state rather than a
 * constant. The server owns that value and passes both of these; addresses.js is
 * only the fallback, so that running this script by hand still works.
 */
const GUARD = process.env.GUARD_ID || GUARD_ID;
const GUARD_VERSION = Number(process.env.GUARD_SHARED_VERSION || GUARD_SHARED_VERSION);

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

  tx.moveCall({
    target: `${PACKAGE_LATEST_ID}::position_guard::redeem_with_rewards`,
    typeArguments: [USDC_TYPE, SUI_TYPE, REWARD_TYPE],
    arguments: [
      tx.sharedObjectRef({
        objectId: GUARD, initialSharedVersion: GUARD_VERSION, mutable: true,
      }),
      tx.sharedObjectRef({
        objectId: GLOBAL_CONFIG_ID, initialSharedVersion: GLOBAL_CONFIG_SHARED_VERSION, mutable: false,
      }),
      tx.sharedObjectRef({
        objectId: POOL_ID, initialSharedVersion: POOL_SHARED_VERSION, mutable: true,
      }),
      // OwnerCap, not the agent — this is the owner's unilateral exit.
      tx.object(OWNER_CAP_ID),
      tx.sharedObjectRef({
        objectId: REWARDER_VAULT_ID,
        initialSharedVersion: REWARDER_VAULT_SHARED_VERSION,
        mutable: true,
      }),
      tx.sharedObjectRef({
        objectId: CLOCK_ID, initialSharedVersion: CLOCK_SHARED_VERSION, mutable: false,
      }),
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
    step: 'position_guard::redeem_with_rewards',
    sender,
    note: 'owner-only exit; requires no agent cooperation',
    ok,
    status,
  }, null, 2));

  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
