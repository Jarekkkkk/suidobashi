/* Swap dry run — exercises `policy::swap_and_route` against the live Cetus pool.
 *
 * This is the step that has never executed anywhere. The Cetus CLMM swap is a
 * flash swap: output is delivered up front and the input is repaid afterwards,
 * with repayment asserting EXACT equality against `pay_amount`. Our module
 * splits the spent balance to exactly that figure and routes both the output and
 * any remainder to `policy.destination`.
 *
 * Everything here mirrors the real execution path:
 *   - the pool is the allowlisted one, and `swap_and_route` re-checks that
 *   - SUI→USDC is b2a, so a2b = false, matching `Pool<USDC, SUI>`
 *   - the price limit is derived from the pool's LIVE sqrt price, not a constant
 *     and not the aggregator's quote, because the pool is what fills us
 *
 * `simulateTransaction` runs it against real mainnet state and discards the
 * result. Any abort code we see here is the real one we would hit on execution.
 *
 * Usage:
 *   node src/swap.js                 dry-run
 *   node src/swap.js --emit-bytes    base64 bytes for the wallet to sign
 */
import 'dotenv/config';
import {
  PACKAGE_LATEST_ID, VAULT_ID, POLICY_ID, POOL_ID, GLOBAL_CONFIG_ID, CLOCK_ID,
  SUI_TYPE, USDC_TYPE, SWAP_AMOUNT_MIST, SLIPPAGE_BPS,
  VAULT_SHARED_VERSION, POLICY_SHARED_VERSION, CLOCK_SHARED_VERSION,
  POOL_SHARED_VERSION, GLOBAL_CONFIG_SHARED_VERSION, DEPLOYER,
} from './addresses.js';
// For MESSAGES only. The transaction still carries the integer.
import { mistToSui } from './web/units.js';

const EMIT_BYTES = process.argv.includes("--emit-bytes");
// Amount is overridable so the same script can size the swap to a target.
const AMOUNT_MIST = BigInt(process.env.SWAP_MIST ?? SWAP_AMOUNT_MIST.toString());
// Which hire's gate to route through. Defaults to the standard one; the intent
// layer passes a hire's policy when the user names one. This selects a gate, it
// does not widen one — the limits live on-chain.
const POLICY_OVERRIDE = process.env.SWAP_POLICY_ID || POLICY_ID;
const POLICY_SHARED_OVERRIDE = Number(
  process.env.SWAP_POLICY_SHARED ?? POLICY_SHARED_VERSION,
);
// And which venue. Each hire may be allowlisted on a different pool, so the pool
// travels with the policy — routing to the wrong one aborts EPoolNotAllowed
// rather than silently trading somewhere the hire was never granted.
const POOL_OVERRIDE = process.env.SWAP_POOL_ID || POOL_ID;
const POOL_SHARED_OVERRIDE = Number(process.env.SWAP_POOL_SHARED ?? POOL_SHARED_VERSION);

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const sender = process.env.SUI_SENDER || DEPLOYER;
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  // Refuse before building when the vault cannot cover the swap.
  //
  // Without this the failure surfaces as `InsufficientGas` from the resolver, which
  // points at the wrong thing entirely: a simulation that cannot complete yields no
  // gas estimate, and the resolver reports the missing estimate rather than the
  // missing funds. Same reasoning as deposit-liquidity.js, which checks its funds
  // before building for exactly this reason.
  const vaultBal = await client.getBalance({ owner: VAULT_ID, coinType: SUI_TYPE });
  const held = BigInt(vaultBal.balance?.balance ?? 0);
  if (held < AMOUNT_MIST) {
    throw new Error(`cannot swap ${mistToSui(AMOUNT_MIST)} SUI — the vault holds ${mistToSui(held)}. `
      + 'Fund the vault first: the swap draws from the vault, not from the wallet.');
  }

  // Read the pool's live price. The limit is a bound relative to now, so a stale
  // constant would either abort immediately or grant more slippage than intended.
  const poolObj = await client.getObject({ objectId: POOL_OVERRIDE, include: { json: true } });
  const poolJson = (poolObj.object ?? poolObj).json ?? {};
  const currentSqrtPrice = BigInt(String(poolJson.current_sqrt_price));
  if (currentSqrtPrice === 0n) throw new Error('could not read current_sqrt_price');

  // b2a moves the price UP, so the limit sits above current. 1% tolerance.
  const sqrtPriceLimit = (currentSqrtPrice * (10_000n + SLIPPAGE_BPS)) / 10_000n;

  const tx = new Transaction();
  tx.setSender(sender);

  tx.moveCall({
    target: `${PACKAGE_LATEST_ID}::policy::swap_and_route`,
    // Pool<A, B> is Pool<USDC, SUI>.
    typeArguments: [USDC_TYPE, SUI_TYPE],
    arguments: [
      tx.sharedObjectRef({
        objectId: POLICY_OVERRIDE,
        initialSharedVersion: POLICY_SHARED_OVERRIDE,
        mutable: true,
      }),
      tx.sharedObjectRef({
        objectId: VAULT_ID,
        initialSharedVersion: VAULT_SHARED_VERSION,
        mutable: true,
      }),
      tx.sharedObjectRef({
        objectId: GLOBAL_CONFIG_ID,
        initialSharedVersion: GLOBAL_CONFIG_SHARED_VERSION,
        mutable: false,
      }),
      tx.sharedObjectRef({
        objectId: POOL_OVERRIDE,
        initialSharedVersion: POOL_SHARED_OVERRIDE,
        mutable: true,
      }),
      tx.pure.bool(false),                 // a2b = false → SUI in, USDC out
      tx.pure.u64(AMOUNT_MIST),
      tx.pure.u128(sqrtPriceLimit),
      tx.sharedObjectRef({
        objectId: CLOCK_ID,
        initialSharedVersion: CLOCK_SHARED_VERSION,
        mutable: false,
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
    step: 'policy::swap_and_route SUI -> USDC',
    sender,
    pool: POOL_OVERRIDE,
    a2b: false,
    amountMist: AMOUNT_MIST.toString(),
    currentSqrtPrice: currentSqrtPrice.toString(),
    sqrtPriceLimit: sqrtPriceLimit.toString(),
    slippageBps: SLIPPAGE_BPS.toString(),
    ok,
    status,
  }, null, 2));

  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
