/* Rebalance the guard's position — the agent's routine operation.
 *
 * Moves the range in one atomic call: our module removes all liquidity, collects
 * fees, closes the old position, opens the new range, and repays the new receipt
 * with the balances it just freed. The freed value never becomes a transaction
 * value the caller could redirect — it is consumed inside the module and the
 * remainder is routed to the owner's destination.
 *
 * Direction matters for a safe first run. The module re-adds exactly the removed
 * liquidity, and at fixed L a NARROWER range needs less of both tokens. So
 * narrowing is covered by what was freed and any surplus returns to the owner.
 * Widening could ask for more than was freed, which aborts on the exact-equality
 * repayment — safe, but not a useful first run.
 *
 * Agent-gated: the sender must be the guard's authorised agent, and the new
 * width must sit inside the owner's bounds.
 *
 * Usage:
 *   node src/rebalance.js                 dry-run
 *   node src/rebalance.js --emit-bytes
 */
import 'dotenv/config';
import {
  PACKAGE_LATEST_ID, GUARD_ID, POOL_ID, GLOBAL_CONFIG_ID, CLOCK_ID,
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

// Narrower than the current 1000-wide range, centred on the live tick.
const NEW_TICK_LOWER = Number(process.env.NEW_TICK_LOWER ?? 68_800);
const NEW_TICK_UPPER = Number(process.env.NEW_TICK_UPPER ?? 69_200);

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const sender = process.env.SUI_SENDER || DEPLOYER;
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  const poolObj = await client.getObject({ objectId: POOL_ID, include: { json: true } });
  const poolJson = (poolObj.object ?? poolObj).json ?? {};
  const currentTick = Number(poolJson.current_tick_index?.bits ?? poolJson.current_tick_index ?? 0);

  const tx = new Transaction();
  tx.setSender(sender);

  tx.moveCall({
    target: `${PACKAGE_LATEST_ID}::position_guard::rebalance_with_rewards`,
    // Third type argument is the pool's reward coin. Cetus refuses to close a
    // position while any reward is still owed, and Move cannot iterate runtime
    // types, so the reward type has to be named here.
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
      // Cetus's rewarder vault, which holds reward emissions and must be passed
      // mutably so `collect_reward` can draw the accrued CETUS out.
      tx.sharedObjectRef({
        objectId: REWARDER_VAULT_ID,
        initialSharedVersion: REWARDER_VAULT_SHARED_VERSION,
        mutable: true,
      }),
      tx.pure.u32(NEW_TICK_LOWER),
      tx.pure.u32(NEW_TICK_UPPER),
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
  const status = res?.Transaction?.status ?? res?.status ?? null;
  const ok = status?.success === true || status?.status === 'success';

  console.log(JSON.stringify({
    mode: 'dry-run',
    step: 'position_guard::rebalance',
    sender,
    currentTick,
    from: { lower: 68_460, upper: 69_460, width: 1_000 },
    to: { lower: NEW_TICK_LOWER, upper: NEW_TICK_UPPER, width: NEW_TICK_UPPER - NEW_TICK_LOWER },
    inRangeAfter: currentTick > NEW_TICK_LOWER && currentTick < NEW_TICK_UPPER,
    ok,
    status,
  }, null, 2));

  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
