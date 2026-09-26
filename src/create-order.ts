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
 *   node src/create-order.js                 dry-run, SUI -> USDC
 *   node src/create-order.js --emit-bytes    base64 bytes for the wallet to sign
 *   ORDER_DIRECTION=USDC->SUI node src/create-order.js
 */
import 'dotenv/config';
import {
  PACKAGE_LATEST_ID, POOL_ID, CLOCK_ID, CLOCK_SHARED_VERSION, DEPLOYER,
  POLICY_ID, POLICY_SHARED_VERSION, VAULT_ID, VAULT_SHARED_VERSION,
  DIRECTIONS, type Direction,
} from './addresses.js';
import { fromUnits } from './web/units.js';

const EMIT_BYTES = process.argv.includes('--emit-bytes');

/**
 * WHICH WAY, and the only place this script learns anything direction-specific.
 *
 * The coin types, the decimals and the settle side all come from `DIRECTIONS` in addresses.ts, so
 * a direction cannot be known here and unknown to the filler. Before that table existed this file
 * carried `SUI_TYPE` in four places and "0.01 USDC" in two comments.
 */
const DIRECTION = String(process.env.ORDER_DIRECTION ?? 'SUI->USDC') as Direction;
const DIR = DIRECTIONS[DIRECTION];
if (!DIR) {
  throw new Error(
    `ORDER_DIRECTION must be one of ${Object.keys(DIRECTIONS).join(', ')}, not "${DIRECTION}"`,
  );
}

/**
 * The legacy name, REFUSED rather than reinterpreted when the input is not SUI.
 *
 * `ORDER_AMOUNT_MIST` means MIST, and MIST only ever meant SUI. For a USDC input those digits are
 * a thousandfold wrong, and silently reading them as USDC would escrow 0.00001 instead of 0.01 — a
 * quiet unit error, in a script the user runs by hand. An old command should fail loudly.
 */
const LEGACY_AMOUNT = process.env.ORDER_AMOUNT_MIST;
if (LEGACY_AMOUNT !== undefined && DIR.in.symbol !== 'SUI') {
  throw new Error(
    `ORDER_AMOUNT_MIST is in MIST and this direction escrows ${DIR.in.symbol} — the digits would be `
    + `read a thousandfold wrong. Use ORDER_AMOUNT_IN (in ${DIR.in.symbol}'s smallest unit).`,
  );
}

/** What you are putting in, in the INPUT coin's smallest unit. 0.01 of it, so a test is cheap. */
const DEFAULT_AMOUNT_IN = 10n ** BigInt(DIR.in.decimals) / 100n;
const AMOUNT_IN = BigInt(process.env.ORDER_AMOUNT_IN ?? LEGACY_AMOUNT ?? DEFAULT_AMOUNT_IN);
/**
 * The least output you will accept, and the fee you will pay for a fill.
 *
 * BOTH ARE IN THE OUTPUT COIN, which is a property of the contract rather than of the direction:
 * the fee is paid out of the proceeds, so it is denominated in whatever the swap produces. For
 * SUI -> USDC that is USDC; for USDC -> SUI it is SUI, and the filler is then paid in the same
 * asset it spends on gas instead of having to sell the fee first.
 *
 * `min_out` is what you RECEIVE, so the fee sits ON TOP of it rather than inside: a floor of 5
 * USDC means 5 USDC lands in your wallet and the fee is paid from above that.
 *
 * The defaults are 0.5% and 1% of ONE WHOLE OUTPUT COIN. Those are not new figures — they are the
 * old flat USDC defaults (0.005 and 0.01), written so they stay the right size when the output is
 * SUI. A flat 10000 would have meant 0.00001 SUI, which is a fee that pays for nothing.
 */
const DEFAULT_MIN_OUT = 50n * 10n ** BigInt(DIR.out.decimals) / 10_000n;   // 0.50%
const MIN_OUT = BigInt(process.env.ORDER_MIN_OUT ?? DEFAULT_MIN_OUT);
/**
 * 1% of one whole output coin — 0.01 USDC, or 0.01 SUI. THE FILLER'S FLOOR, `MCP_MIN_FEE_OUT`.
 *
 * IT MUST STAY AN ABSOLUTE NUMBER. A fee below the filler's minimum is refused by the reference
 * filler, so an order carrying one escrows money nobody takes — worse than not building it. Scaling
 * this with the trade was tried and produced exactly that: 0.01 SUI orders with a 0.000012 USDC fee.
 *
 * The consequence is a MINIMUM TRADE SIZE, which is real rather than a bug: the output has to cover
 * this plus something for the maker. The app derives that threshold from the live quote and says so
 * in the refusal.
 */
const DEFAULT_FEE_OUT = 100n * 10n ** BigInt(DIR.out.decimals) / 10_000n;  // 1.00%
const FEE_OUT = BigInt(process.env.ORDER_FEE_OUT ?? DEFAULT_FEE_OUT);
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
  const escrow = coinWithBalance({ type: DIR.in.type, balance: AMOUNT_IN });

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
    // The INPUT coin, and the only thing that decides which side of the pool this order sits on.
    // Whoever fills it reads this back off the object's type and picks `settle_a2b` or `settle_b2a`.
    typeArguments: [DIR.in.type],
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
    direction: DIRECTION,
    sender,
    escrow: fromUnits(AMOUNT_IN, DIR.in.decimals),
    escrowSymbol: DIR.in.symbol,
    minOut: fromUnits(MIN_OUT, DIR.out.decimals),
    minOutSymbol: DIR.out.symbol,
    feeOut: fromUnits(FEE_OUT, DIR.out.decimals),
    feeOutSymbol: DIR.out.symbol,
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
