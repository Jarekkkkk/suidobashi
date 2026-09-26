/* Intent layer — natural language in, a validated intent out.
 *
 * The local model's only job is language → a small typed object. It never builds
 * a transaction, never sees a key, and never decides whether something is safe.
 * Everything underneath it already enforces the real rules: the vault's budget
 * caps, the venue allowlist, the agent gate, the destination routing, the tick
 * bounds. So the model can be wrong, and the worst outcome is a refused or failed
 * intent — never a wrong transaction.
 *
 * Three constraints came from probing Qwen3-0.6B rather than from assumption:
 *
 *   1. Numeric fields must be integers, and the model must NOT be asked to do
 *      unit conversion. Asked for MIST directly, it returned 500000000 for
 *      "0.05 SUI" — a tenfold error that looks entirely plausible. Asked for the
 *      literal it returns "0.05", and this file does the arithmetic exactly.
 *   2. `/no_think` is required. Qwen3 emits a `reasoning_content` field otherwise.
 *   3. The worked examples are load-bearing, not decoration. Zero-shot, the model
 *      classified "swap half a SUI" correctly and then returned amountMist: 0.
 *
 * So the model extracts, and this file computes. It never sees a key, builds a
 * transaction, or judges safety — every real rule lives below it, in the vault's
 * caps, the venue allowlist, the agent gate and the tick bounds. A wrong model
 * therefore produces a refused intent, never a wrong transaction.
 *
 * Usage:
 *   node src/agent.js "swap half a SUI into USDC"     propose only
 *   node src/agent.js "..."                         propose only (the default)
 *
 * There is no --execute: signing belongs to the wallet extension in the browser,
 * and this process holds no key. Use the UI to sign and submit.
 */
import 'dotenv/config';
import { HIRES, HIRE_NAMES, DEFAULT_HIRE, type Hire, type HireName } from './hires.js';
import { actionSpends, describeTalents } from './talents.js';
import { listTalents } from './db.js';
// Top-level rather than dynamic: the gate needs the owner's address when it plans a read, and a
// name reached only from inside a function is the trap that once broke every real run while the
// suite stayed green (see walletBalanceMist).
import { DEPLOYER, DIRECTIONS, SUI_TYPE, type CoinSpec, type Direction } from './addresses.js';
// The one formatter for a raw amount, and the one parser for a typed decimal. Both belong to the
// same file, which is why neither is re-implemented here: a second copy is what made a fee print
// "0.010000", and the copy that used to live below hardcoded nine decimals.
import { fromUnits, toUnits } from './web/units.js';

const QVAC_URL = process.env.QVAC_URL || 'http://127.0.0.1:11434/v1/chat/completions';
const MODEL = process.env.QVAC_MODEL || 'intent';

/**
 * The model must be on the device. That is the premise of this layer, not a
 * preference, so a non-local endpoint is refused loudly rather than silently
 * shipping prompts to somebody's cloud.
 */
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/;
let qvacHost;
try {
  qvacHost = new URL(QVAC_URL).hostname;
} catch {
  throw new Error(`QVAC_URL is not a valid URL: ${QVAC_URL}`);
}
if (!LOOPBACK.test(qvacHost)) {
  throw new Error(
    `refusing non-local model endpoint: ${QVAC_URL} — the intent layer must run on-device`,
  );
}

/**
 * The coin a request's amount is denominated in.
 *
 * SUI for everything except a swap, whose input coin the direction decides. A helper rather than
 * the same expression at both call sites, because the BALANCE read and the ALLOWANCE read have to
 * agree about the coin — comparing one against the other in different units is a bug that neither
 * read would show on its own, and both are keyed by coin type on chain.
 */
function actionCoin(intent: any): CoinSpec {
  const dir = intent?.action === 'swap'
    ? DIRECTIONS[`${intent.from}->${intent.to}` as Direction]
    : null;
  return dir ? dir.in : { type: SUI_TYPE, symbol: 'SUI', decimals: 9 };
}

/**
 * The prompt, built per request.
 *
 * IT WAS A CONSTANT, and that is the whole problem with a stateless model: what it can
 * do has to be told to it every time, and a constant tells it the same thing whatever
 * is installed. Now the valid actions come from the installed talents, so installing
 * one is what makes it available and removing one is what takes it away.
 */
function systemPrompt(validActions: string) {
  return `Extract the action, the direction, the amount and the agent EXACTLY as written.
Do not convert units. Do not do arithmetic.
from and to are the coin symbols, or "" when the request has no direction.
agent is which hired agent to use, or "" for the default. Available: ${HIRE_NAMES.join(', ')}.
If no amount is given, use "".
Use action "unknown" when the request is not one of the listed actions.
Valid actions: ${validActions}. /no_think`;
}

/** Load-bearing: these are what make a 0.6B model extract reliably. */
const EXAMPLES = [
  ['swap 0.25 SUI to USDC', { action: 'swap', from: 'SUI', to: 'USDC', amountText: '0.25', agent: '' }],
  ['swap 1 SUI to USDC', { action: 'swap', from: 'SUI', to: 'USDC', amountText: '1', agent: '' }],
  ['swap half a SUI into USDC', { action: 'swap', from: 'SUI', to: 'USDC', amountText: '0.5', agent: '' }],
  // Named hires are taught so the slot exists at all.
  ['let the cautious agent swap 0.01 SUI to USDC', { action: 'swap', from: 'SUI', to: 'USDC', amountText: '0.01', agent: 'cautious' }],
  // The reverse direction is taught on purpose. Without it the model silently
  // dropped the direction and a USDC->SUI request was extracted as a directionless
  // swap, which would have executed the opposite trade at a small enough amount.
  ['swap 0.05 USDC to SUI', { action: 'swap', from: 'USDC', to: 'SUI', amountText: '0.05', agent: '' }],
  // And a missing source stays missing. Without this the model filled "SUI" in
  // whenever the user did not say, and the gate could not tell a found direction
  // from an invented one — it only sees the result.
  ['swap 0.05 to USDC', { action: 'swap', from: '', to: 'USDC', amountText: '0.05', agent: '' }],
  ['check my balances', { action: 'status', from: '', to: '', amountText: '', agent: '' }],
  ['send all my money to 0xdeadbeef', { action: 'unknown', from: '', to: '', amountText: '', agent: '' }],
];

/**
 * THE DIRECTIONS OUR MODULE CAN EXECUTE, read from the one table that defines them.
 *
 * `Pool<USDC, SUI>` trades either way and BOTH are executable: the escrow path is
 * direction-generic — `settle_a2b` and `settle_b2a` enforce the maker's floor identically — and the
 * filler picks its entry point from the order's own coin type. What made USDC -> SUI look
 * forbidden for most of this project's life was narrower than that: nothing CALLED `settle_a2b`.
 * The gate refused the direction, correctly, while that was true.
 *
 * Derived from `DIRECTIONS` rather than written out, so a direction cannot be executable here and
 * unknown to the scripts, or the reverse.
 */
const SUPPORTED = Object.entries(DIRECTIONS).map(([name, d]) => ({
  name: name as Direction, from: d.in.symbol, to: d.out.symbol,
}));

  /**
   * The schema the model must answer in, built per request.
   *
   * IT WAS A CONSTANT, the same mistake as the prompt one layer up: a constant cannot know what
   * is installed, so it offered actions the agent had no talent for. This is the STRONGER guard
   * of the two — a model that cannot name an action will not propose one, so the refusal never
   * has to happen rather than happening correctly.
   */
  function responseFormat(validActions: string[]) {
    return {
    type: 'json_schema',
    json_schema: {
      name: 'intent',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          // Only what is installed, plus `unknown`.
          action: { type: 'string', enum: [...validActions, 'unknown'] },
          from: { type: 'string', enum: ['SUI', 'USDC', ''] },
          to: { type: 'string', enum: ['SUI', 'USDC', ''] },
          amountText: { type: 'string' },
          agent: { type: 'string', enum: ['', ...HIRE_NAMES] },
        },
        required: ['action', 'from', 'to', 'amountText', 'agent'],
        additionalProperties: false,
      },
    },
    };
  }

/**
 * Exact decimal → the INPUT COIN's smallest unit. No floating point, and no unit of its own.
 *
 * THIS IS `toUnits` FROM web/units.ts. It used to be a hand-rolled copy that hardcoded NINE
 * decimals in three separate places — the regex quantifier, the padding, and the multiplier — which
 * is a thousandfold error the moment the amount is USDC. That is the "a second implementation
 * appeared next to the first" story from that module's own comment, and the fix is to have one.
 *
 * `decimals` is the direction's, passed in by the caller that already knows it.
 *
 * (The field is still called `amountMist` below. The NAME is historical — it is in the input
 * coin's units, and the report says which coin that was.)
 */
function parseAmount(text: string, decimals: number) {
  const t = String(text ?? '').trim();
  // `unknown` IS NOT AN AMOUNT. The model writes it when it cannot read one, and it was being
  // reported as `amount "unknown" is not a plain decimal` — a refusal that reads as the USER's
  // mistake for something the model did, and names a decimal nobody typed. Treated as absent,
  // which is what it means, so the next check says "no amount given" instead.
  if (t === '' || /^unknown$/i.test(t)) return { ok: true, amountMist: 0n };
  const units = toUnits(t, decimals);
  if (units === null) {
    return {
      ok: false,
      reason: `amount "${t}" is not a plain decimal with at most ${decimals} places`,
    };
  }
  return { ok: true, amountMist: BigInt(units) };
}

async function parseIntent(text: string, validActions: string[]) {
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: systemPrompt(validActions.join(', ')) },
  ];
  for (const [user, intent] of EXAMPLES) {
    messages.push({ role: 'user', content: String(user) });
    messages.push({ role: 'assistant', content: JSON.stringify(intent) });
  }
  messages.push({ role: 'user', content: text });

  const res = await fetch(QVAC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages,
      response_format: responseFormat(validActions),
    }),
  });
  if (!res.ok) throw new Error(`qvac ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const body = await res.json();
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error('model returned no content');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`model returned non-JSON: ${String(content).slice(0, 120)}`);
  }
  return { intent: parsed, finishReason: choice.finish_reason };
}

/**
 * Grounding check: did the model read this off the request, or invent it?
 *
 * A 0.6B model will fill a plausible default rather than leave a field empty —
 * asked to "swap 0.01 to USDC" it produced `from: "SUI"` even with a
 * counter-example in the prompt. Rather than fight that with more examples, the
 * gate verifies the claim against the user's own words. Deterministic, and it
 * needs no cooperation from the model.
 */
function grounded(text: string, value: unknown) {
  if (!value) return false;
  return text.toUpperCase().includes(String(value).toUpperCase());
}

/**
 * Choose the hire from the user's own words — the model is not consulted.
 *
 * It cannot be: with `agent` a required enum member, the model fills it rather
 * than signalling "none". Proven three ways — five counter-examples, both enum
 * orderings, and an explicit instruction all still returned a hire name for a
 * request that named none. So the field is a trap, not a signal.
 *
 * Which gate, venue and budget apply is also not something to infer. Scanning the
 * text is the same division used for the amount (the model extracts, code
 * computes) and for direction grounding (code verifies).
 */
function selectHire(text: string) {
  const named = HIRE_NAMES.filter(
    (n) => new RegExp(`\\b${n}\\b`, 'i').test(text),
  );
  if (named.length === 0) {
    return { ok: true, hire: HIRES[DEFAULT_HIRE], named };
  }
  if (named.length > 1) {
    return {
      ok: false,
      named,
      reason: `the request names more than one hire (${named.join(', ')}) — say which one`,
    };
  }
  return { ok: true, hire: HIRES[named[0] as HireName], named };
}

/**
 * Deterministic gate. The model proposed; this decides whether to act on it.
 *
 * Direction is checked BEFORE the amount, and not for tidiness: `0.05` means
 * 0.05 USDC in "swap 0.05 USDC to SUI" and 0.05 SUI in the supported direction, so
 * the amount cannot be interpreted until the direction is known.
 *
 * A missing or ungrounded direction is a refusal, never a default. Refusing on
 * ambiguity is the entire job of this function.
 */
// `intent` is the local model's extraction, so it is `any` on purpose: the whole point of
// `validate` is that it cannot be trusted, and every field is checked before use. Typing it
// would be a claim about what a 0.6B model emits.
function validate(
intent: any,
amountMist: bigint | null,
{ walletBalanceIn, allowance, text, hire, policy, actions, spends }: {
walletBalanceIn: bigint; allowance: bigint | null; text: string; hire: Hire | null; policy: any;
/** What the installed talents make available, checked below. */
actions: string[];
/** Whether the action moves value — read from its talent, never from its name. */
spends: boolean;
},
) {
  if (!intent || typeof intent !== 'object') return { ok: false, reason: 'not an object' };
    // NOT INSTALLED IS NOT ALLOWED. The talent model says what the agent can do is what has
    // been equipped, so an action whose talent is absent is refused here rather than planned
    // and failing somewhere further along.
    //
    // `unknown` IS NOT A MISSING TALENT. It is the model saying the request is not an action at
    // all, and the check below gives it the right message — "not one of the supported actions"
    // rather than naming a talent that was never asked for. Order matters: testing it here first
    // reported an unrecognised request as a missing installation.
    if (intent.action !== 'unknown' && !actions.includes(intent.action)) {
      return { ok: false, reason: `"${intent.action}" needs a talent that is not installed` };
    }
  if (intent.action === 'unknown') {
    // NAMES WHAT IS AVAILABLE. "not one of the supported actions" is true and useless — the user
    // cannot tell something impossible from something not installed, and a talent named after a
    // verb it does not provide makes that worse.
    return {
      ok: false,
      reason: actions.length
        ? `request is not one of the supported actions — installed talents provide: ${actions.join(', ')}`
        : 'request is not one of the supported actions, and no talent is installed yet',
    };
  }

  // A READ NEEDS NO GRANT, so none of the gate below applies to it.
  //
  // This is the branch that makes "a talent that only reads does not need one" true in the code
  // rather than only in the docs, and it sits AFTER the installed-check above on purpose: the
  // boundary being enforced here is whether the agent may act at all, and that is decided by what
  // is installed. Reading never needs a hire, a budget, a venue or a live suspension.
  if (!spends) {
    // Nothing left to judge — including the amount, which a read does not have. Requiring one
    // would refuse "check my balances" for a number the request never needed to name.
    return { ok: true };
  }

  // A hire must exist before anything else is judged. The code below read `hire.name` on the
  // assumption that one always had, which the compiler now refuses — and it is right: a null
  // hire would have thrown on the FIRST suspension message rather than refusing cleanly.
  if (!hire) {
    return {
      ok: false,
      reason: `no hire matched — name one of: ${HIRE_NAMES.join(', ')}`,
    };
  }

  // Suspension is checked before anything else, because it is the owner's
  // strongest statement that this hire must not act — stronger than any budget or
  // allowlist. Applies to every action routed through a hire; `redeem` is not one
  // of them, since the owner calls it directly under the OwnerCap.
  if (policy && policy.suspended) {
    return {
      ok: false,
      reason: `the ${hire.name} hire is suspended — resume it before asking it to act`,
    };
  }

  if (intent.action === 'swap') {
    const direction = SUPPORTED.find((s) => s.from === intent.from && s.to === intent.to);
    if (!direction) {
      return {
        ok: false,
        reason:
          // NAMES EVERY DIRECTION THAT WORKS, not just one. The old message said "only SUI -> USDC
          // is supported", which was true and told a user asking for the other direction nothing
          // about whether it was unbuilt or forbidden.
          `only ${SUPPORTED.map((s) => `${s.from} -> ${s.to}`).join(' and ')} are supported; ` +
          `this asked for ${intent.from || '(none)'} -> ${intent.to || '(none)'}`,
      };
    }
    // The hire's swap pool must be allowed. Checked here rather than left to the
    // chain so a request routed to a hire whose pool is blocked is refused for the
    // right reason, cheaply, instead of aborting EPoolNotAllowed later.
    if (policy && !policy.venueOpen) {
      const others = policy.venueCount ?? 0;
      return {
        ok: false,
        reason:
          `the ${hire.name} hire's swap pool is not allowed ` +
          `(the ${hire.venue.feeBps / 100}% Cetus pool)` +
          (others === 0
            // Distinguishing these two matters: an empty allowlist is the normal
            // state of a new hire, so it should say so rather than read as a fault.
            ? ' — its allowlist is empty, which is how a new hire starts.'
            : ` — its allowlist holds ${others} other pool(s).`) +
          ' Allow the pool first.',
      };
    }
    // The direction matches what we support — but did the request actually say so?
    // Otherwise the model resolved the ambiguity itself, and the gate cannot tell.
    for (const [field, value] of [['from', intent.from], ['to', intent.to]]) {
      if (!grounded(text, value)) {
        return {
          ok: false,
          reason:
            `the request never names "${value}" as the ${field} coin — the model ` +
            'inferred it. Say the direction explicitly, or the trade could be the wrong one.',
        };
      }
    }
  }

  if (amountMist === null) {
    return { ok: false, reason: 'no parseable amount' };
  }

  // The coin the amount is in, for the money messages below. Derived from the intent here rather
  // than passed in, so the gate's messages and its reads cannot come to disagree about the unit.
  const coin = actionCoin(intent);

  // The hire was already chosen from the request text by the caller, and the
  // venue read from its policy, so both are settled by the time this runs. What
  // the model put in its `agent` field is deliberately not consulted.
  if (amountMist > 0n && amountMist > walletBalanceIn) {
    return {
      ok: false,
      // In the INPUT COIN's units, which used to be MIST and SUI unconditionally. A refusal is read
      // by a person who typed "0.05", and 50000000 is not an amount they have ever seen — nor is
      // "50000000 SUI" a true sentence when they typed USDC.
      reason: `${fromUnits(amountMist, coin.decimals)} ${coin.symbol} exceeds your wallet balance `
        + `${fromUnits(walletBalanceIn, coin.decimals)} ${coin.symbol} — `
        + 'the escrow would have nothing to draw from',
    };
  }
  // The grant, checked HERE rather than only on chain.
  //
  // create_with_policy enforces this for real, but it enforces it by aborting, and an abort
  // reaches the user as "Transaction resolution failed: MoveAbort in 4th command,
  // 'EExceedsAllowance' ... in 0x4529c549::order::create_with_policy (line 222)" — four pieces of
  // implementation detail and not one number. This is the same fact said in the user's terms,
  // before a signature is requested.
  //
  // `allowance === null` means the read failed, so the check stands aside and lets the chain be
  // the authority. It is the authority regardless: this is a courtesy, not the boundary.
  if (amountMist > 0n && allowance !== null && amountMist > allowance) {
    return {
      ok: false,
      reason: `${fromUnits(amountMist, coin.decimals)} ${coin.symbol} is more than the `
        + `${fromUnits(allowance, coin.decimals)} ${coin.symbol} your grant allows — `
        // POINTS ONLY WHERE THE CONTROL EXISTS. The policy sheet's budget field is SUI-only, so
        // telling a USDC request to "raise the budget in the policy sheet" sends the user to a
        // control that cannot do it.
        + (coin.symbol === 'SUI'
          ? 'raise the budget in the policy sheet, or ask for less'
          : `grant a ${coin.symbol} allowance on the policy's cap, or ask for less`),
    };
  }
  if ((intent.action === 'swap' || intent.action === 'deposit_liquidity') && amountMist <= 0n) {
    return { ok: false, reason: `${intent.action} needs a positive amount` };
  }
  return { ok: true };
}

/** Map a validated intent onto the script that already proves the operation. */
function planFor(intent: any, amountMist: bigint | null, hire: Hire | null) {
  switch (intent.action) {
    case 'swap': {
      // A swap escrows, so it has no plan without a hire. This guard used to live in `main`, where
      // it refused EVERY action that had no grant — correct when a swap was the only action there
      // was, and wrong for the one action that needs none. Only `planFor` knows which is which,
      // so this is where the question belongs.
      if (!hire) return null;
      const name = `${intent.from}->${intent.to}` as Direction;
      const d = DIRECTIONS[name];
      // `validate` already refused anything outside the table, so this is the compiler being told
      // what the control flow guarantees rather than a case the code can reach.
      if (!d) return null;
      // The amount, in the INPUT coin's decimals. A single `Number(amountMist) / 1e9` used to be
      // computed here for every action, which printed a USDC amount as though it were SUI the
      // moment a second direction existed.
      const amountText = fromUnits(amountMist ?? 0n, d.in.decimals);
      // THE VAULT PATH IS ONE DIRECTION. `src/swap.js` calls `swap_and_route`, which escrows
      // nothing and knows SUI -> USDC. So a USDC -> SUI trade has NO command rather than a wrong
      // one: the escrow is the only path that direction, and `actionFor` refuses a null command
      // loudly instead of running a script that cannot do what was asked.
      const vault = d.in.symbol === 'SUI';
      return {
        command: vault ? 'node src/swap.js' : null,
        env: {
          // In the INPUT coin's smallest unit. `SWAP_MIST` survives only where it is TRUE — the
          // vault path, which is SUI in — because a name saying MIST while carrying USDC units is
          // exactly the kind of lie this project keeps finding in its own comments.
          SWAP_AMOUNT_IN: String(amountMist),
          SWAP_DIRECTION: name,
          ...(vault ? { SWAP_MIST: String(amountMist) } : {}),
          SWAP_POLICY_ID: hire.policyId,
          SWAP_POLICY_SHARED: String(hire.policySharedVersion),
          // The hire's own venue, not a global default.
          SWAP_POOL_ID: hire.venue.id,
          SWAP_POOL_SHARED: String(hire.venue.sharedVersion),
        },
        summary: `swap ${amountText} ${d.in.symbol} -> ${d.out.symbol} via the ${hire.name} hire`
          + ` on its ${hire.venue.feeBps / 100}% pool`,
      };
    }
    case 'deposit_liquidity':
      return {
        command: 'node src/deposit-liquidity.js',
        env: {},
        summary: 'deploy capital into the guarded position (owner-gated)',
      };
    case 'rebalance':
      return {
        command: 'node src/rebalance.js',
        env: {},
        summary: 'move the guarded position to a new tick range (agent-gated)',
      };
    case 'redeem':
      return {
        command: 'node src/redeem.js',
        env: {},
        summary: 'redeem the guarded position back to the owner',
      };
    // A READ. There is no script and no transaction, so the plan carries neither: it names what to
    // ask for, and WHICH SERVER to ask is resolved from the installed talent in ui.ts — the one
    // place that talks to a talent's server, the same as the fill notification.
    case 'status':
      return {
        read: true,
        // The OWNER is decided HERE, from the deployment's own addresses. The page never names an
        // address, which is the same rule the swap path follows for amounts and venues.
        query: { what: 'balances', owner: DEPLOYER },
        summary: 'read the balances of the agent wallet from the query talent',
      };
    default:
      return null;
  }
}

/**
 * Read the hire's own policy from chain. Not remembered: a local flag would drift
 * the moment anyone changed the allowlist or suspended the hire, and those are the
 * fields the whole boundary rests on.
 */
async function policyState(hire: Hire) {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });
  try {
    const o = await client.getObject({ objectId: hire.policyId, include: { json: true } });
    // A Move struct's JSON as the chain returns it. The shape belongs to the chain, and
    // declaring fields here would be a second copy of that contract.
    const j: any = (o.object ?? o).json ?? {};
    const list: string[] = (j.allowed_pools?.contents ?? []).map((x: unknown) => String(x).toLowerCase());
    return {
      venueOpen: list.includes(String(hire.venue.id).toLowerCase()),
      venueCount: list.length,
      suspended: Boolean(j.suspended),
    };
  } catch (e) {
    return { venueOpen: false, venueCount: null, suspended: false, error: String((e as any)?.message ?? e).slice(0, 80) };
  }
}

/**
 * The SENDER's spendable SUI — what a maker escrows from.
 *
 * It used to read the VAULT balance, because the vault was where a swap's funds came
 * from. Escrowed orders do not touch the vault: the maker escrows from their own wallet
 * and the order holds it. So the check was comparing against the wrong pool of money,
 * and refused every chat-typed swap with "exceeds the vault balance 0" while the order
 * form worked fine — two paths, two funding requirements, and the gate only knew one.
 */
async function walletBalanceMist(coinType: string = SUI_TYPE) {
  // A fixed balance, for the acceptance check ONLY.
  //
  // The gate's balance comparison is ADVISORY -- the chain enforces the real
  // balance, so overriding it here cannot cause a fund loss; it can only make the
  // server's advice wrong. It exists because otherwise the check's happy-path cases
  // depend on the vault happening to be funded, and a check that goes red when the
  // state legitimately changes -- an owner withdrawing before an upgrade, say -- is a
  // check people learn to ignore.
  //
  // The override is in the coin being READ, not in MIST: a USDC order's balance is USDC units, and
  // an injected figure that meant one coin while the code read the other would make the check pass
  // for the wrong reason.
  const override = process.env.AGENT_WALLET_BALANCE_MIST;
  if (override !== undefined) return BigInt(override);

  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });
  // `DEPLOYER` is a TOP-LEVEL import now. It used to be reached from inside this function, and the
  // bug that caused is the reason: a name that was only ever imported here broke every real run
  // while the suite stayed green, because the suite injects a balance and this returned early.
  const sender = process.env.SUI_SENDER || DEPLOYER;
  const b = await client.getBalance({ owner: sender, coinType });
  return BigInt(b.balance?.balance ?? 0);
}

/**
 * The maker's remaining allowance, read from the OpenZeppelin ledger.
 *
 * The budget is NOT a policy field, so `getObject` cannot see it: it lives in a
 * `LinkedTable<BudgetKey, Allowance>` on the vault, keyed by `(cap_id, coin_type)`, and a table's
 * contents are not in the object's JSON. Nor is it a dynamic field, so `getDynamicField` cannot
 * reach it either.
 *
 * What works is calling the module's own view through a simulation — `simulateTransaction` with
 * `include: { commandResults: true }` returns each command's return values, and
 * `spend_vault::allowance<T>(vault, cap_id)` is a plain public view. The JSON-RPC client's
 * `devInspectTransactionBlock` would be the obvious route and is gone: public fullnodes answer
 * "JSON-RPC has been deprecated".
 *
 * Returns null on failure, NEVER 0. Zero means "this grant covers nothing", which is a real and
 * alarming claim; null means "could not read", which must not be mistaken for it.
 *
 * Exported because the build path needs the same figure. There is one reader of this ledger.
 */
export async function allowanceMist(capId: string, coinType: string = SUI_TYPE): Promise<bigint | null> {
  // A fixed allowance, for the acceptance check ONLY — the same reasoning as the balance
  // override above. The chain enforces the real bound, so overriding it here can only make the
  // server's ADVICE wrong, never lose funds; and without it the check's cases depend on whatever
  // the budget happens to be, which is a check people learn to ignore. In the coin being read.
  const override = process.env.AGENT_ALLOWANCE_MIST;
  if (override !== undefined) return BigInt(override);

  try {
    const { SuiGrpcClient } = await import('@mysten/sui/grpc');
    const { Transaction } = await import('@mysten/sui/transactions');
    const { PACKAGE_LATEST_ID, VAULT_ID, VAULT_SHARED_VERSION } = await import('./addresses.js');

    const client = new SuiGrpcClient({
      network: 'mainnet',
      baseUrl: 'https://fullnode.mainnet.sui.io:443',
    });
    const tx = new Transaction();
    // A read still needs a sender; nothing is signed or executed, so any address will do.
    tx.setSender(DEPLOYER);
    tx.moveCall({
      target: `${PACKAGE_LATEST_ID}::spend_vault::allowance`,
      // THE COIN MATTERS: the ledger holds one entry per coin type, so a USDC order's ceiling is a
      // different entry from the SUI grant. Reading the SUI one for a USDC amount compares two
      // different coins and would refuse or allow for a reason unrelated to the maker's budget.
      typeArguments: [coinType],
      arguments: [
        tx.sharedObjectRef({
          objectId: VAULT_ID, initialSharedVersion: VAULT_SHARED_VERSION, mutable: false,
        }),
        tx.pure.id(capId),
      ],
    });
    const bytes = await tx.build({ client });
    const res: any = await client.simulateTransaction({
      transaction: bytes,
      include: { commandResults: true },
    });
    const rv = res?.commandResults?.[0]?.returnValues?.[0]?.bcs;
    if (!rv) return null;
    // A Move u64 arrives as little-endian BCS bytes.
    const b = rv instanceof Uint8Array ? rv : Uint8Array.from(rv);
    let v = 0n;
    for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const text = args.filter((a) => a !== '--execute').join(' ').trim();
  if (!text) {
    console.error('usage: node src/agent.js "<request>"');
    process.exit(2);
  }

  // Read at request time, not at load: what the agent can do follows what is installed.
  const installedIds = listTalents().map((t) => t.id);
  const { actions: available } = describeTalents(installedIds);
  const validActions = available.map((a) => a.id);
  const { intent, finishReason } = await parseIntent(text, validActions);
  // DOES THIS ACTION MOVE VALUE? Read from the installed talent, before anything is judged,
  // because it decides whether a grant is involved at all.
  //
  // A read is what this exists for: no hire, no allowance, no venue and no suspension check,
  // because none of those can be violated by looking at a number. A suspended hire can still read
  // its own balance, and refusing that would be the gate confusing "may not spend" with "may not
  // act".
  const spends = actionSpends(installedIds, intent.action);
  // WHICH COIN THE AMOUNT IS IN — and both reads below are PER COIN on chain, so a USDC amount
  // compared against the SUI balance or the SUI ledger entry would be a unit error that refuses (or
  // allows) for a reason unrelated to the maker's budget.
  const inCoin = actionCoin(intent);
  // Not read at all for a read: two chain reads whose result cannot change the verdict.
  const walletBalanceIn = spends ? await walletBalanceMist(inCoin.type) : 0n;

  // The model extracted a literal; the arithmetic is ours and exact — and in the INPUT COIN's
  // decimals, which is the point: "0.05" is 50000 USDC units and 50000000 MIST.
  const parsed = parseAmount(intent.amountText, inCoin.decimals);
  const amountMist = parsed.ok ? parsed.amountMist : null;
  // Which hire applies is decided from the request text, not from the model's
  // opinion. See selectHire.
  const hirePick = selectHire(text);
  // `?? null` because the pick's return type has `hire` optional — it is absent on the refusal
  // branch — so a caller reading it gets `Hire | undefined` rather than `Hire | null`.
  //
  // And null for a READ, which is the honest report: a read is not routed through a hire, no
  // grant is consulted, and saying which hire it went through would imply one was.
  const hire = spends && hirePick.ok ? (hirePick.hire ?? null) : null;
  const policy = hire ? await policyState(hire) : null;
  // Read after `hire` is known, because the ledger is keyed by the cap and the cap is the hire's.
  // Null on failure, and the gate stands aside for null — see the refusal for why.
  const allowance = hire ? await allowanceMist(hire.capId, inCoin.type) : null;

  let verdict;
  if (!hirePick.ok) {
    // AMBIGUOUS, NOT REFUSED, and the distinction is the whole point of this branch.
    //
    // "the request names more than one hire — say which one" is a QUESTION, and it was being
    // reported as a refusal: the same event kind, the same terminal wording, the same dead end.
    // A user who names two things has not made a mistake; they have not finished, and the answer
    // is to offer the choices rather than to tell them off.
    verdict = { ok: false, reason: hirePick.reason, options: hirePick.named ?? [] };
  } else if (!parsed.ok) {
    verdict = { ok: false, reason: parsed.reason };
  } else {
      verdict = validate(intent, amountMist ?? null, {
        walletBalanceIn, allowance, text, hire, policy, actions: validActions, spends,
      });
  }

  let decidedBy;
  if (hirePick.named.length === 1) decidedBy = `request text names "${hirePick.named[0]}"`;
  else if (hirePick.named.length === 0) decidedBy = 'no hire named, so the default applies';
  else decidedBy = 'ambiguous, refused';

  const report = {
    request: text,
    model: { endpoint: QVAC_URL, model: MODEL, finishReason },
    intent,
    hire: hire
      ? {
          name: hire.name,
          policyId: hire.policyId,
          budgetSui: hire.budgetSui,
          venue: { feeBps: hire.venue.feeBps, id: hire.venue.id },
          venueOpen: policy?.venueOpen ?? null,
          suspended: policy?.suspended ?? null,
          decidedBy,
        }
      : null,
    // The model's own answer, recorded and explicitly not consulted. Kept because
    // it is the only signal on whether the model reads the request the way we do —
    // `groundedInRequest: false` is a hallucination we caught, which is worth being
    // able to count. Also kept in the schema deliberately: remove the field and the
    // hire name has to go somewhere, most likely into another field we do trust.
    modelHint: {
      agent: intent.agent ? intent.agent : null,
      groundedInRequest: intent.agent ? grounded(text, intent.agent) : false,
      consulted: false,
    },
    // EVERY MONEY FIGURE IS IN `inCoin`'s SMALLEST UNIT, and the coin says which. The keys used to
    // say MIST and mean it, for the one coin there was; a request can now be denominated in USDC,
    // so the unit is data rather than part of a name.
    inCoin: { symbol: inCoin.symbol, decimals: inCoin.decimals },
    amount: amountMist == null ? null : amountMist.toString(),
    walletBalance: walletBalanceIn.toString(),
    allowance: allowance === null ? null : allowance.toString(),
    validation: verdict,
  };

  if (!verdict.ok) {
    // A choice to offer is a question; anything else is a refusal. The exit code says the same
    // thing: ambiguity is not a failure, and a caller that treated it as one would have to
    // unpick the difference from the text.
    const options = (verdict as { options?: string[] }).options ?? [];
    const asking = options.length > 1;

    // THE TEMPLATE IS WHAT MAKES ANSWERING POSSIBLE, and it is not the original request.
    //
    // Re-sending the original text would name two hires again and ask the same question
    // forever. This is the request REBUILT from the parsed intent, which by construction
    // contains no hire name — so a client can answer by naming one, and the gate will find
    // exactly one and proceed.
    const template = intent.action === 'swap'
      ? `swap ${intent.amountText} ${intent.from} to ${intent.to}`
      : String(intent.action ?? '');
    console.log(JSON.stringify({
      ...report,
      decision: asking ? 'ASKING' : 'REFUSED',
      ...(asking ? { options, template } : {}),
    }, null, 2));
    process.exit(asking ? 0 : 1);
  }

    // PLANNING COMES FIRST, and a null hire is no longer a refusal by itself: a read has no hire
    // and is still plannable. `planFor` is what knows which actions need one — the guard that
    // used to sit here refused every action without a grant, which is now wrong for exactly one
    // of them.
    const plan = planFor(intent, amountMist ?? null, hire);
    if (!plan) {
      console.log(JSON.stringify({
        ...report,
        decision: 'REFUSED',
        // `no hire` when a grant was the missing piece, `no plan` when the action itself has no
        // route. The two read very differently to whoever sees them.
        reason: hire ? 'no plan' : 'no hire',
      }, null, 2));
      process.exit(1);
    }

  console.log(JSON.stringify({ ...report, decision: 'PROPOSED', plan }, null, 2));

  // Signing is the wallet extension's job now, from the browser. This process
  // deliberately has no way to sign: it proposes and it builds, and a human
  // approves in a wallet that shows its own prompt.
  if (!execute) {
    console.error('\nproposal only — sign it from the browser, or use the UI');
    return;
  }
  console.error(
    '\n--execute was removed. Signing no longer happens here.\n' +
    'Use the UI (bun run ui -> http://127.0.0.1:8788), which builds the transaction,\n' +
    'asks the wallet extension to sign it, and submits the signed bytes.',
  );
  process.exit(2);
}

// THE CLI ENTRY IS GUARDED, AND THAT IS NOT DECORATION.
//
// `ui.ts` imports `allowanceMist` from here to show the on-chain allowance, and a bare `main()`
// therefore ran on THAT import too: the server printed this module's usage line and exited 2
// before it ever listened. The bare call had been harmless only while nothing imported the file,
// which is a property of the callers, not of this module — so the guard belongs here.
if (import.meta.main) {
  main().catch((e) => {
    console.error('fatal:', e?.message || e);
    process.exit(1);
  });
}
