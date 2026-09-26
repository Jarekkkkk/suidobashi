/*
 * The transactions that take `deepbook_guard` from deployed to usable.
 *
 * One step per run, dry run by default, `--execute` to send — the same shape as the other scripts
 * in this directory, and for the same reason: a simulation checks the caller and the gates, so it
 * answers "would this work" without a key and without spending. Read a refusal as information: it
 * is the measurement this sequence exists to take.
 *
 * The order of the steps is the argument. Each one proves something the previous could not, so a
 * failure lands on a layer rather than on five at once:
 *
 *   setup     the account AND its guard — ONE transaction, see below; it cannot be two
 *   deposit   funding, by DeepBook's own owner path — no capability involved
 *   probe     SIMULATED quantities, to settle `quantityScale` for free
 *   order     one real order, at a quantity the probe accepted
 *   cancel    the order comes back off the book
 *   withdraw  the account empties, with no guard and no capability in the path
 *
 * `probe` is the one worth explaining. `quantityScale` is marked UNVERIFIED in `src/deepbook.ts`
 * because a live level-2 read disagrees with the documented lot size and a read-only query cannot
 * say which is wrong. A simulation CAN: DeepBook refuses a quantity it will not take, and the
 * refusal names its reason. So the probe prices the question in simulations before anything is
 * spent, instead of discovering it in a transaction that costs gas to get wrong.
 *
 *   bun src/ship-deepbook.ts --step setup
 *   bun src/ship-deepbook.ts --step setup --execute
 *
 * Self-serve (flavor (a)) throughout: the maker IS the agent, so one key signs every step. A
 * managed setup would set `--agent` to somebody else and only the order steps would need that key.
 */
import 'dotenv/config';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { USDC_TYPE } from './addresses.js';
import {
  CLOCK_ID,
  DEEPBOOK_POOL_ID,
  createAccountTx,
  buyTx,
  cancelTx,
  createGuardTx,
  depositSuiTx,
  priceScale,
  quantityScale,
  sellTx,
  sharedVersionOf,
  withdrawAllSuiTx,
  type OrderRefs,
  type SharedRef,
} from './deepbook.js';

const argv = process.argv.slice(2);
const flag = (name: string, fallback = ''): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(name);

const STEP = flag('--step');
const EXECUTE = has('--execute');

/**
 * The key this process signs with — read once, here, and nowhere else.
 *
 * Whichever of the two is present. This repo keeps both: `AGENT_SECRET_KEY` for the agent that
 * fills orders and `SUI_SECRET_KEY` for the deployer that owns things. The ship sequence is
 * SELF-SERVE — one wallet is both maker and agent — so either key works, and demanding one
 * specifically would mean the steps could not run on a machine holding only the other. Which
 * address it turns out to be is reported by `--step whoami` rather than assumed.
 */
async function loadSigner() {
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');
  const secret = process.env.SUI_SECRET_KEY || process.env.AGENT_SECRET_KEY;
  if (!secret) fail('no signing key: set SUI_SECRET_KEY or AGENT_SECRET_KEY (suiprivkey1… form)');
  return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(secret).secretKey);
}

const SIGNER = await loadSigner();
/** The maker: the wallet that owns the account and the only caller of the capital paths. */
const OWNER = SIGNER.toSuiAddress();
/** The agent. Self-serve by default, so the maker holds the seat on its own guard. */
const AGENT = flag('--agent', OWNER);
const SUI_DECIMALS = 9;
const USDC_DECIMALS = 6;

// The band and the limits this walkthrough creates a guard with. A sell sits ABOVE the market and a
// buy below it, which is why the band is wide relative to a price near 1.16: the point is to let one
// resting order through, not to express a view.
const PRICE_MIN_RAW = priceScale(SUI_DECIMALS, USDC_DECIMALS) * 5n / 10n; // 0.5 USDC
const PRICE_MAX_RAW = priceScale(SUI_DECIMALS, USDC_DECIMALS) * 2n; // 2.0 USDC
// Deliberately LOOSE, and to be narrowed. The guard's limits are in the same units as an order's
// quantity — and that scale is the number this sequence exists to measure. A tight bound set from a
// scale that might be wrong would either lock the agent out or permit far more than intended, and
// there is no way to tell which without first placing an order. So the walkthrough runs the account
// permissive, reads the scale from `probe`, and narrows afterwards. The account holds about 0.2 SUI
// and the maker holds the agent's seat, so a loose bound here exposes nobody.
const MAX_QTY_RAW = quantityScale(SUI_DECIMALS) * 1_000n;
const BUDGET_RAW = quantityScale(SUI_DECIMALS) * 1_000n;

const client = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: 'https://fullnode.mainnet.sui.io:443',
});

function fail(message: string): never {
  console.error(JSON.stringify({ mode: EXECUTE ? 'execute' : 'dry-run', step: STEP, error: message }, null, 2));
  process.exit(1);
}

/**
 * The pieces of a transaction result this script reads. Narrow deliberately: the wrapper carries
 * more than this, and naming the parts that are used is what stops a rename landing silently on
 * `undefined` — which is exactly how a created object's id went missing on the first real run.
 */
type TxResult = {
  digest?: string;
  status?: unknown;
  objectChanges?: Array<{ type?: string; objectType?: string; objectId?: string }>;
  events?: Array<{ type?: string; json?: Record<string, unknown>; parsedJson?: Record<string, unknown> }>;
};

/**
 * The payload under this client's `$kind` tag.
 *
 * `{ $kind, Transaction }` — the data is one level DOWN from what the call returns. Reading the
 * wrapper directly is how the first real run of this script reported a success with no ids in it,
 * and NOTES.md already carried that lesson from a failed-transaction report before I repeated it.
 */
function unwrap(result: unknown): TxResult {
  const w = result as { Transaction?: TxResult; FailedTransaction?: TxResult };
  return w.Transaction ?? w.FailedTransaction ?? (result as TxResult);
}

/** Every created object this script cares about, keyed by what it is. */
function createdIds(result: TxResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of result.objectChanges ?? []) {
    if (c.type !== 'created') continue;
    const t = String(c.objectType ?? '');
    if (t.includes('::balance_manager::BalanceManager')) out.balanceManager = String(c.objectId);
    if (t.includes('::balance_manager::TradeCap')) out.tradeCap = String(c.objectId);
    if (t.includes('::deepbook_guard::DeepbookGuard')) out.guard = String(c.objectId);
  }
  return out;
}

/** The id of a resting order, from the event DeepBook emits when one is placed. */
function placedOrderId(result: TxResult): string | null {
  for (const e of result.events ?? []) {
    if (!String(e?.type ?? '').includes('OrderPlaced')) continue;
    const id = e?.json?.order_id ?? e?.parsedJson?.order_id;
    if (id !== undefined) return String(id);
  }
  return null;
}

/** The shared references every order path needs, read fresh so versions are current. */
async function orderRefs(guardId: string, balanceManagerId: string): Promise<OrderRefs> {
  return {
    guard: { objectId: guardId, initialSharedVersion: await sharedVersionOf(client, guardId), mutable: true },
    pool: { objectId: DEEPBOOK_POOL_ID, initialSharedVersion: await sharedVersionOf(client, DEEPBOOK_POOL_ID), mutable: true },
    balanceManager: { objectId: balanceManagerId, initialSharedVersion: await sharedVersionOf(client, balanceManagerId), mutable: true },
    clock: { objectId: CLOCK_ID, initialSharedVersion: await sharedVersionOf(client, CLOCK_ID), mutable: false },
  };
}

/** The one reference a deposit or a withdrawal needs — neither touches the pool or the guard. */
async function bmRef(balanceManagerId: string): Promise<SharedRef> {
  return {
    objectId: balanceManagerId,
    initialSharedVersion: await sharedVersionOf(client, balanceManagerId),
    mutable: true,
  };
}

/** Build, then either simulate or sign and send. One place, so every step behaves the same. */
async function run(tx: Transaction, note: Record<string, unknown>) {
  tx.setSender(STEP === 'order' || STEP === 'cancel' ? AGENT : OWNER);
  const bytes = await tx.build({ client });

  if (!EXECUTE) {
    const sim: any = await client.simulateTransaction({ transaction: bytes });
    const payload = sim?.Transaction ?? sim?.FailedTransaction ?? {};
    const ok = payload?.status?.success === true;
    console.log(JSON.stringify({
      mode: 'dry-run', step: STEP, ok,
      status: payload?.status ?? null,
      keyConfigured: Boolean(process.env.SUI_SECRET_KEY || process.env.AGENT_SECRET_KEY),
      note: 'no key used — a simulation checks the caller, so this proves the gates pass',
      ...note,
    }, null, 2));
    if (!ok) process.exit(1);
    return null;
  }

  // The key is already loaded and checked: see SIGNER. Nothing here reads it again.
  const signer = SIGNER;

  const sent = await client.signAndExecuteTransaction({ transaction: bytes, signer });
  // A failed transaction arrives under FailedTransaction, not Transaction — reading only the
  // success shape reports a null digest for precisely the failures this mode exists to show.
  const result: TxResult = unwrap(sent);

  // The execute response does not carry the created objects or the events under this client's
  // default includes — so they are read back by digest. That is one extra call, and it works
  // whatever the SDK decides to return here.
  if (result.digest) {
    try {
      // SAFETY: the client honours these include keys at runtime even though its TypeScript type
      // does not name them, and the payload it returns carries the `objectChanges`/`events` fields
      // `TxResult` declares. Both are then merged with `??`, so a field that turns out to be absent
      // leaves the earlier value in place instead of overwriting it with undefined.
      const full = unwrap(((await client.getTransaction({
        digest: result.digest,
        include: { objectChanges: true, events: true },
      } as never)) as unknown));
      result.objectChanges = full.objectChanges ?? result.objectChanges;
      result.events = full.events ?? result.events;
    } catch {
      // A read-back that fails does not make the transaction a failure; it only means the ids
      // have to come from elsewhere. `--step inspect --digest` can always fetch them again.
    }
  }
  console.log(JSON.stringify({
    mode: 'executed', step: STEP,
    digest: result?.digest ?? null,
    status: result?.status ?? null,
    created: createdIds(result),
    order: placedOrderId(result),
    ...note,
  }, null, 2));
  return result;
}

async function main() {
  switch (STEP) {
    case 'setup': {
      // ONE transaction, and it has to be. Sui refuses to share an object that an earlier
      // transaction created, and `create` shares the BalanceManager — so the account and its guard
      // are born together or not at all. Simulated both ways against mainnet: split across two
      // transactions it aborts inside `transfer::share_object_impl`, in one it succeeds.
      const tx = new Transaction();
      const { balanceManager, tradeCap } = createAccountTx(tx);
      createGuardTx(tx, {
        poolId: DEEPBOOK_POOL_ID,
        balanceManager,
        tradeCap,
        agent: AGENT,
        priceMin: PRICE_MIN_RAW,
        priceMax: PRICE_MAX_RAW,
        maxQty: MAX_QTY_RAW,
        budget: BUDGET_RAW,
      });
      await run(tx, {
        agent: AGENT,
        owner: OWNER,
        bandRaw: [PRICE_MIN_RAW.toString(), PRICE_MAX_RAW.toString()],
        maxQtyRaw: MAX_QTY_RAW.toString(),
        budgetRaw: BUDGET_RAW.toString(),
      });
      return;
    }

    case 'deposit': {
      const bm = flag('--bm');
      const sui = flag('--amount', '2');
      if (!bm) fail('--bm is required');
      const mist = BigInt(Math.round(Number(sui) * 1e9));
      const tx = new Transaction();
      depositSuiTx(tx, await bmRef(bm!), mist);
      await run(tx, { amountMist: mist.toString(), note_deposit: 'owner path, no capability' });
      return;
    }

    case 'probe': {
      // Simulated only, always: the point is to be refused cheaply.
      const bm = flag('--bm');
      const guard = flag('--guard');
      if (!bm || !guard) fail('--bm and --guard are required');
      const refs = await orderRefs(guard!, bm!);
      // Standing, and this is the quantity scale question answered: quantities are raw base units
      // (1e9 = 1 SUI). 5e8 passes nothing, 1e10 clears input validation and fails only on the
      // account's balance. So the pool's minimum sits between 0.5 and 10 SUI, and the balance is
      // 0.2 — meaning this deposit cannot reach it. This brackets the minimum so the funding needed
      // is a number rather than a shrug: below the minimum is code 1, above it is a balance abort.
      const candidates = [
        600_000_000n, 800_000_000n, 1_000_000_000n, 1_500_000_000n, 3_000_000_000n, 6_000_000_000n,
      ];
      const results: Array<Record<string, unknown>> = [];
      for (const raw of candidates) {
        const tx = new Transaction();
        tx.setSender(AGENT);
        // A sell, because the account holds SUI: a bid would need quote funds it does not have, and
        // the refusal for THAT would say nothing about the quantity scale.
        sellTx(tx, refs, {
          clientOrderId: raw, orderType: 0, price: PRICE_MAX_RAW, quantity: raw,
        });
        try {
          const bytes = await tx.build({ client });
          const sim: any = await client.simulateTransaction({ transaction: bytes });
          const payload = sim?.Transaction ?? sim?.FailedTransaction ?? {};
          const ok = payload?.status?.success === true;
          results.push({
            raw: raw.toString(),
            asWholeSui: Number(raw) / 10 ** SUI_DECIMALS,
            ok,
            error: ok ? null : String(payload?.status?.error ?? '').slice(0, 200),
          });
        } catch (e) {
          results.push({ raw: raw.toString(), asWholeSui: Number(raw) / 10 ** SUI_DECIMALS, ok: false, error: String((e as Error).message).slice(0, 200) });
        }
      }
      const accepted = results.flatMap((r) => (r.ok ? [r.raw] : []));
      console.log(JSON.stringify({
        mode: 'probe', step: 'probe', simulated: true,
        question: 'which raw quantities does DeepBook accept for this pool?',
        accepted,
        smallestAccepted: accepted[0] ?? null,
        results,
      }, null, 2));
      return;
    }

    case 'order': {
      const bm = flag('--bm');
      const guard = flag('--guard');
      const rawQuantity = flag('--quantity-raw');
      const side = flag('--side', 'sell') as 'sell' | 'buy';
      if (!bm || !guard || !rawQuantity) fail('--bm, --guard and --quantity-raw are required');
      const tx = new Transaction();
      // The ask rests above the market and the bid below it, so this is a maker order either way.
      const price = side === 'buy' ? PRICE_MIN_RAW : PRICE_MAX_RAW;
      const opts = {
        clientOrderId: 1n, orderType: 0, price, quantity: BigInt(rawQuantity!),
      };
      const refs = await orderRefs(guard!, bm!);
      if (side === 'buy') buyTx(tx, refs, opts);
      else sellTx(tx, refs, opts);
      await run(tx, { side, priceRaw: price.toString(), quantityRaw: rawQuantity });
      return;
    }

    case 'cancel': {
      const bm = flag('--bm');
      const guard = flag('--guard');
      const order = flag('--order');
      if (!bm || !guard || !order) fail('--bm, --guard and --order are required');
      const tx = new Transaction();
      cancelTx(tx, await orderRefs(guard!, bm!), BigInt(order!));
      await run(tx, { order });
      return;
    }

    case 'withdraw': {
      const bm = flag('--bm');
      if (!bm) fail('--bm is required');
      const tx = new Transaction();
      withdrawAllSuiTx(tx, await bmRef(bm!), OWNER);
      await run(tx, { recipient: OWNER, note_withdraw: 'owner path, no capability, no guard' });
      return;
    }

    case 'whoami': {
      // Which wallet the steps will act as, and whether it can afford them. Both balances because
      // the side of the first order decides which one it needs: a sell spends SUI, a bid spends
      // USDC, and an account with no quote funds refuses a bid for a reason that says nothing
      // about the quantity scale.
      console.log(JSON.stringify({
        mode: 'note', step: 'whoami',
        signsAs: OWNER,
        agent: AGENT,
        suiBalance: await client.getBalance({ owner: OWNER, coinType: '0x2::sui::SUI' }),
        usdcBalance: await client.getBalance({ owner: OWNER, coinType: USDC_TYPE }),
      }, null, 2));
      return;
    }

    case 'inspect': {
      // Recover what a transaction DID, from its digest. The include keys are `effects` and
      // `events` — `objectChanges` is NOT one of them, and an unknown key is ignored without
      // complaint, which is precisely why every earlier run of this step reported `created: {}`.
      // Created objects live under `effects.changedObjects` with a kind of `Create`, and their
      // types under `objectTypes`.
      const digest = flag('--digest');
      if (!digest) fail('--digest is required');
      const full = unwrap(((await client.getTransaction({
        digest, include: { effects: true, events: true, objectTypes: true },
      } as never)) as unknown)) as unknown as {
        effects?: {
          status?: unknown;
          changedObjects?: Array<{ idOperation?: string; objectId?: string }>;
        };
        events?: Array<{ type?: string; json?: Record<string, unknown> }>;
        objectTypes?: Record<string, string>;
      };
      console.log(JSON.stringify({
        mode: 'note', step: 'inspect', digest,
        status: full.effects?.status ?? null,
        created: (full.effects?.changedObjects ?? []).flatMap((c) =>
          c.idOperation === 'Create'
            ? [{ id: c.objectId, type: full.objectTypes?.[String(c.objectId)] }]
            : [],
        ),
        events: (full.events ?? []).map((e) => ({ type: e?.type, json: e?.json })),
      }, null, 2));
      return;
    }

    default:
      fail(`--step must be one of: whoami, setup, deposit, probe, order, cancel, withdraw, inspect (got ${STEP ?? 'nothing'})`);
  }
}

await main();
