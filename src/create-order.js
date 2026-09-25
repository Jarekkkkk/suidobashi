/* Create a swap order: escrow the input and commit the least output you will accept.
 *
 * This is step 1 of the escrow flow, and it is the MAKER's transaction — the only
 * one where the money moves. The coin leaves your wallet here and sits inside the
 * order object until someone fills it, or until it expires and anyone refunds it.
 *
 * Why escrow rather than an allowance: an allowance lets an agent spend from a vault
 * and the price is then the agent's choice, bounded only by a check it can walk
 * around by naming an older package id. Here the funds are somewhere the old swap
 * path cannot reach, and the minimum is asserted by the same function that moves
 * them. That is the difference between a guard against mistakes and a boundary
 * against an adversary.
 *
 * Usage:
 *   node src/create-order.js                 dry-run
 *   node src/create-order.js --emit-bytes    base64 bytes for the wallet to sign
 */
import 'dotenv/config';
import {
  PACKAGE_LATEST_ID, POOL_ID, SUI_TYPE, CLOCK_ID, CLOCK_SHARED_VERSION, DEPLOYER,
} from './addresses.js';

const EMIT_BYTES = process.argv.includes('--emit-bytes');

/** What you are putting in. Small by default so a test is cheap. */
const AMOUNT_MIST = BigInt(process.env.ORDER_AMOUNT_MIST ?? '10000000');   // 0.01 SUI
/**
 * The least output you will accept, in USDC's 6 decimals. Set this to the worst
 * price you would still take — it is enforced by the same function that moves the
 * funds, so it cannot be undercut.
 */
const MIN_OUT = BigInt(process.env.ORDER_MIN_OUT ?? '5000');               // 0.005 USDC
/** How long the order stays open. After this, ANYONE may refund it — to you. */
const TTL_MS = BigInt(process.env.ORDER_TTL_MS ?? String(24 * 60 * 60 * 1000)); // 24h
const POOL = process.env.ORDER_POOL_ID || POOL_ID;
/** Where the output lands. Defaults to you; the settler cannot change it. */
const DESTINATION = process.env.ORDER_DESTINATION || DEPLOYER;

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction, coinWithBalance } = await import('@mysten/sui/transactions');

  const sender = process.env.SUI_SENDER || DEPLOYER;
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  const tx = new Transaction();
  tx.setSender(sender);

  // A coin of exactly this much, resolved from the sender's coins and address
  // balance at build time. `create` takes a Coin, not a Balance.
  const escrow = coinWithBalance({ type: SUI_TYPE, balance: AMOUNT_MIST });

  const clock = tx.sharedObjectRef({
    objectId: CLOCK_ID, initialSharedVersion: CLOCK_SHARED_VERSION, mutable: false,
  });

  // The expiry is absolute on chain, so read the clock rather than guessing it: a
  // TTL computed against a stale local clock could produce an already-expired order,
  // which `create` refuses.
  const nowMs = BigInt(Date.now());
  const expiresAtMs = nowMs + TTL_MS;

  tx.moveCall({
    target: `${PACKAGE_LATEST_ID}::order::create`,
    typeArguments: [SUI_TYPE],
    arguments: [
      escrow,
      tx.pure.id(POOL),
      tx.pure.u64(MIN_OUT),
      tx.pure.u64(expiresAtMs),
      tx.pure.address(DESTINATION),
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
    mode: 'dry-run',
    step: 'escrow a swap order',
    sender,
    escrowSui: (Number(AMOUNT_MIST) / 1e9).toString(),
    minOutUsdc: (Number(MIN_OUT) / 1e6).toString(),
    pool: POOL,
    destination: DESTINATION,
    expiresAtMs: expiresAtMs.toString(),
    ok,
    status,
  }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
