/* End-to-end proof of the agent path, as a free mainnet dry run.
 *
 * Exercises `policy::spend_to_destination`, which touches every layer at once:
 *   - the agent gate (sender must equal policy.agent)
 *   - the vault binding check
 *   - the embedded SpenderCap being reachable inside the Policy
 *   - the OZ budget having been granted (an ungranted coin type aborts)
 *   - the vault actually holding funds to draw against
 *
 * Nothing moves. The point is that a success here means every gate opened for
 * the right reason, and any single missing piece aborts with a distinct code.
 *
 * Usage: node src/verify-spend.js [amount-mist]
 */
import 'dotenv/config';
import {
  PACKAGE_LATEST_ID, VAULT_ID, POLICY_ID, CLOCK_ID, SUI_TYPE,
  VAULT_SHARED_VERSION, POLICY_SHARED_VERSION, CLOCK_SHARED_VERSION, DEPLOYER,
} from './addresses.js';

const AMOUNT_MIST = BigInt(process.argv[2] ?? '1000000'); // 0.001 SUI
// Emit bytes so the keystore can sign, and a real (possibly failing) transaction
// can be executed on-chain rather than only simulated.
const EMIT_BYTES = process.argv.includes('--emit-bytes');

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

  tx.moveCall({
    target: `${PACKAGE_LATEST_ID}::policy::spend_to_destination`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.sharedObjectRef({
        objectId: POLICY_ID,
        initialSharedVersion: POLICY_SHARED_VERSION,
        mutable: true,
      }),
      tx.sharedObjectRef({
        objectId: VAULT_ID,
        initialSharedVersion: VAULT_SHARED_VERSION,
        mutable: true,
      }),
      tx.pure.u64(AMOUNT_MIST),
      tx.sharedObjectRef({
        objectId: CLOCK_ID,
        initialSharedVersion: CLOCK_SHARED_VERSION,
        mutable: false,
      }),
    ],
  });

  // Build WITHOUT the client when emitting bytes. `build({ client })` runs a
  // resolution pass that simulates first, so a doomed transaction aborts during
  // resolution and never reaches the chain — which is exactly the case we want
  // to record. Every input here is an explicit ref, so resolution is not needed.
  const bytes = EMIT_BYTES ? await tx.build() : await tx.build({ client });

  if (EMIT_BYTES) {
    process.stdout.write(Buffer.from(bytes).toString('base64'));
    return;
  }
  const res = await client.simulateTransaction({ transaction: bytes });
  const status = res?.Transaction?.status ?? null;
  const ok = status?.success === true;

  console.log(JSON.stringify({
    mode: 'dry-run',
    check: 'policy::spend_to_destination',
    sender,
    amountMist: AMOUNT_MIST.toString(),
    ok,
    status,
  }, null, 2));

  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
