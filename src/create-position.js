/* Create a PositionGuard around a new Cetus CLMM position.
 *
 * Opens a position on the pinned pool and embeds it in a shared guard
 * immediately, so no caller ever holds it — not even the owner. After this the
 * position is reachable only through the guard's own operations.
 *
 * Targeted at the version-2 package id, because a module added in an upgrade is
 * callable only at the new version id. Types keep their original-id identity, so
 * the OwnerCap minted before the upgrade is still the type the guard expects.
 *
 * Range must be aligned to the pool's tick spacing (10), and it sits inside the
 * policy bounds the agent will be held to — width 1000 against bounds 100..2000.
 *
 * Usage:
 *   node src/create-position.js                 dry-run
 *   node src/create-position.js --emit-bytes    print the bytes to be signed
 *
 * There is no `--execute` path and this script holds no key: it builds a
 * transaction and either simulates it or prints it. Signing is done by the wallet
 * extension, and the server submits bytes plus the signature it was handed.
 */
import 'dotenv/config';
import {
  PACKAGE_V2_ID, VAULT_ID, OWNER_CAP_ID, POOL_ID, GLOBAL_CONFIG_ID,
  USDC_TYPE, SUI_TYPE, POOL_TICK_SPACING,
  POOL_SHARED_VERSION, GLOBAL_CONFIG_SHARED_VERSION,
  DEPLOYER,
} from './addresses.js';

// Centred on the pool's current tick (68964), aligned to the 10-tick spacing.
const TICK_LOWER = 68_460;
const TICK_UPPER = 69_460;
const MIN_TICK_WIDTH = 100;
const MAX_TICK_WIDTH = 2_000;

const EMIT_BYTES = process.argv.includes('--emit-bytes');

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const sender = process.env.SUI_SENDER || DEPLOYER;
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  if (TICK_LOWER % POOL_TICK_SPACING !== 0 || TICK_UPPER % POOL_TICK_SPACING !== 0) {
    throw new Error(`ticks must be multiples of the pool's spacing (${POOL_TICK_SPACING})`);
  }

  const tx = new Transaction();
  tx.setSender(sender);

  tx.moveCall({
    target: `${PACKAGE_V2_ID}::position_guard::create`,
    // Pool<CoinTypeA, CoinTypeB> is Pool<USDC, SUI>.
    typeArguments: [USDC_TYPE, SUI_TYPE],
    arguments: [
      tx.sharedObjectRef({
        objectId: GLOBAL_CONFIG_ID,
        initialSharedVersion: GLOBAL_CONFIG_SHARED_VERSION,
        mutable: false,
      }),
      tx.sharedObjectRef({
        objectId: POOL_ID,
        initialSharedVersion: POOL_SHARED_VERSION,
        mutable: true,
      }),
      tx.pure.id(VAULT_ID),
      tx.object(OWNER_CAP_ID),
      tx.pure.address(process.env.SUI_AGENT_ADDRESS || sender),
      tx.pure.address(process.env.SUI_DESTINATION || sender),
      tx.pure.u32(TICK_LOWER),
      tx.pure.u32(TICK_UPPER),
      tx.pure.u32(MIN_TICK_WIDTH),
      tx.pure.u32(MAX_TICK_WIDTH),
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
    step: 'position_guard::create',
    package: PACKAGE_V2_ID,
    sender,
    pool: POOL_ID,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    tickWidth: TICK_UPPER - TICK_LOWER,
    bounds: [MIN_TICK_WIDTH, MAX_TICK_WIDTH],
    ok,
    status,
  }, null, 2));

  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
