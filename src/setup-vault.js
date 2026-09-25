/* Phase A of vault setup — creates the vault and funds it.
 *
 * Proves the accumulator path (object-owned address balances) on mainnet, which
 * is the one thing unit tests cannot cover. `new` does not touch address
 * balances; `deposit_balance` does.
 *
 * Split from phase B because `set_allowance` needs the spender cap's object ID,
 * and the PTB VM refuses `0x2::object::id` inside a transaction
 * (VMVerificationOrDeserializationError). The cap ID can only be read off the
 * effects of phase A, so allowance granting and policy creation happen in
 * phase B using phase A's address-owned outputs as inputs.
 *
 * The wallet holds SUI as an address balance, not as coins, so funding withdraws
 * from the sender's live balance rather than splitting a coin object.
 *
 * Usage: node src/setup-vault.js [--execute]
 */
import 'dotenv/config';

const PACKAGE_ID = '0x2441fb74d7684f43019fdabf27d6de24dc8e42826ddd86ba07bc21aded80c014';
const SUI_TYPE = '0x2::sui::SUI';

const EXECUTE = process.argv.includes('--execute');
// Emit the built transaction as base64 so the keystore can sign it, keeping the
// private key out of this process entirely.
const EMIT_BYTES = process.argv.includes('--emit-bytes');

// Trivial by design. This is a plumbing test, not a position.
const DEPOSIT_MIST = 20_000_000n; // 0.02 SUI into the vault

async function main() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { Transaction } = await import('@mysten/sui/transactions');

  // A dry run needs no signature — only a sender. Key material is required
  // solely for --execute.
  const sender = process.env.SUI_SENDER
    || '0x0b3fc768f8bb3c772321e3e7781cac4a45585b4bc64043686beb634d65341798';

  let keypair = null;
  if (EXECUTE) {
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');
    const secret = process.env.SUI_SECRET_KEY;
    if (!secret) throw new Error('SUI_SECRET_KEY not set (suiprivkey1... form)');
    const { secretKey } = decodeSuiPrivateKey(secret);
    keypair = Ed25519Keypair.fromSecretKey(secretKey);
  }

  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });

  const tx = new Transaction();
  tx.setSender(sender);

  // 1. Create the vault and its owner cap.
  const [vault, ownerCap] = tx.moveCall({
    target: `${PACKAGE_ID}::spend_vault::new`,
  });

  // 2. Fund it from the sender's live address balance. No coin objects exist to
  //    split, and inbound transfers merge into the accumulator rather than
  //    creating coins, so a withdrawal is the only route in.
  const withdrawal = tx.withdrawal({ amount: DEPOSIT_MIST, type: SUI_TYPE });
  const funds = tx.moveCall({
    target: '0x2::balance::redeem_funds',
    typeArguments: [SUI_TYPE],
    arguments: [withdrawal],
  });
  tx.moveCall({
    target: `${PACKAGE_ID}::spend_vault::deposit_balance`,
    typeArguments: [SUI_TYPE],
    arguments: [vault, funds],
  });

  // 3. Mint the spender cap. Its ID is read off the effects after execution and
  //    used in phase B, since the PTB VM cannot compute it in-flight.
  const cap = tx.moveCall({
    target: `${PACKAGE_ID}::spend_vault::mint_cap`,
    arguments: [vault, ownerCap],
  });

  // 4. Share the vault so the agent can reach it later.
  tx.moveCall({
    target: `${PACKAGE_ID}::spend_vault::share`,
    arguments: [vault],
  });

  // 5. Both caps come home: the owner cap is the admin credential, and the
  //    spender cap is passed into phase B's policy.
  tx.transferObjects([ownerCap, cap], sender);

  const bytes = await tx.build({ client });

  if (EMIT_BYTES) {
    // Print only the base64 payload, so the wallet can sign it and the caller submits it.
    process.stdout.write(Buffer.from(bytes).toString('base64'));
    return;
  }

  if (!EXECUTE) {
    const res = await client.simulateTransaction({ transaction: bytes });
    // gRPC returns a command-shaped envelope: { $kind: 'Transaction', Transaction: { status } }
    const status = res?.Transaction?.status ?? res?.status ?? null;
    const ok = status?.success === true || status?.status === 'success';
    console.log(JSON.stringify({
      mode: 'dry-run',
      phase: 'A',
      sender,
      ok,
      status,
    }, null, 2));
    if (!ok) process.exit(1);
    return;
  }

  const res = await client.signAndExecuteTransaction({
    transaction: bytes,
    signer: keypair,
    include: { effects: true, objectTypes: true },
  });
  console.log(JSON.stringify({
    mode: 'executed',
    phase: 'A',
    digest: res.digest,
    status: res.effects?.status,
    changes: res.effects?.changedObjects,
  }, null, 2));
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
