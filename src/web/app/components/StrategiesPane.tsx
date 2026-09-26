import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { api, type StrategyListing } from '@/lib/api';

/*
 * The listing for flavor (b): the strategies a maker can point a guard at.
 *
 * WHAT AN OPERATOR IS, because a listing that does not say is asking for trust it has not earned.
 * The operator is an ADDRESS inside the maker's own guard. It holds no capability of the maker's,
 * no key to their account, and no object of value: the guard holds all three DeepBook capabilities
 * itself and generates the proof for each order internally. So the whole reach of an operator on
 * one maker's money is the band, the per-order size and the budget that maker set on that guard —
 * which is why those are the terms this page prints, and why it prints no performance claims.
 *
 * The "will not" line is not boilerplate. A listing that states only what a strategy does is an
 * advert; the edges are the part a maker is actually deciding about.
 *
 * THE ACTION IS ABSENT FOR A REASON, AND THE REASON IS SERVED. Opting in means creating a guard
 * pointed at this operator, which needs the guard module on chain. Until it is, the server answers
 * with a `blocked` line and this page shows it — an absent button with a reason rather than a button
 * that fails when pressed. When the module is published, that same field goes null and this page
 * starts offering the action, with no change here.
 *
 * The operator address is printed in FULL. Ids that look tidy are useless for the one thing a
 * maker does with them, which is check them against something.
 */

export function StrategiesPane() {
  const [listing, setListing] = useState<StrategyListing | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    api<StrategyListing>('/api/strategies')
      .then(setListing)
      .catch((e) => setFailed(String(e && typeof e === 'object' && 'message' in e ? e.message : e)));
  }, []);

  if (failed) return <p className="p-3 text-[11px] text-destructive">{failed}</p>;
  if (!listing) return <p className="p-3 text-[11px] text-muted-foreground">Reading…</p>;
  if (listing.strategies.length === 0) {
    return <p className="p-3 text-[11px] text-muted-foreground">Nothing is listed.</p>;
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        An operator holds nothing of yours. It is an address inside your guard; the band, the size
        and the budget you set there are the whole of its reach.
      </p>

      <ul className="flex flex-col gap-2">
        {listing.strategies.map((s) => (
          <li key={s.id} className="overflow-hidden rounded-lg border border-border">
            <div className="border-b border-border px-2.5 py-1.5">
              <p className="text-[13px] font-medium">{s.name}</p>
              <p className="font-mono text-[11px] text-muted-foreground">{s.operator}</p>
            </div>

            <div className="flex flex-col gap-2 p-2.5">
              <p className="text-[11px] leading-relaxed">{s.summary}</p>

              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                <Term label="band" value={`${s.bandUsdc.low}–${s.bandUsdc.high} USDC/SUI`} />
                <Term label="ladder" value={`${s.levels} levels of ${s.perLevelSui} SUI`} />
                <Term label="budget" value={`${s.budgetSui} SUI, spent once`} />
                <Term label="looks" value={`every ${s.everySeconds}s`} />
              </dl>

              <p className="border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
                {s.willNot}
              </p>

              <Button size="sm" variant="outline" disabled title={listing.blocked ?? undefined}>
                Point a guard at this
              </Button>
              {listing.blocked && (
                <p className="text-[10px] leading-relaxed text-muted-foreground">{listing.blocked}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </>
  );
}
