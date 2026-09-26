/* Set a hire's spending budget. Owner-gated, gas only — no funds move.
 *
 * The budget lives in the OZ ledger keyed by `(cap_id, coin_type)`, so each hire
 * has its own entry and its own ceiling. `set_allowance` is an upsert that
 * overwrites the entry in place — including resetting the spend tracking — which
 * is what makes this the recovery path for an exhausted hire.
 *
 * This is NOT the same as hiring: it grants or re-grants a budget against a cap
 * that already exists and is already embedded in a policy. Creating a policy is
 * `hire-agent.js --grant`, which consumes the cap by value.
 *
 * HIRE is resolved strictly. There is no fallback to the default on an unknown
 * name, because a typo silently re-granting a different hire's budget is exactly
 * the kind of mistake worth failing loudly on.
 *
 * Usage:
 *   HIRE=cautious BUDGET_MIST=10000000 node src/set-budget.js
 *   HIRE=cautious BUDGET_MIST=10000000 node src/set-budget.js --emit-bytes
 */
import 'dotenv/config';
import {
  PACKAGE_LATEST_ID, VAULT_ID, OWNER_CAP_ID, CLOCK_ID, SUI_TYPE,
  VAULT_SHARED_VERSION, CLOCK_SHARED_VERSION, DEPLOYER,
} from './addresses.js';
import { HIRES, DEFAULT_HIRE, HIRE_NAMES, type HireName } from './hires.js';
// For MESSAGES only. The transaction still carries the integer.
import { mistToSui } from './web/units.js';

const EMIT_BYTES = process.argv.includes('--emit-bytes');
const BUDGET_MIST = BigInt(process.env.BUDGET_MIST ?? '50000000');
const EXPIRY_MS = 4_102_444_800_000n; // 2100-01-01

const HIRE_NAME = (process.env.HIRE ?? DEFAULT_HIRE).trim().toLowerCase();
const hire = HIRES[HIRE_NAME as HireName];
if (!hire) {
  throw new Error(`unknown HIRE "${HIRE_NAME}" — known: ${HIRE_NAMES.join(', ')}`);
}

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const sender = process.env.SUI_SENDER || DEPLOYER;
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  // The ledger is a ceiling over a real pool, not a reservation, so a budget
  // larger than the vault holds would let a spend pass the ledger check and then
  // fail on the funds. Refuse it here rather than let that surprise us later.
  const balance = await client.getBalance({ owner: VAULT_ID, coinType: SUI_TYPE });
  const held = BigInt(balance.balance?.balance ?? 0);
  if (BUDGET_MIST > held) {
    throw new Error(
      `budget ${mistToSui(BUDGET_MIST)} SUI exceeds what the vault holds (${mistToSui(held)}) — the ledger would allow it, the pool would not`,
    );
  }

  const tx = new Transaction();
  tx.setSender(sender);

  tx.moveCall({
    target: `${PACKAGE_LATEST_ID}::spend_vault::set_allowance`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.sharedObjectRef({
        objectId: VAULT_ID, initialSharedVersion: VAULT_SHARED_VERSION, mutable: true,
      }),
      tx.object(OWNER_CAP_ID),
      // The hire's own cap, which is what keys its budget entry.
      tx.pure.id(hire.capId),
      tx.pure.u64(BUDGET_MIST),
      tx.pure.u64(EXPIRY_MS),
      tx.pure.option('u64', null),
      tx.sharedObjectRef({
        objectId: CLOCK_ID, initialSharedVersion: CLOCK_SHARED_VERSION, mutable: false,
      }),
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
    step: 'set hire budget',
    hire: hire.name,
    capId: hire.capId,
    policyId: hire.policyId,
    budgetMist: BUDGET_MIST.toString(),
    budgetSui: (Number(BUDGET_MIST) / 1e9).toString(),
    vaultHolds: held.toString(),
    ok,
    status,
  }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
