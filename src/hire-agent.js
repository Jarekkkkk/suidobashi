/* Hire an agent — mint its own cap, grant its own budget, create its own policy.
 *
 * This is the marketplace primitive, and it needs no new Move: a policy already
 * *is* a grant. Its fields are exactly the hire terms — which agent address may
 * act, how much it may spend, which venue it may use, where value goes, and a
 * suspension flag. So a second policy is a second hire, drawing from the same
 * vault with an independent ceiling.
 *
 * Two phases, because the PTB VM refuses `0x2::object::id`: the minted cap's id
 * cannot be read in-flight, so it is read off phase A's effects and used as a
 * plain value in phase B.
 *
 *   phase A   node src/hire-agent.js --mint
 *   phase B   CAP_ID=0x… AGENT=0x… BUDGET_MIST=10000000 node src/hire-agent.js --grant
 *   phase C   HIRE=cautious node src/hire-agent.js --allowlist
 *   phase C   allowlist a venue for the new policy (needs the policy id from B)
 *
 * A new hire starts with NO venue: the policy's pool allowlist is empty by design,
 * so it cannot trade until the owner opens one explicitly. Fail-closed is the
 * right default for a grant, but it does mean hiring is three steps, not two.
 *
 * Gas only. The vault is untouched — the budget is an authority limit, not a
 * transfer.
 */
import 'dotenv/config';
import {
  PACKAGE_ID, VAULT_ID, OWNER_CAP_ID, POOL_ID, CLOCK_ID, SUI_TYPE,
  VAULT_SHARED_VERSION, CLOCK_SHARED_VERSION, DEPLOYER,
} from './addresses.js';
import { HIRES } from './hires.js';

const MINT = process.argv.includes('--mint');
const GRANT = process.argv.includes('--grant');
const ALLOWLIST = process.argv.includes('--allowlist');
const EMIT_BYTES = process.argv.includes('--emit-bytes');

const AGENT = process.env.AGENT;
const CAP_ID = process.env.CAP_ID;
const BUDGET_MIST = BigInt(process.env.BUDGET_MIST ?? '10000000');
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

  const vaultMut = tx.sharedObjectRef({
    objectId: VAULT_ID, initialSharedVersion: VAULT_SHARED_VERSION, mutable: true,
  });
  const ownerCap = tx.object(OWNER_CAP_ID);

  let phase;

  if (MINT) {
    phase = 'mint';
    // Phase A: a fresh bearer cap for the new hire. Returned to the owner, who
    // passes it into phase B where the policy consumes and embeds it.
    const cap = tx.moveCall({
      target: `${PACKAGE_ID}::spend_vault::mint_cap`,
      arguments: [vaultMut, ownerCap],
    });
    tx.transferObjects([cap], sender);
  } else if (GRANT) {
    phase = 'grant';
    if (!CAP_ID) throw new Error('CAP_ID is required for --grant');
    if (!AGENT) throw new Error('AGENT is required for --grant (the hired agent address)');

    // The hire's ceiling. Independent of every other hire, because the OZ ledger
    // is keyed by (cap_id, coin_type).
    tx.moveCall({
      target: `${PACKAGE_ID}::spend_vault::set_allowance`,
      typeArguments: [SUI_TYPE],
      arguments: [
        vaultMut,
        ownerCap,
        tx.pure.id(CAP_ID),
        tx.pure.u64(BUDGET_MIST),
        tx.pure.u64(EXPIRY_MS),
        tx.pure.option('u64', null),
        tx.sharedObjectRef({
          objectId: CLOCK_ID, initialSharedVersion: CLOCK_SHARED_VERSION, mutable: false,
        }),
      ],
    });

    // The hire itself. `create` consumes the cap by value and embeds it, so after
    // this the agent's authority is reachable only through the policy's gates.
    tx.moveCall({
      target: `${PACKAGE_ID}::policy::create`,
      arguments: [
        tx.sharedObjectRef({
          objectId: VAULT_ID, initialSharedVersion: VAULT_SHARED_VERSION, mutable: false,
        }),
        ownerCap,
        tx.pure.address(AGENT),
        tx.pure.address(process.env.DESTINATION || sender),
        tx.object(CAP_ID),
      ],
    });
  } else if (ALLOWLIST) {
    phase = 'allowlist';
    // Phase C: open a venue for an existing hire. The policy must already exist,
    // which is why this cannot be folded into phase B — `create` shares the
    // policy, so it is not an input this transaction could pass.
    const hireName = process.env.HIRE;
    const hire = hireName ? HIRES[hireName] : null;
    if (!hire) throw new Error(`HIRE must be one of: ${Object.keys(HIRES).join(', ')}`);
    const venue = process.env.VENUE || POOL_ID;

    tx.moveCall({
      target: `${PACKAGE_ID}::policy::set_pool_allowed`,
      arguments: [
        tx.sharedObjectRef({
          objectId: hire.policyId,
          initialSharedVersion: hire.policySharedVersion,
          mutable: true,
        }),
        ownerCap,
        tx.pure.id(venue),
        tx.pure.bool((process.env.ALLOW ?? 'true') !== 'false'),
      ],
    });
  } else {
    throw new Error('pass --mint, --grant or --allowlist');
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
    phase,
    hire: process.env.HIRE ?? null,
    agent: AGENT ?? null,
    capId: CAP_ID ?? null,
    budgetMist: GRANT ? BUDGET_MIST.toString() : null,
    ok,
    status,
  }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
