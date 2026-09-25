/* Burn a settled order and reclaim its storage.
 *
 * Step 3 of the escrow flow, and the only step that pays YOU rather than costing you.
 * A settled order is left on chain deliberately — see docs/ORDER-ESCROW.md — so that
 * the storage rebate can be reclaimed by the maker rather than by whoever happened to
 * settle it.
 *
 * Measured on chain: a minimal transaction costs ~0.00024 SUI and an object's storage
 * rebate is ~0.0018 SUI, so the burn nets roughly 0.0018. Small, but it is yours, and
 * it is the reason `burn` is maker-gated rather than open to anyone who notices.
 *
 * Maker-gated: `order::burn` asserts the caller is the order's maker, so a stranger
 * cannot take the rebate.
 *
 * Usage:
 *   ORDER_ID=0x… node src/burn-order.js                 dry-run
 *   ORDER_ID=0x… node src/burn-order.js --emit-bytes    base64 bytes to sign
 */
import 'dotenv/config';
import { PACKAGE_LATEST_ID, SUI_TYPE, DEPLOYER } from './addresses.js';

const EMIT_BYTES = process.argv.includes('--emit-bytes');
const ORDER_ID = process.env.ORDER_ID || process.argv.find((a) => a.startsWith('0x'));

async function main() {
  if (!ORDER_ID) throw new Error('ORDER_ID is required (the settled order object id)');

  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const sender = process.env.SUI_SENDER || DEPLOYER;
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
