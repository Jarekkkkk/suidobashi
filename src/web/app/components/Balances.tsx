import { useState, useEffect, useCallback } from 'react';
import { api, fromUnits, type Event } from '@/lib/api';
import { cn } from '@/lib/utils';

/*
 * What you have.
 *
 * The app could move money without ever showing a balance, which is the wrong order of trust:
 * every action here spends something, and a control whose effect you cannot see is a control
 * you learn to distrust. The escrow flow in particular moves SUI OUT of the wallet and back,
 * and without a figure on screen that is invisible.
 *
 * THE VAULT IS DELIBERATELY NOT SHOWN. It is where a swap used to draw from and it is empty and
 * will stay empty — the escrow path replaced it. A balance that is always zero teaches the user
 * to ignore the row, which is worse than not having it.
 */

type State = {
  walletSuiMist: string;
  usdc: string;
  cetus: string;
};

/** One figure. The label IS the unit, so it is not repeated after the number. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5" title={`${label} balance`}>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground/60">{label}</span>
      <span className="font-mono text-[12px] text-foreground">{value}</span>
    </div>
  );
}

export function Balances({ events, className }: { events: Event[]; className?: string }) {
  const [state, setState] = useState<State | null>(null);
  const [stale, setStale] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api<State>('/api/state'));
      setStale(false);
    } catch {
      // A balance that cannot be read is shown as STALE rather than as zero. Rendering 0 would
      // be a number the user might act on, and it would be a lie about their money.
      setStale(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Reload when a flow ends, not on every event: the balance changes when a transaction lands,
  // and a terminal event is the signal that one did. Same trigger the outstanding tab uses.
  const terminalCount = events.reduce((n, e) => n + (e.terminal ? 1 : 0), 0);
  useEffect(() => {
    if (terminalCount > 0) void load();
  }, [terminalCount, load]);

  if (stale) {
    return (
      <span className={cn('text-[11px] text-muted-foreground/50', className)}>
        balances unavailable
      </span>
    );
  }

  if (!state) {
    return <span className={cn('text-[11px] text-muted-foreground/40', className)}>…</span>;
  }

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <Figure label="SUI" value={fromUnits(state.walletSuiMist, 9)} />
      <span className="h-3 w-px bg-border" />
      <Figure label="USDC" value={fromUnits(state.usdc, 6)} />
      <span className="h-3 w-px bg-border" />
      {/* NINE decimals, not six. CETUS is a Sui coin and follows SUI; I had guessed six and
          the old page divides by 1e9. Guessing a decimal count is a wrong NUMBER rather than a
          wrong format, which is the kind of thing nobody notices until it matters. */}
      <Figure label="CETUS" value={fromUnits(state.cetus, 9)} />
    </div>
  );
}
