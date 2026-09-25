/* Phase B — grant the spend budget and create the purpose-gate policy.
 *
 * Runs against the live mainnet objects created by phase A. The SpenderCap is
 * consumed by `policy::create` and embedded in the shared Policy, so after this
 * transaction no caller holds spend authority directly: it is reachable only
 * through the module's sender-gated paths.
 *
 * `set_allowance` needs the cap's ID. The PTB VM refuses `0x2::object::id`
 * inside a transaction, but we know the ID off-chain, so it is passed as a pure
 * value instead. That keeps the whole of phase B in one transaction.
 *
 * Usage: node src/setup-policy.js [--emit-bytes]
 */
import 'dotenv/config';
import {
  PACKAGE_ID, VAULT_ID, OWNER_CAP_ID, SPENDER_CAP_ID,
  CLOCK_ID, SUI_TYPE, VAULT_SHARED_VERSION, CLOCK_SHARED_VERSION, DEPLOYER,
} from './addresses.js';

const EMIT_BYTES = process.argv.includes('--emit-bytes');

// Budget sits inside the vault's 0.02 SUI so the ledger and the pool agree.
const BUDGET_MIST = 10_000_000n;       // 0.01 SUI spendable by the agent
const EXPIRY_MS = 4_102_444_800_000n;  // 2100-01-01, effectively "no expiry"

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  const sender = process.env.SUI_SENDER || DEPLOYER;

  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  const agent = process.env.SUI_AGENT_ADDRESS || sender;
  const destination = process.env.SUI_DESTINATION || sender;

  const tx = new Transaction();
  tx.setSender(sender);

  const vault = tx.sharedObjectRef({
    objectId: VAULT_ID,
    initialSharedVersion: VAULT_SHARED_VERSION,
    mutable: true,
  });
  const clock = tx.sharedObjectRef({
    objectId: CLOCK_ID,
    initialSharedVersion: CLOCK_SHARED_VERSION,
    mutable: false,
  });
  const ownerCap = tx.object(OWNER_CAP_ID);
  const spenderCap = tx.object(SPENDER_CAP_ID);

  // 1. Grant the budget against the cap. Enforced by the OZ ledger, not by us.
  tx.moveCall({
    target: `${PACKAGE_ID}::spend_vault::set_allowance`,
    typeArguments: [SUI_TYPE],
    arguments: [
      vault,
      ownerCap,
      tx.pure.id(SPENDER_CAP_ID),
      tx.pure.u64(BUDGET_MIST),
      tx.pure.u64(EXPIRY_MS),
      tx.pure.option('u64', null), // no compare-and-swap expected value
      clock,
    ],
  });

  // 2. Create the policy. This consumes the SpenderCap by value and embeds it;
  //    afterwards the cap is unreachable from outside the module.
  tx.moveCall({
    target: `${PACKAGE_ID}::policy::create`,
    arguments: [
      vault,
      ownerCap,
      tx.pure.address(agent),
      tx.pure.address(destination),
      spenderCap,
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
    mode: 'dry-run', phase: 'B', sender, agent, destination, ok, status,
  }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
