/* Burn a settled order and reclaim its storage.
 *
 * Step 3 of the escrow flow, and the only step that pays YOU rather than costing you.
 * A settled order is left on chain deliberately — see docs/ORDER-ESCROW.md — so that
 * the storage rebate can be reclaimed by the maker rather than by whoever happened to
 * settle it.
 *
 * Measured on chain: a minimal transaction costs ~0.0003 SUI and a settled order's
 * storage rebate is ~0.0044 SUI, so the burn nets roughly +0.0041 — about the cost of a
 * settlement, which makes reclaiming worth the signature.
 *
 * The first version of this note estimated ~0.0018 from comparable objects. The measured
 * figure is roughly 2.4× that, and docs/ORDER-ESCROW.md records the correction; this
 * comment had kept the estimate. It is yours, and it is the reason `burn` is maker-gated
 * rather than open to anyone who notices.
 *
 * Maker-gated: `order::burn` asserts the caller is the order's maker, so a stranger
 * cannot take the rebate.
 *
 * Usage:
 *   ORDER_ID=0x… node src/burn-order.js                 dry-run
 *   ORDER_ID=0x… node src/burn-order.js --emit-bytes    base64 bytes to sign
 *   ORDER_ID=0x… node src/burn-order.js --execute       signs and submits
 *
 * --execute needs SUI_SECRET_KEY, the MAKER's key. The maker is the deployer here, not
 * the agent that filled the order: `burn` is maker-gated, so the agent's key cannot do
 * it. The key is checked against the order's maker before anything is signed.
 */
import 'dotenv/config';
import { PACKAGE_LATEST_ID, SUI_TYPE, DEPLOYER } from './addresses.js';

const EMIT_BYTES = process.argv.includes('--emit-bytes');
const EXECUTE = process.argv.includes('--execute');
const ORDER_ID = process.env.ORDER_ID || process.argv.find((a) => a.startsWith('0x'));

async function main() {
  if (!ORDER_ID) throw new Error('ORDER_ID is required (the settled order object id)');

  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  // Read it first so the failure is legible. `burn` refuses three ways — not the
  // maker, not settled, or still holding funds — and each of those is much clearer
  // when the object's state is known before building.
  const obj = await client.getObject({ objectId: ORDER_ID, include: { json: true } });
  const order = (obj.object ?? obj).json ?? {};
  if (!order.maker) throw new Error(`${ORDER_ID} does not look like an order`);

  // --execute needs the key BEFORE the bytes are built, because the sender is part of what
  // gets signed: signing as one address while the transaction names another produces a
  // signature the chain rejects, and the failure reads as a signature problem rather than
  // the wrong key. Checked against the order's maker here, so a wrong key costs nothing
  // and says exactly what is wrong.
  let signer = null;
  if (EXECUTE) {
    const secret = process.env.SUI_SECRET_KEY;
    if (!secret) {
      throw new Error('SUI_SECRET_KEY is required for --execute (suiprivkey1… form). The '
        + 'burn is maker-gated, and the maker is the deployer — not the agent that filled it.');
    }
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');
    const { secretKey } = decodeSuiPrivateKey(secret);
    signer = Ed25519Keypair.fromSecretKey(secretKey);
    if (signer.toSuiAddress() !== String(order.maker).toLowerCase()) {
      throw new Error(`the key signs as ${signer.toSuiAddress()}, but the maker is `
        + `${order.maker} — order::burn would refuse this`);
    }
  }

  const sender = signer ? signer.toSuiAddress() : (process.env.SUI_SENDER || DEPLOYER);

  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({
    target: `${PACKAGE_LATEST_ID}::order::burn`,
    typeArguments: [SUI_TYPE],
    arguments: [tx.object(ORDER_ID)],
  });

  const bytes = await tx.build({ client });

  if (EMIT_BYTES) {
    process.stdout.write(Buffer.from(bytes).toString('base64'));
    return;
  }

  if (EXECUTE) {
    const sent = await client.signAndExecuteTransaction({ transaction: bytes, signer });
    // A failed transaction comes back under FailedTransaction, not Transaction.
    const result = sent?.Transaction ?? sent?.FailedTransaction ?? sent ?? {};
    console.log(JSON.stringify({
      mode: 'execute',
      step: 'burn a settled order',
      sender,
      order: ORDER_ID,
      digest: result.digest ?? null,
      status: result.status ?? null,
    }, null, 2));
    if (result.status?.success !== true) process.exit(1);
    return;
  }

  const res = await client.simulateTransaction({ transaction: bytes });
  const status = res?.Transaction?.status ?? res?.status ?? null;
  const ok = status?.success === true || status?.status === 'success';
  console.log(JSON.stringify({
    mode: 'dry-run',
    step: 'burn a settled order',
    sender,
    order: ORDER_ID,
    maker: order.maker,
    holds: order.funds ?? null,
    ok,
    status,
  }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
