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
  POLICY_ID, POLICY_SHARED_VERSION, VAULT_ID, VAULT_SHARED_VERSION,
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
/**
 * What you will pay whoever fills this, in USDC — the OUTPUT coin, so it comes out of
 * the proceeds rather than needing a second balance. Zero means no fee, and is stored
 * as absence.
 *
 * `min_out` is what you RECEIVE, so the fee is on top of it rather than inside it: a
 * floor of 5 USDC means 5 USDC lands in your wallet and the fee is paid from above
 * that. Whoever fills the order collects, so no recipient is named.
 *
 * 0.01 USDC is a DEFAULT, not a price — the fee is declared per order, so this is what
 * you offer unless you change it. And it has to clear what a fill COSTS the filler,
 * which is measured rather than estimated:
 *
 *   a fill pays     0.01 USDC             = $0.0100
 *   a fill costs    gas 0.00557 SUI x ~$1.14 = $0.0064   (measured from a real fill)
 *   margin                                = $0.0036
 *
 * The first version of this comment used an ESTIMATED gas of 0.0043 SUI and set the
 * fee to 0.005, which read as break-even and was in fact a loss: 0.005 against a real
 * cost of 0.0064. A filler that loses money on every fill is a service that cannot
 * run, so the estimate being wrong mattered.
 */
const FEE_OUT = BigInt(process.env.ORDER_FEE_OUT ?? '10000');   // 0.01 USDC
/**
 * How long the order stays open, in milliseconds. After this, ANYONE may refund it —
 * and the funds always go to the maker.
 *
 * ONE MINUTE, and deliberately short. A swap order is a short-lived intent, not a
 * standing offer: the maker's funds are exposed for the window, and an agent either
 * fills it inside that or gets nothing. The module imposes no lower bound, so this
 * can go shorter without any contract change.
 *
 * The consequence worth knowing: with a window this tight the REFUND is a routine
 * path rather than an edge case. An agent that misses the minute leaves the order
 * unfilled, and the maker reclaims — so the refund has to work, which is why it is
 * tested rather than assumed.
 */
const TTL_MS = BigInt(process.env.ORDER_TTL_MS ?? String(60 * 1000)); // 1 minute
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

  // `create_with_policy` rather than `create_with_fee`: it reads the maker's remaining
  // allowance from the ledger and refuses an order larger than it. Until this call changed,
  // the budget in the policy sheet bounded NOTHING reachable — it gated the vault path, which
  // nothing calls, while this escrow came out of the wallet and was checked against nothing.
  //
  // The policy and vault are read-only here. This is a bound, not a spend: the allowance is
  // not decremented, so it is a per-order ceiling rather than a running total. Making it a
  // total means moving the escrow into the vault, which is where the funds would have to live.
  //
  // Still `create_with_fee`'s shape otherwise: a zero fee is stored as absent, so it behaves
  // identically to `create` and there is one path to maintain.
  tx.moveCall({
    target: `${PACKAGE_LATEST_ID}::order::create_with_policy`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.sharedObjectRef({
        objectId: POLICY_ID,
        initialSharedVersion: POLICY_SHARED_VERSION,
        mutable: false,
      }),
      tx.sharedObjectRef({
        objectId: VAULT_ID,
        initialSharedVersion: VAULT_SHARED_VERSION,
        mutable: false,
      }),
      escrow,
      tx.pure.id(POOL),
      tx.pure.u64(MIN_OUT),
      tx.pure.u64(FEE_OUT),
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
  const status = res?.Transaction?.status ?? null;
  const ok = status?.success === true;
  console.log(JSON.stringify({
    mode: 'dry-run',
    step: 'escrow a swap order',
    sender,
    escrowSui: (Number(AMOUNT_MIST) / 1e9).toString(),
    minOutUsdc: (Number(MIN_OUT) / 1e6).toString(),
    feeOutUsdc: (Number(FEE_OUT) / 1e6).toString(),
    ttlSeconds: Number(TTL_MS / 1000n),
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
