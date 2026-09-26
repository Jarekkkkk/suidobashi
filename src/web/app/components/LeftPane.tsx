import { useState, useEffect, useCallback } from 'react';
import { api, type Event } from '@/lib/api';
import { signAndSubmit, type Say, type OnTerms } from '@/lib/flow';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/*
 * The left pane: what is installed, and what is left over.
 *
 * The second tab exists because this system is NOTIFIED, NOT WATCHING — the maker tells the
 * server an order exists, and nothing polls. So something has to hold the things that were
 * left behind, and the honest answer is the user, with a place that shows them.
 *
 * IT MUST NOT BE A DEAD END. A list of things you cannot act on is worse than no list: it
 * reports a problem and withholds the remedy. Every row carries its action, and the action is
 * wired to the same build→sign→submit the chat uses.
 */

type Order = {
  orderId: string;
  state: 'live' | 'settled';
  action: 'revoke' | 'burn';
  expired: boolean;
  minOut: string;
  expiresAtMs: string;
};

type Outstanding = {
  orders: Order[];
  scanned: number;
  candidates: number;
  orderObjects: number;
  at: number;
};

type Hire = {
  name: string;
  agent?: string;
  budgetSui?: string;
  suspended?: boolean;
  venues?: number;
};

/** Seconds until an order expires, or null once it has. */
function countdown(expiresAtMs: string): number | null {
  const left = Number(expiresAtMs) - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : null;
}

export function LeftPane({ events, say, onTerms }: { events: Event[]; say: Say; onTerms: OnTerms }) {
  const [tab, setTab] = useState<'agents' | 'outstanding'>('agents');
  const [out, setOut] = useState<Outstanding | null>(null);
  const [hires, setHires] = useState<Hire[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, h] = await Promise.all([
        api<Outstanding>('/api/outstanding'),
        api<{ hires?: Hire[] } | Hire[]>('/api/hires'),
      ]);
      setOut(o);
      setHires(Array.isArray(h) ? h : (h.hires ?? []));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // RELOAD WHEN A FLOW ENDS, not on every event. A reload is a multi-second chain scan, so
  // firing it per event would run dozens per swap; a terminal event is the signal that
  // on-chain state may have changed, and it is the same signal the signing pane uses to know
  // the flow is over.
  //
  // Without this the pane was a snapshot taken at page load, so an order created afterwards
  // was invisible until the user thought to press refresh — which is not a feature, it is a
  // chore. Found by the user reporting a missing row while the endpoint was correct all along.
  const terminalCount = events.reduce((n, e) => n + (e.terminal ? 1 : 0), 0);
  useEffect(() => {
    if (terminalCount > 0) void load();
  }, [terminalCount, load]);

  /**
   * Act on one row.
   *
   * TWO PATHS, and the split is deliberate. A BURN is signed in the wallet, because Slush
   * handles it and the rebate goes to whoever signs — the maker should be that person.
   *
   * A REVOKE is executed by the server. Slush refuses to even prepare the refund transaction
   * — it fails before showing a modal — while the chain executes the identical bytes happily,
   * so routing around a wallet bug by removing the wallet is the smaller change. It is also
   * the safer one: the destination is FIXED AT CREATE, so a revoke can only ever return escrow
   * to its maker. That is precisely why the operation is permissionless on chain, and why the
   * server gains no power by running it.
   */
  async function act(order: Order) {
    if (busy) return;
    setBusy(true);

    if (order.action === 'revoke') {
      say({
        kind: 'revoking',
        source: 'pipeline',
        text: 'revoking the expired order…',
        terminal: false,
      });
      try {
        const r = await api<{ ok?: boolean; digest?: string; why?: string; events?: Event[] }>(
          '/api/revoke', { orderId: order.orderId },
        );
        (r.events ?? []).forEach(say);
        if (!r.ok && !r.events?.length) {
          say({
            kind: 'refused',
            source: 'pipeline',
            text: `refused — ${r.why ?? 'the revoke did not go through'}`,
            terminal: true,
          });
        }
        await load();
      } catch (e) {
        say({
          kind: 'ended',
          source: 'pipeline',
          text: `ended: ${e instanceof Error ? e.message : String(e)}`,
          terminal: true,
        });
      } finally {
        setBusy(false);
      }
      return;
    }

    say({
      kind: 'reclaiming',
      source: 'pipeline',
      text: 'reclaiming a settled order\u2019s storage…',
      terminal: false,
    });
    try {
      const digest = await signAndSubmit(order.action, { orderId: order.orderId }, say, onTerms);
      if (digest) {
        say({
          kind: 'reclaimed',
          source: 'chain',
          text: `reclaimed — ${digest} · about 0.0042 SUI of storage back`,
          terminal: true,
          data: { digest, orderId: order.orderId },
        });
        await load();
      }
    } catch (e) {
      say({
        kind: 'ended',
        source: 'pipeline',
        text: `ended: ${e instanceof Error ? e.message : String(e)}`,
        terminal: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* A plain tab strip rather than the shadcn Tabs component: two tabs, no keyboard
          roving, and vendoring Radix for this would be more code than it replaces. */}
      <div className="flex gap-1 border-b border-white/10 px-3 py-2">
        {(['agents', 'outstanding'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded px-2 py-1 text-xs transition-colors',
              tab === t ? 'bg-white/10 text-white/90' : 'text-white/40 hover:text-white/70',
            )}
          >
            {t}
            {t === 'outstanding' && (out?.orders.length ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-400/20 px-1.5 text-[10px] text-amber-300">
                {out?.orders.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {note && <p className="px-3 py-2 text-xs text-amber-300/80">{note}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'agents' && (
          <ul className="space-y-2">
            {(hires ?? []).map((h) => (
              <li key={h.name} className="rounded border border-white/10 p-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white/85">{h.name}</span>
                  {h.suspended && (
                    <span className="rounded bg-red-500/15 px-1.5 text-[10px] text-red-300">
                      suspended
                    </span>
                  )}
                </div>
                <div className="mt-1 font-mono text-[10px] text-white/35">
                  {h.agent ? `${h.agent.slice(0, 10)}…${h.agent.slice(-4)}` : 'no agent'}
                </div>
                <div className="mt-1 text-[11px] text-white/40">
                  budget {h.budgetSui ?? '—'} SUI · {h.venues ?? 0} venue(s)
                </div>
              </li>
            ))}
            {hires !== null && hires.length === 0 && (
              <li className="text-xs text-white/40">No hires configured.</li>
            )}
            {hires === null && !note && <li className="text-xs text-white/40">reading…</li>}
          </ul>
        )}

        {tab === 'outstanding' && (
          <>
            {out && out.orders.length === 0 && (
              <p className="text-xs text-white/40">
                Nothing needs attention.
                <span className="mt-1 block text-[10px] text-white/25">
                  {out.scanned} transactions scanned · {out.candidates} created objects read
                </span>
              </p>
            )}
            {/* The counters are shown, not hidden: an empty list on its own cannot be told
                apart from a broken scan, so the numbers that distinguish them are visible. */}
            <ul className="space-y-2">
              {(out?.orders ?? []).map((o) => {
                const left = countdown(o.expiresAtMs);
                return (
                  <li key={o.orderId} className="rounded border border-white/10 p-2">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'rounded px-1.5 text-[10px]',
                        o.state === 'settled'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-sky-500/15 text-sky-300',
                      )}>
                        {o.state}
                      </span>
                      <span className="text-[11px] text-white/40">
                        {o.state === 'settled'
                          ? 'storage is yours to reclaim'
                          : left === null
                            ? 'expired — revocable'
                            : `expires in ${left}s`}
                      </span>
                    </div>
                    <div className="mt-1 break-all font-mono text-[10px] text-white/35">
                      {o.orderId}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 w-full"
                      // A live, unexpired order cannot be revoked: refund aborts with
                      // ENotExpired, which is the guard stopping a maker racing their own
                      // order. Offering the button would promise a guaranteed failure.
                      disabled={busy || (o.action === 'revoke' && left !== null)}
                      onClick={() => void act(o)}
                    >
                      {o.action}
                      {o.action === 'revoke' && left !== null ? ` in ${left}s` : ''}
                    </Button>
                  </li>
                );
              })}
            </ul>
            {out && out.orders.length > 0 && (
              <p className="mt-3 text-[10px] text-white/25">
                snapshot · {out.scanned} transactions scanned · {out.orderObjects} order
                object(s) on chain
              </p>
            )}
          </>
        )}
      </div>

      <div className="border-t border-white/10 p-2">
        <Button size="sm" variant="ghost" className="w-full" onClick={() => void load()}>
          refresh
        </Button>
      </div>
    </div>
  );
}
