/* Top up the vault and set the agent's budget below the vault balance.
 *
 * The budget is intentionally smaller than what the vault holds: the vault is
 * custody and the budget is authority, and they are not the same number. A
 * compromised agent can never reach the difference.
 *
 * Funding withdraws from the sender's live address balance rather than splitting
 * a coin, because this wallet holds SUI as an address balance — inbound
 * transfers merge into the accumulator and do not create coin objects.
 *
 * Usage:
 *   node src/topup-vault.js                 dry-run + execute prompt
 *   node src/topup-vault.js --emit-bytes    base64 bytes for the wallet to sign
 */
import 'dotenv/config';
import {
  PACKAGE_ID, VAULT_ID, OWNER_CAP_ID, SPENDER_CAP_ID, CLOCK_ID, SUI_TYPE,
  VAULT_SHARED_VERSION, CLOCK_SHARED_VERSION, DEPLOYER,
} from './addresses.js';

const EMIT_BYTES = process.argv.includes('--emit-bytes');

const TOPUP_MIST = BigInt(process.env.TOPUP_MIST ?? '100000000');   // 0.1 SUI
const BUDGET_MIST = BigInt(process.env.BUDGET_MIST ?? '50000000');  // 0.05 SUI
// Deposit only. Funding the vault and granting a budget are different operations
// with different risk, so the owner panel exposes them separately and this flag
// keeps the top-up from silently re-granting standard's ceiling as a side effect.
const SKIP_BUDGET = process.env.SKIP_BUDGET === '1';
const EXPIRY_MS = 4_102_444_800_000n; // 2100-01-01

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const sender = process.env.SUI_SENDER || DEPLOYER;
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  const tx = new Transaction();
  tx.setSender(sender);

  const vaultRO = tx.sharedObjectRef({
    objectId: VAULT_ID, initialSharedVersion: VAULT_SHARED_VERSION, mutable: false,
  });
  const clock = tx.sharedObjectRef({
    objectId: CLOCK_ID, initialSharedVersion: CLOCK_SHARED_VERSION, mutable: false,
  });
  const ownerCap = tx.object(OWNER_CAP_ID);

  // 1. Fund the vault. The withdrawal is redeemed into a Balance and deposited
  //    into the vault object's own address balance.
  const withdrawal = tx.withdrawal({ amount: TOPUP_MIST, type: SUI_TYPE });
  const funds = tx.moveCall({
    target: '0x2::balance::redeem_funds',
    typeArguments: [SUI_TYPE],
    arguments: [withdrawal],
  });
  tx.moveCall({
    target: `${PACKAGE_ID}::spend_vault::deposit_balance`,
    typeArguments: [SUI_TYPE],
    arguments: [vaultRO, funds],
  });

  // 2. Optionally set the agent's budget deliberately below the vault balance.
  //    Skipped when this is a funding-only call.
  if (!SKIP_BUDGET) {
    tx.moveCall({
      target: `${PACKAGE_ID}::spend_vault::set_allowance`,
      typeArguments: [SUI_TYPE],
      arguments: [
        tx.sharedObjectRef({
          objectId: VAULT_ID, initialSharedVersion: VAULT_SHARED_VERSION, mutable: true,
        }),
        ownerCap,
        tx.pure.id(SPENDER_CAP_ID),
        tx.pure.u64(BUDGET_MIST),
        tx.pure.u64(EXPIRY_MS),
        tx.pure.option('u64', null),
        clock,
      ],
    });
  }

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
    step: SKIP_BUDGET ? 'fund the vault' : 'top up vault + set budget below balance',
    sender,
    topUpSui: (Number(TOPUP_MIST) / 1e9).toString(),
    budgetSui: SKIP_BUDGET ? null : (Number(BUDGET_MIST) / 1e9).toString(),
    ok,
    status,
  }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
