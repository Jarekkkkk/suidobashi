/* Fill a swap order: swap the escrowed funds and deliver at least the maker's minimum.
 *
 * This is step 2 of the escrow flow, and it is the AGENT's transaction. Everything
 * happens in this one transaction — the swap, the minimum check and the delivery —
 * because if the agent could take the escrowed funds and deliver later, the escrow
 * would be worthless.
 *
 * The agent never holds the value at any point: the output goes from the pool
 * straight to the maker's destination. So there is nothing to skim, and the agent's
 * income is the service fee rather than a spread on the trade.
 *
 * Signing: this process signs, using the agent key from AGENT_SECRET_KEY. That is the
 * one place in this project where a key lives inside a process, and it is deliberate
 * — the agent key holds no funds, only a bounded permission.
 *
 * A DRY RUN NEEDS NO KEY. The simulation checks the caller, so `--dry-run` proves the
 * gates pass before you go looking for the key.
 *
 * Usage:
 *   ORDER_ID=0x… node src/settle-order.js              dry-run, no key needed
 *   ORDER_ID=0x… node src/settle-order.js --execute    signs and submits
 */
import 'dotenv/config';
import {
  PACKAGE_LATEST_ID, POLICY_ID, POLICY_SHARED_VERSION, POOL_ID, POOL_SHARED_VERSION,
  GLOBAL_CONFIG_ID, GLOBAL_CONFIG_SHARED_VERSION, CLOCK_ID, CLOCK_SHARED_VERSION,
  USDC_TYPE, SUI_TYPE, SLIPPAGE_BPS,
} from './addresses.js';

const EXECUTE = process.argv.includes('--execute');

const ORDER_ID = process.env.ORDER_ID || process.argv.find((a) => a.startsWith('0x'));

/**
 * Which side of the pool the order's coin sits on. A SUI order against
 * Pool<USDC, SUI> is side B, so it settles through `settle_b2a`. Move is statically
 * typed and cannot infer this, which is why there are two entry points.
 */
const SIDE = (process.env.ORDER_SIDE ?? 'b').toLowerCase();

async function main() {
  if (!ORDER_ID) throw new Error('ORDER_ID is required (the order object id)');

  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  // The agent is READ FROM THE POLICY rather than hardcoded. It is the policy's own
  // `agent` field that the gate checks, so reading it here means the sender can never
  // drift from the grant — and a typo'd constant cannot send the transaction as the
  // wrong caller, which would fail the gate with a confusing ENotAgent.
  const policyObj = await client.getObject({ objectId: POLICY_ID, include: { json: true } });
  const agent = process.env.AGENT_ADDRESS || (policyObj.object ?? policyObj).json?.agent;
  if (!agent) throw new Error('could not read the policy agent');

  // Read the pool's live price so the limit is a bound relative to now. With a
  // maker-committed minimum the limit is no longer the protection — that is the
  // minimum, asserted against the actual output — but a sane limit still avoids
  // handing the pool a nonsense bound.
  const poolObj = await client.getObject({ objectId: POOL_ID, include: { json: true } });
  const poolJson = (poolObj.object ?? poolObj).json ?? {};
  const currentSqrtPrice = BigInt(String(poolJson.current_sqrt_price));
  if (currentSqrtPrice === 0n) throw new Error('could not read current_sqrt_price');
  const sqrtPriceLimit = (currentSqrtPrice * (10_000n + SLIPPAGE_BPS)) / 10_000n;

  const tx = new Transaction();
  tx.setSender(agent);

  const policy = tx.sharedObjectRef({
    objectId: POLICY_ID, initialSharedVersion: POLICY_SHARED_VERSION, mutable: false,
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

  const order = tx.object(ORDER_ID);

  // Pool<A, B> is Pool<USDC, SUI>, so a SUI order is side B and settles b2a.
  if (SIDE === 'b') {
    tx.moveCall({
      target: `${PACKAGE_LATEST_ID}::order::settle_b2a`,
      typeArguments: [USDC_TYPE, SUI_TYPE],
      arguments: [policy, order, config, pool, tx.pure.u128(sqrtPriceLimit), clock],
    });
  } else {
    tx.moveCall({
      target: `${PACKAGE_LATEST_ID}::order::settle_a2b`,
      typeArguments: [USDC_TYPE, SUI_TYPE],
      arguments: [policy, order, config, pool, tx.pure.u128(sqrtPriceLimit), clock],
    });
  }

  const bytes = await tx.build({ client });

  if (!EXECUTE) {
    const res = await client.simulateTransaction({ transaction: bytes });
    const status = res?.Transaction?.status ?? res?.status ?? null;
    const ok = status?.success === true || status?.status === 'success';
    console.log(JSON.stringify({
      mode: 'dry-run',
      step: `fill order (settle_${SIDE}2${SIDE === 'b' ? 'a' : 'b'})`,
      agent,
      order: ORDER_ID,
      sqrtPriceLimit: sqrtPriceLimit.toString(),
      // Reported, never printed: a dry run should tell you whether --execute would
      // work without making you go and look at the file.
      agentKeyConfigured: Boolean(process.env.AGENT_SECRET_KEY),
      note: 'no key used — the simulation checks the caller, so this proves the gates pass',
      ok,
      status,
    }, null, 2));
    if (!ok) process.exit(1);
    return;
  }

  // === the only place this process touches a key ===
  const secret = process.env.AGENT_SECRET_KEY;
  if (!secret) {
    throw new Error('AGENT_SECRET_KEY is required for --execute. The dry run needs no key; '
      + 'export the agent key only when you are ready to submit.');
  }
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');
  const { secretKey } = decodeSuiPrivateKey(secret);
  const signer = Ed25519Keypair.fromSecretKey(secretKey);

  const sent = await client.signAndExecuteTransaction({ transaction: bytes, signer });
  const digest = sent?.Transaction?.digest ?? sent?.digest ?? null;
  const status = sent?.Transaction?.status ?? sent?.status ?? null;
  console.log(JSON.stringify({
    mode: 'executed',
    step: `fill order (settle_${SIDE}2${SIDE === 'b' ? 'a' : 'b'})`,
    agent,
    order: ORDER_ID,
    digest,
    status,
  }, null, 2));
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
