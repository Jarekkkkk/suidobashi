/* Withdraw from the vault — the owner taking custody back.
 *
 * This is the counterpart to topup-vault.js, and it is the one owner operation that
 * exists purely as a way out. It matters for two reasons:
 *
 *  1. The separation the whole design rests on is that custody and authority are
 *     different things. The vault is custody; a policy is authority. An owner who
 *     cannot withdraw does not have custody of anything, so the separation would
 *     only be a claim in a document.
 *
 *  2. Before a package upgrade, funds should be out of everything the upgrade
 *     could strand. An upgrade replaces code, and shared state is what every
 *     package version reads — so the safe moment to change code is while the vault
 *     is empty.
 *
 * Amount: the whole live balance by default, read from the vault object's own
 * address balance. `withdraw` takes an explicit amount, unlike `withdraw_all`, which
 * also needs the framework `AccumulatorRoot` object — reading the balance first
 * avoids that extra dependency. Set WITHDRAW_MIST to take only part of it.
 *
 * Owner-gated: `withdraw` requires the OwnerCap, so a compromised agent cannot do
 * this, and neither can anyone reading a leaked policy id.
 *
 * Usage:
 *   node src/withdraw-vault.js                 dry-run
 *   node src/withdraw-vault.js --emit-bytes    base64 bytes for the wallet to sign
 */
import 'dotenv/config';
import {
  PACKAGE_LATEST_ID, VAULT_ID, OWNER_CAP_ID, SUI_TYPE,
  VAULT_SHARED_VERSION, DEPLOYER,
} from './addresses.js';

const EMIT_BYTES = process.argv.includes('--emit-bytes');

/** Unset means "everything". Set to take a partial amount, in MIST. */
const WITHDRAW_MIST = process.env.WITHDRAW_MIST ? BigInt(process.env.WITHDRAW_MIST) : null;
const DESTINATION = process.env.SUI_DESTINATION || DEPLOYER;

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const sender = process.env.SUI_SENDER || DEPLOYER;
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  // The vault holds funds as an object address balance, not as coin objects, so
  // this is the vault's whole SUI. Ask before building: a withdraw of zero is a
  // pointless transaction that costs gas, and the empty case is the one you are
  // most likely to hit right before an upgrade.
  const balance = await client.getBalance({ owner: VAULT_ID, coinType: SUI_TYPE });
  const held = BigInt(balance.balance?.balance ?? 0);
  const amount = WITHDRAW_MIST ?? held;

  if (held === 0n) {
    console.log(JSON.stringify({
      mode: 'no-op',
      step: 'withdraw from the vault',
      vault: VAULT_ID,
      holds: '0',
      note: 'the vault is already empty — nothing to withdraw, nothing built',
    }, null, 2));
    return;
  }
  if (amount > held) {
    throw new Error(`cannot withdraw ${amount} — the vault holds ${held}`);
  }

  const tx = new Transaction();
  tx.setSender(sender);

  const funds = tx.moveCall({
    target: `${PACKAGE_LATEST_ID}::spend_vault::withdraw`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.sharedObjectRef({
        objectId: VAULT_ID, initialSharedVersion: VAULT_SHARED_VERSION, mutable: true,
      }),
      tx.object(OWNER_CAP_ID),
      tx.pure.u64(amount),
    ],
  });

  // withdraw returns a Balance, which has no `drop` — it must leave the transaction
  // as a coin or it will not build.
  const coin = tx.moveCall({
    target: '0x2::coin::from_balance',
    typeArguments: [SUI_TYPE],
    arguments: [funds],
  });
  tx.transferObjects([coin], tx.pure.address(DESTINATION));

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
    step: 'withdraw from the vault',
    sender,
    destination: DESTINATION,
    vaultHolds: held.toString(),
    withdrawing: amount.toString(),
    withdrawingSui: (Number(amount) / 1e9).toString(),
    leavesBehind: (held - amount).toString(),
    ok,
    status,
  }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
