import type { Event } from '@/lib/api';
import { cn } from '@/lib/utils';

/*
 * The signing pane: what is about to be signed, and what the chain actually did.
 *
 * Three things, and the separation is the point:
 *
 *   step     where in the flow we are
 *   terms    what the signature will authorise — read before signing, not after
 *   chain    the digest and its status, which are facts rather than our claims
 *
 * A claim of success and a chain-read fact must not look alike. That is the same rule the
 * events follow with their `source`, and it is why this pane colours by source rather than
 * decoration: if a model's guess and a settled transaction render the same, the interface is
 * telling the user they are the same kind of thing.
 *
 * Everything here is DERIVED from the events the chat already emits. No new plumbing, and no
 * second source of truth to drift out of step with the conversation.
 */

const STEPS = ['propose', 'build', 'sign', 'submit', 'fill'] as const;
type Step = (typeof STEPS)[number];

/** Which step an event kind belongs to. Kinds come from src/web/events.js. */
const STEP_OF: Record<string, Step> = {
  ask: 'propose',
  extracting: 'propose',
  proposed: 'propose',
  refused: 'propose',
  building: 'build',
  ended: 'build',
  signing: 'sign',
  submitted: 'submit',
  filling: 'fill',
  filled: 'fill',
  unfilled: 'fill',
  reclaiming: 'fill',
  reclaimed: 'fill',
};

/** Friendly labels for the terms the server describes. Unknown keys fall back to the key. */
const LABEL: Record<string, string> = {
  action: 'action',
  escrowSui: 'escrow',
  minOutUsdc: 'you receive at least',
  feeOutUsdc: 'fee to the filler',
  orderId: 'order',
  amountSui: 'amount',
  hire: 'hire',
  agent: 'agent',
  boundBps: 'price bound',
  venue: 'venue',
  usdc: 'usdc',
  suiHeadroom: 'sui headroom',
  tickLower: 'tick lower',
  tickUpper: 'tick upper',
  width: 'width',
};

/** The unit a term carries. Values arrive decimal; only the unit needs adding. */
const UNIT: Record<string, string> = {
  escrowSui: ' SUI',
  amountSui: ' SUI',
  minOutUsdc: ' USDC',
  feeOutUsdc: ' USDC',
  usdc: ' USDC',
  suiHeadroom: ' SUI',
};

function short(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 10)}…${hex.slice(-4)}` : hex;
}

export function SigningPane({
  events,
  terms,
}: {
  events: Event[];
  terms: Record<string, unknown> | null;
}) {
  // The furthest step reached, not the latest event's step: the reclaim reports under
  // `fill`, and a step indicator that walked backwards would read as a failure.
  const reached = events.reduce((best, e) => {
    const step = STEP_OF[e.kind];
    if (!step) return best;
    return Math.max(best, STEPS.indexOf(step));
  }, -1);

  // Chain-sourced events with a digest are the record of what actually landed.
  const digests = events
    .filter((e) => e.source === 'chain' && typeof e.data?.digest === 'string')
    .map((e) => e.data!.digest as string);

  const termEntries = terms
    ? Object.entries(terms).filter(([, v]) => v !== null && v !== undefined && v !== '')
    : [];

  return (
    <div className="space-y-6 p-4">
      {/* The step. "sign" is the one that matters most — it is the moment the wallet is
          waiting on a person, and the moment to read the terms below. */}
      <section>
        <div className="text-xs uppercase tracking-wider text-white/40">flow</div>
        <ol className="mt-3 space-y-1.5">
          {STEPS.map((s, i) => {
            const done = reached > i;
            const now = reached === i;
            return (
              <li key={s} className="flex items-center gap-2 text-sm">
                <span className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  done && 'bg-emerald-400/70',
                  now && 'bg-sky-400',
                  !done && !now && 'bg-white/15',
                )} />
                <span className={cn(
                  done && 'text-white/45',
                  now && 'text-white/90',
                  !done && !now && 'text-white/25',
                )}>
                  {s}
                </span>
                {now && <span className="ml-auto text-xs text-sky-300/70">now</span>}
              </li>
            );
          })}
        </ol>
      </section>

      {/* The terms. Shown BEFORE the signature is requested, which is the only time they
          are useful — afterwards they are a receipt, and the wallet has already decided. */}
      {termEntries.length > 0 && (
        <section>
          <div className="text-xs uppercase tracking-wider text-white/40">
            what you are signing
          </div>
          <dl className="mt-3 space-y-1.5 text-sm">
            {termEntries.map(([k, v]) => (
              <div key={k} className="flex gap-3">
                <dt className="shrink-0 text-white/40">{LABEL[k] ?? k}</dt>
                <dd className={cn(
                  'ml-auto min-w-0 break-all text-right',
                  k === 'orderId' ? 'font-mono text-xs text-white/60' : 'text-white/85',
                )}>
                  {k === 'orderId' ? short(String(v)) : `${String(v)}${UNIT[k] ?? ''}`}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* The chain. Digests, in order, as read back rather than as reported. */}
      {digests.length > 0 && (
        <section>
          <div className="text-xs uppercase tracking-wider text-white/40">on chain</div>
          <ul className="mt-3 space-y-1.5">
            {digests.map((d) => (
              <li key={d} className="font-mono text-xs text-emerald-300/80">{short(d)}</li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-snug text-white/30">
            Read from the chain, not from what we said would happen.
          </p>
        </section>
      )}

      {reached < 0 && (
        <p className="text-sm text-white/40">
          Nothing yet. The terms appear here before the wallet asks for a signature.
        </p>
      )}
    </div>
  );
}
