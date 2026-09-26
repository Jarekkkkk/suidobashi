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
import { describeTalents } from './talents.js';
import { listTalents } from './db.js';

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

const SUI_MIST = 1_000_000_000n;

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

/** The only direction our module can execute: Pool<USDC, SUI> with a2b = false. */
const SUPPORTED_FROM = 'SUI';
const SUPPORTED_TO = 'USDC';

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
 * Exact decimal → MIST. No floating point: parse the string by hand so "0.05"
 * cannot become 0.05000000000000001 MIST.
 */
function parseAmountText(text: string) {
  const t = String(text ?? '').trim();
  // `unknown` IS NOT AN AMOUNT. The model writes it when it cannot read one, and it was being
  // reported as `amount "unknown" is not a plain decimal` — a refusal that reads as the USER's
  // mistake for something the model did, and names a decimal nobody typed. Treated as absent,
  // which is what it means, so the next check says "no amount given" instead.
  if (t === '' || /^unknown$/i.test(t)) return { ok: true, amountMist: 0n };
  if (!/^\d+(\.\d{1,9})?$/.test(t)) {
    return { ok: false, reason: `amount "${t}" is not a plain decimal with at most 9 places` };
  }
  const [whole, frac = ''] = t.split('.');
  const padded = (frac + '000000000').slice(0, 9);
  return { ok: true, amountMist: BigInt(whole) * SUI_MIST + BigInt(padded) };
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
{ walletSuiMist, text, hire, policy, actions }: {
walletSuiMist: bigint; text: string; hire: Hire | null; policy: any;
/** What the installed talents make available, checked below. */
actions: string[];
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
    if (intent.from !== SUPPORTED_FROM || intent.to !== SUPPORTED_TO) {
      return {
        ok: false,
        reason:
          `only ${SUPPORTED_FROM} -> ${SUPPORTED_TO} is supported; this asked for ` +
          `${intent.from || '(none)'} -> ${intent.to || '(none)'}`,
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

  // The hire was already chosen from the request text by the caller, and the
  // venue read from its policy, so both are settled by the time this runs. What
  // the model put in its `agent` field is deliberately not consulted.
  if (amountMist > 0n && amountMist > walletSuiMist) {
    return {
      ok: false,
      reason: `amount ${amountMist} exceeds your wallet balance ${walletSuiMist} — `
        + 'the escrow would have nothing to draw from',
    };
  }
  if ((intent.action === 'swap' || intent.action === 'deposit_liquidity') && amountMist <= 0n) {
    return { ok: false, reason: `${intent.action} needs a positive amount` };
  }
  return { ok: true };
}

/** Map a validated intent onto the script that already proves the operation. */
function planFor(intent: any, amountMist: bigint | null, hire: Hire) {
  const sui = (Number(amountMist) / Number(SUI_MIST)).toFixed(4);
  switch (intent.action) {
    case 'swap': {
      return {
        command: 'node src/swap.js',
        env: {
          SWAP_MIST: String(amountMist),
          SWAP_POLICY_ID: hire.policyId,
          SWAP_POLICY_SHARED: String(hire.policySharedVersion),
          // The hire's own venue, not a global default.
          SWAP_POOL_ID: hire.venue.id,
          SWAP_POOL_SHARED: String(hire.venue.sharedVersion),
        },
        summary: `swap ${sui} SUI -> USDC via the ${hire.name} hire on its ${hire.venue.feeBps / 100}% pool`,
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
async function walletBalanceMist() {
  // A fixed balance, for the acceptance check ONLY.
  //
  // The gate's balance comparison is ADVISORY -- the chain enforces the real
  // balance, so overriding it here cannot cause a fund loss; it can only make the
  // server's advice wrong. It exists because otherwise the check's happy-path cases
  // depend on the vault happening to be funded, and a check that goes red when the
  // state legitimately changes -- an owner withdrawing before an upgrade, say -- is a
  // check people learn to ignore.
  const override = process.env.AGENT_WALLET_BALANCE_MIST;
  if (override !== undefined) return BigInt(override);

  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });
  // Imported here rather than at the top, matching how this file already reaches
  // addresses.js. Using a name that was never imported is what broke every real run
  // while the test suite stayed green — the suite injects a balance, so this function
  // returned early and the missing name was never evaluated.
  const { DEPLOYER } = await import('./addresses.js');
  const sender = process.env.SUI_SENDER || DEPLOYER;
  const b = await client.getBalance({ owner: sender, coinType: '0x2::sui::SUI' });
  return BigInt(b.balance?.balance ?? 0);
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
  const walletSuiMist = await walletBalanceMist();

  // The model extracted a literal; the arithmetic is ours and exact.
  const parsed = parseAmountText(intent.amountText);
  const amountMist = parsed.ok ? parsed.amountMist : null;
  // Which hire applies is decided from the request text, not from the model's
  // opinion. See selectHire.
  const hirePick = selectHire(text);
  // `?? null` because the pick's return type has `hire` optional — it is absent on the refusal
  // branch — so a caller reading it gets `Hire | undefined` rather than `Hire | null`.
  const hire = hirePick.ok ? (hirePick.hire ?? null) : null;
  const policy = hire ? await policyState(hire) : null;

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
        walletSuiMist, text, hire, policy, actions: validActions,
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
    amountMist: amountMist == null ? null : amountMist.toString(),
    walletBalanceMist: walletSuiMist.toString(),
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

    // The verdict above already refused a null hire, so this is the compiler needing to be told
    // what the control flow guarantees rather than a case the code can reach.
    if (!hire) {
      console.log(JSON.stringify({ ...report, decision: 'REFUSED', reason: 'no hire' }, null, 2));
      process.exit(1);
    }
    const plan = planFor(intent, amountMist ?? null, hire);

  if (!plan) {
    console.log(JSON.stringify({ ...report, decision: 'REFUSED', reason: 'no plan' }, null, 2));
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

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
