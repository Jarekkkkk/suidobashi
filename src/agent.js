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
import { HIRES, HIRE_NAMES, DEFAULT_HIRE } from './hires.js';

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

/** The only actions the agent may express. Anything else is `unknown`, and refused. */
const ACTIONS = ['swap', 'deposit_liquidity', 'rebalance', 'redeem', 'status', 'unknown'];

const SYSTEM_PROMPT = `Extract the action, the direction, the amount and the agent EXACTLY as written.
Do not convert units. Do not do arithmetic.
from and to are the coin symbols, or "" when the request has no direction.
agent is which hired agent to use, or "" for the default. Available: ${HIRE_NAMES.join(', ')}.
If no amount is given, use "".
Use action "unknown" when the request is not one of the listed actions.
Valid actions: swap, deposit_liquidity, rebalance, redeem, status. /no_think`;

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

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'intent',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
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

/**
 * Exact decimal → MIST. No floating point: parse the string by hand so "0.05"
 * cannot become 0.05000000000000001 MIST.
 */
function parseAmountText(text) {
  const t = String(text ?? '').trim();
  if (t === '') return { ok: true, amountMist: 0n };
  if (!/^\d+(\.\d{1,9})?$/.test(t)) {
    return { ok: false, reason: `amount "${t}" is not a plain decimal with at most 9 places` };
  }
  const [whole, frac = ''] = t.split('.');
  const padded = (frac + '000000000').slice(0, 9);
  return { ok: true, amountMist: BigInt(whole) * SUI_MIST + BigInt(padded) };
}

async function parseIntent(text) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const [user, intent] of EXAMPLES) {
    messages.push({ role: 'user', content: user });
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
      response_format: RESPONSE_FORMAT,
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
function grounded(text, value) {
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
function selectHire(text) {
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
  return { ok: true, hire: HIRES[named[0]], named };
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
function validate(intent, amountMist, { vaultSuiMist, text, hire, policy }) {
  if (!intent || typeof intent !== 'object') return { ok: false, reason: 'not an object' };
  if (!ACTIONS.includes(intent.action)) {
    return { ok: false, reason: `action "${intent.action}" is not in the allowlist` };
  }
  if (intent.action === 'unknown') {
    return { ok: false, reason: 'request is not one of the supported actions' };
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
    // The hire must actually be allowed on its venue. Checked here rather than
    // left to the chain so a request routed to an unopened hire is refused for
    // the right reason, cheaply, instead of aborting EPoolNotAllowed later.
    if (policy && !policy.venueOpen) {
      return {
        ok: false,
        reason:
          `the ${hire.name} hire is not allowlisted on its venue ` +
          `(${hire.venue.feeBps / 100}% pool) — its allowlist holds ${policy.venueCount ?? '?'} pool(s). ` +
          'Open the venue first.',
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
  if (amountMist > 0n && amountMist > vaultSuiMist) {
    return {
      ok: false,
      reason: `amount ${amountMist} exceeds the vault balance ${vaultSuiMist} — the chain would refuse it anyway`,
    };
  }
  if ((intent.action === 'swap' || intent.action === 'deposit_liquidity') && amountMist <= 0n) {
    return { ok: false, reason: `${intent.action} needs a positive amount` };
  }
  return { ok: true };
}

/** Map a validated intent onto the script that already proves the operation. */
function planFor(intent, amountMist, hire) {
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
async function policyState(hire) {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });
  try {
    const o = await client.getObject({ objectId: hire.policyId, include: { json: true } });
    const j = (o.object ?? o).json ?? {};
    const list = (j.allowed_pools?.contents ?? []).map((x) => String(x).toLowerCase());
    return {
      venueOpen: list.includes(String(hire.venue.id).toLowerCase()),
      venueCount: list.length,
      suspended: Boolean(j.suspended),
    };
  } catch (e) {
    return { venueOpen: false, venueCount: null, suspended: false, error: String(e?.message || e).slice(0, 80) };
  }
}

async function vaultBalanceMist() {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  const { VAULT_ID } = await import('./addresses.js');
  const client = new SuiGrpcClient({
    network: 'mainnet',
    baseUrl: 'https://fullnode.mainnet.sui.io:443',
  });
  const b = await client.getBalance({ owner: VAULT_ID, coinType: '0x2::sui::SUI' });
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

  const { intent, finishReason } = await parseIntent(text);
  const vaultSuiMist = await vaultBalanceMist();

  // The model extracted a literal; the arithmetic is ours and exact.
  const parsed = parseAmountText(intent.amountText);
  const amountMist = parsed.ok ? parsed.amountMist : null;
  // Which hire applies is decided from the request text, not from the model's
  // opinion. See selectHire.
  const hirePick = selectHire(text);
  const hire = hirePick.ok ? hirePick.hire : null;
  const policy = hire ? await policyState(hire) : null;

  let verdict;
  if (!hirePick.ok) verdict = { ok: false, reason: hirePick.reason };
  else if (!parsed.ok) verdict = { ok: false, reason: parsed.reason };
  else verdict = validate(intent, amountMist, { vaultSuiMist, text, hire, policy });

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
    amountMist: amountMist === null ? null : amountMist.toString(),
    vaultBalanceMist: vaultSuiMist.toString(),
    validation: verdict,
  };

  if (!verdict.ok) {
    console.log(JSON.stringify({ ...report, decision: 'REFUSED' }, null, 2));
    process.exit(1);
  }

  const plan = planFor(intent, amountMist, hire);

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
