/* Fund the guard's position — the owner's side of the arrangement.
 *
 * Takes a FIXED COIN AMOUNT on one side rather than a liquidity figure. The
 * earlier version computed CLMM liquidity here from sqrt prices, which was both
 * fiddly and slightly wrong (double precision gave a 0.4% discrepancy). Cetus's
 * `add_liquidity_fix_coin` derives the liquidity itself, so that arithmetic is
 * gone: we name an amount on one side, supply headroom on both, and whatever is
 * left over is routed back to the destination by the module.
 *
 * The owner supplies capital here, which is why this path is OwnerCap-gated
 * rather than agent-callable. Routine operation is the agent's `rebalance`.
 *
 * Usage:
 *   node src/deposit-liquidity.js                 dry-run
 *   node src/deposit-liquidity.js --emit-bytes
 */
import 'dotenv/config';
import {
  PACKAGE_LATEST_ID, GUARD_ID, OWNER_CAP_ID, POOL_ID, GLOBAL_CONFIG_ID, CLOCK_ID,
  USDC_TYPE, SUI_TYPE,
  GUARD_SHARED_VERSION, POOL_SHARED_VERSION, GLOBAL_CONFIG_SHARED_VERSION,
  CLOCK_SHARED_VERSION, DEPLOYER,
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

/** Fix the amount on the USDC side; SUI is derived from it. */
const FIX_AMOUNT = BigInt(process.env.FIX_AMOUNT ?? '500000');        // 0.50 USDC (6dp)
const FIX_AMOUNT_A = (process.env.FIX_AMOUNT_A ?? 'true') !== 'false';
/** Withdraw generous headroom on the SUI side; the surplus comes back. */
const SUPPLY_SUI = BigInt(process.env.SUPPLY_SUI ?? '600000000');     // 0.60 SUI (9dp)

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const sender = process.env.SUI_SENDER || DEPLOYER;
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  // Same reasoning as set-budget.js: check the funds before building. The module splits
  // the balances it is handed, so asking for more than is held aborts deep inside as
  // `balance::split` code 2 — which reads like a broken transaction rather than "you do
  // not have that much", and is the shape of failure a person is most likely to hit,
  // since deploying capital is exactly what spends it.
  const held = async (coinType) => {
    const b = await client.getBalance({ owner: sender, coinType });
    return BigInt(b.balance?.balance ?? 0);
  };
  const usdcHeld = await held(USDC_TYPE);
  if (FIX_AMOUNT > usdcHeld) {
    throw new Error(`cannot deploy ${FIX_AMOUNT} of USDC — this address holds ${usdcHeld}. `
      + 'Exit the position first to get the deployed capital back, or name a smaller amount.');
  }
  const suiHeld = await held(SUI_TYPE);
  if (SUPPLY_SUI > suiHeld) {
    throw new Error(`cannot supply ${SUPPLY_SUI} of SUI headroom — this address holds ${suiHeld}. `
      + 'Only part of it is consumed; the rest is returned.');
  }

  const tx = new Transaction();
  tx.setSender(sender);

  const guard = tx.sharedObjectRef({
    objectId: GUARD, initialSharedVersion: GUARD_VERSION, mutable: true,
  });
  const config = tx.sharedObjectRef({
    objectId: GLOBAL_CONFIG_ID, initialSharedVersion: GLOBAL_CONFIG_SHARED_VERSION, mutable: false,
  });
  const pool = tx.sharedObjectRef({
    objectId: POOL_ID, initialSharedVersion: POOL_SHARED_VERSION, mutable: true,
  });
  const clock = tx.sharedObjectRef({
    objectId: CLOCK_ID, initialSharedVersion: CLOCK_SHARED_VERSION, mutable: false,
  });
  const ownerCap = tx.object(OWNER_CAP_ID);

  // SUI side: withdraw from the live address balance and redeem into a Balance.
  const withdrawal = tx.withdrawal({ amount: SUPPLY_SUI, type: SUI_TYPE });
  const fundsSui = tx.moveCall({
    target: '0x2::balance::redeem_funds',
    typeArguments: [SUI_TYPE],
    arguments: [withdrawal],
  });

  // USDC side: consolidate whatever coins exist, then convert to a Balance.
  const coins = await client.listCoins({ owner: sender, coinType: USDC_TYPE });
  const usdcCoins = coins.objects ?? [];
  if (usdcCoins.length === 0) throw new Error('no USDC coins to deploy');

  const primary = tx.object(usdcCoins[0].objectId);
  if (usdcCoins.length > 1) {
    tx.mergeCoins(primary, usdcCoins.slice(1).map((c) => tx.object(c.objectId)));
  }
  const fundsUsdc = tx.moveCall({
    target: '0x2::coin::into_balance',
    typeArguments: [USDC_TYPE],
    arguments: [primary],
  });

  tx.moveCall({
    target: `${PACKAGE_LATEST_ID}::position_guard::deposit_liquidity_fix`,
    typeArguments: [USDC_TYPE, SUI_TYPE],
    arguments: [
      guard, config, pool, ownerCap,
      tx.pure.u64(FIX_AMOUNT),
      tx.pure.bool(FIX_AMOUNT_A),
      clock,
      fundsUsdc,
      fundsSui,
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
    step: 'position_guard::deposit_liquidity (fix coin)',
    sender,
    fixAmount: FIX_AMOUNT.toString(),
    fixAmountA: FIX_AMOUNT_A,
    supplySui: SUPPLY_SUI.toString(),
    usdcCoinCount: usdcCoins.length,
    ok,
    status,
  }, null, 2));

  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
