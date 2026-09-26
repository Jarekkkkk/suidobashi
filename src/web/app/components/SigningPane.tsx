import type { Event } from '@/lib/api';
import { cn } from '@/lib/utils';

/*
 * The signing pane: what is about to be signed, and what the chain actually did.
 *
 * Three sections, and the separation is the point:
 *
 *   flow     where in the pipeline we are
 *   terms    what the signature will authorise — read before signing, not after
 *   on chain the digest and its status, which are facts rather than our claims
 *
 * A claim of success and a chain-read fact must not look alike. That is the same rule the
 * events follow with their `source`, and it is why this pane colours by source rather than
 * decoratively: if a model's guess and a settled transaction render the same, the interface is
 * telling the user they are the same kind of thing.
 *
 * Everything here is DERIVED from the events the chat already emits. No new plumbing, and no
 * second source of truth to drift out of step with the conversation.
 */

const STEPS = ['propose', 'build', 'sign', 'submit', 'fill'] as const;
type Step = (typeof STEPS)[number];

/** Which step an event kind belongs to. Kinds come from src/web/events.ts. */
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

/** A section heading. Three of them, so they are one component rather than three copies. */
function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

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
  // A TERMINAL event means the flow is OVER, so every step reads as done rather than the
  // indicator still pointing at the last one. "fill · now" after a completed reclaim says the
  // flow is waiting on something it is not.
  const finished = events.length > 0 && events[events.length - 1]?.terminal === true;

  // Otherwise the furthest step reached, not the latest event's: the reclaim reports under
  // `fill`, and a step indicator that walked backwards would read as a failure.
  const reached = finished ? STEPS.length : events.reduce((best, e) => {
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

  const idle = reached < 0;

  return (
    <div className="flex flex-col gap-6 p-5">
      {/* The flow. "sign" is the one that matters most — it is the moment the wallet is waiting
          on a person, and the moment to read the terms below. */}
      <section className="animate-fade-in">
        <Heading>flow</Heading>
        <ol className="mt-3 flex flex-col gap-1">
          {STEPS.map((s, i) => {
            const done = reached > i;
            const now = reached === i;
            return (
              <li key={s} className="flex items-center gap-2.5 text-[13px]">
                {/* A rail rather than a dot: the line between steps is what makes it read as a
                    sequence, and the current step is the only one that is bright. */}
                <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                  {i < STEPS.length - 1 && (
                    <span className={cn(
                      'absolute top-4 h-3.5 w-px',
                      done ? 'bg-success/50' : 'bg-border',
                    )} />
                  )}
                  <span className={cn(
                    'h-1.5 w-1.5 rounded-full transition-colors',
                    done && 'bg-success',
                    now && 'h-2 w-2 bg-brand',
                    !done && !now && 'bg-border',
                  )} />
                </span>
                <span className={cn(
                  'transition-colors',
                  done && 'text-muted-foreground',
                  now && 'font-medium text-foreground',
                  !done && !now && 'text-muted-foreground/50',
                )}>
                  {s}
                </span>
                {now && (
                  <span className="ml-auto rounded-sm bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">
                    now
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      {/* The terms. Shown BEFORE the signature is requested, which is the only time they are
          useful — afterwards they are a receipt and the wallet has already decided. */}
      {termEntries.length > 0 && (
        <section className="animate-rise-in">
          <Heading>what you are signing</Heading>
          <dl className="mt-3 overflow-hidden rounded-lg border border-border bg-background/40">
            {termEntries.map(([k, v], i) => (
              <div
                key={k}
                className={cn(
                  'flex items-baseline gap-3 px-3 py-2',
                  i > 0 && 'border-t border-border',
                )}
              >
                <dt className="shrink-0 text-[12px] text-muted-foreground">{LABEL[k] ?? k}</dt>
                <dd className={cn(
                  'ml-auto min-w-0 break-all text-right text-[13px]',
                  // NOT shortened. This is the one value a person may need to copy — an order
                  // whose reclaim was refused is still on chain, and the id is how it is
                  // retried. A truncated id looks tidy and is useless.
                  k === 'orderId' ? 'font-mono text-[11px] text-muted-foreground' : 'font-medium',
                )}>
                  {String(v)}{UNIT[k] ?? ''}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* The chain. Digests, in order, as read back rather than as reported. */}
      {digests.length > 0 && (
        <section className="animate-rise-in">
          <Heading>on chain</Heading>
          <ul className="mt-3 flex flex-col gap-1.5">
            {digests.map((d) => (
              <li key={d} className="flex items-center gap-2">
                <span className="h-1 w-1 shrink-0 rounded-full bg-chain" />
                <span className="font-mono text-[11px] text-chain">{short(d)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground/70">
            Read from the chain, not from what we said would happen.
          </p>
        </section>
      )}

      {idle && (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Nothing yet.
            <span className="mt-1 block text-muted-foreground/60">
              The terms appear here before the wallet asks for a signature.
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
