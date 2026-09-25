/* Refund an expired order: return the escrow to its maker.
 *
 * The escape hatch, and the reason an unfillable order is not a trap. After
 * `expires_at_ms` anyone may call this, and the funds always go to the MAKER — not to
 * the caller. That asymmetry is deliberate: since the destination is not the caller,
 * a stranger triggering it can only help, and an order nobody can fill cannot sit
 * holding someone's money forever.
 *
 * Permissionless, so the signer here does not have to be the maker. The agent's key
 * works, which means an expired order can be cleaned up by the party most likely to
 * notice it.
 *
 * Before expiry this aborts with ENotExpired, which is worth seeing once: it is the
 * guard that stops a maker racing their own order while a settler is filling it.
 *
 * Usage:
 *   ORDER_ID=0x… node src/refund-order.js              dry-run
 *   ORDER_ID=0x… node src/refund-order.js --execute    signs and submits
 */
import 'dotenv/config';
import {
  PACKAGE_LATEST_ID, POLICY_ID, SUI_TYPE, CLOCK_ID, CLOCK_SHARED_VERSION,
} from './addresses.js';

const EXECUTE = process.argv.includes('--execute');
const ORDER_ID = process.env.ORDER_ID || process.argv.find((a) => a.startsWith('0x'));

async function main() {
  if (!ORDER_ID) throw new Error('ORDER_ID is required (the expired order object id)');

  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  const orderObj = await client.getObject({ objectId: ORDER_ID, include: { json: true } });
  const o = orderObj.object ?? orderObj;
  const sharedVersion = o.owner?.Shared?.initialSharedVersion;
  if (!sharedVersion) throw new Error(`${ORDER_ID} is not a shared object — an order should be`);
  const expiresAtMs = Number(o.json?.expires_at_ms ?? 0);

  // The signer is whoever runs it. Refund is ungated on chain, so this is only about
  // who pays gas — not about who receives, which is always the maker.
  const signerAddress = process.env.AGENT_ADDRESS
    || (await (async () => {
      const p = await client.getObject({ objectId: POLICY_ID, include: { json: true } });
      return (p.object ?? p).json?.agent;
    })());
  if (!signerAddress) throw new Error('no signer address — set AGENT_ADDRESS');

  const tx = new Transaction();
  tx.setSender(signerAddress);
  tx.moveCall({
    target: `${PACKAGE_LATEST_ID}::order::refund`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.sharedObjectRef({
        objectId: ORDER_ID, initialSharedVersion: Number(sharedVersion), mutable: true,
      }),
      tx.sharedObjectRef({
        objectId: CLOCK_ID, initialSharedVersion: CLOCK_SHARED_VERSION, mutable: false,
      }),
    ],
  });

  const bytes = await tx.build({ client });

  if (!EXECUTE) {
    const res = await client.simulateTransaction({ transaction: bytes });
    const status = res?.Transaction?.status ?? res?.status ?? null;
    const ok = status?.success === true || status?.status === 'success';
    const nowMs = Date.now();
    console.log(JSON.stringify({
      mode: 'dry-run',
      step: 'refund an expired order',
      signer: signerAddress,
      order: ORDER_ID,
      maker: o.json?.maker ?? null,
      funds: o.json?.funds ?? null,
      expiresAtMs,
      hoursUntilRefundable: Math.max(0, Math.round((expiresAtMs - nowMs) / 3600000 * 10) / 10),
      agentKeyConfigured: Boolean(process.env.AGENT_SECRET_KEY),
      ok,
      status,
    }, null, 2));
    if (!ok) process.exit(1);
    return;
  }

  const secret = process.env.AGENT_SECRET_KEY;
  if (!secret) throw new Error('AGENT_SECRET_KEY is required for --execute');
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');
  const { secretKey } = decodeSuiPrivateKey(secret);
  const signer = Ed25519Keypair.fromSecretKey(secretKey);

  const sent = await client.signAndExecuteTransaction({ transaction: bytes, signer });
  const result = sent?.Transaction ?? sent?.FailedTransaction ?? sent ?? {};
  console.log(JSON.stringify({
    mode: 'executed',
    step: 'refund an expired order',
    order: ORDER_ID,
    maker: o.json?.maker ?? null,
    funds: o.json?.funds ?? null,
    digest: result.digest ?? null,
    status: result.status ?? null,
  }, null, 2));
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
