import { useState, useEffect, useCallback } from 'react';
import { Play, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

/*
 * The live DeepBook guard: what it is holding, what it is allowed to do, and a button that does one
 * pass of the operator against it.
 *
 * THE PAGE DOES NOT READ THE CHAIN ITSELF. It calls the server, which runs `src/run-grid.ts` — the
 * same program a person would run by hand — and returns what that program printed. That is slower
 * and it cannot disagree with reality, which matters more here than speed: the first version of a
 * reader would have shown the account as EMPTY, because a BalanceManager's balances live in dynamic
 * fields and no plain object read sees them. A page whose whole job is to say what a pass would do
 * should not have its own opinion about what a pass would do.
 *
 * A pass is printed as it prints: an ordered list of JSON steps. The fields differ between a pass
 * that planned something, one that refused, and one that executed — so each is rendered when
 * present, and the raw step is available underneath for anything not yet given a nicer face.
 */

/** The runner's own output, as the server relays it. Shape varies by step, deliberately. */
type Step = {
  mode?: string;
  step?: string;
  refused?: string;
  would?: { cancel: number; place: number };
  levels?: string[];
  ok?: boolean;
  status?: { success?: boolean; error?: unknown };
  funds?: { sui: string; usdc: string };
  guard?: { paused?: boolean; committed?: string; budget?: string };
  book?: { bestBid: string; bestAsk: string };
  resting?: number;
  committed?: string;
  digest?: string | null;
  placed?: number;
  cancelled?: number;
  key?: string;
  hint?: string;
  note?: string;
};

type Relay = {
  configured: boolean;
  reason?: string;
  ran?: boolean;
  steps?: Step[];
  status?: number | null;
  stderr?: string | null;
};

/** Raw units to a readable number. SUI and USDC both arrive as strings of base units. */
function coins(raw: string | undefined, decimals: number): string {
  if (raw === undefined) return '—';
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function GuardPane() {
  const [relay, setRelay] = useState<Relay | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    setBusy(true);
    setFailed(null);
    try {
      setRelay(await api<Relay>(path, path.endsWith('/run') ? {} : undefined));
    } catch (e) {
      setFailed(String(e && typeof e === 'object' && 'message' in e ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load('/api/guard');
  }, [load]);

  if (failed) return <p className="p-3 text-[11px] text-destructive">{failed}</p>;
  if (!relay) return <p className="p-3 text-[11px] text-muted-foreground">Reading the guard…</p>;

  if (!relay.configured) {
    return (
      <p className="p-3 text-[11px] leading-relaxed text-muted-foreground">
        {relay.reason ?? 'No guard is configured.'}
      </p>
    );
  }

  const steps = relay.steps ?? [];
  // The state is whichever step reported funds; a plan, a refusal and an outcome all carry it.
  const state = steps.find((s) => s.funds) ?? null;
  const last = steps.at(-1) ?? null;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void load('/api/guard')}>
          <RefreshCw size={12} className="mr-1" /> Refresh
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void load('/api/guard/run')}>
          <Play size={12} className="mr-1" /> Run a pass
        </Button>
      </div>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        A pass reads the book, plans one ladder level and submits it. It is signed by the seat holder
        — the same program a person runs by hand, so the button cannot do anything the command line
        could not.
      </p>

      {/* The account's figures are deliberately NOT drawn here. They are a talent action —
          `grid.status` on the mcp-server, and `/api/guard` for this page — so an agent fetches the
          same numbers the maker would be reading, and there is one answer rather than two. A pane
          that reads the chain itself is a second implementation, and this one already disagreed
          with the pool: the BalanceManager read zero while the pool held 1.16 USDC owed to the same
          account. The honest place for that number is the action, not this card. */}
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        The account's balances and the guard's limits are read through the <code>grid.status</code>{' '}
        action — the same one an agent calls — and are not drawn here. One answer, not two.
      </p>

      {state?.book && (
        <Section label="the book">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
            <Term label="bid" value={coins(state.book.bestBid, 6)} />
            <Term label="ask" value={coins(state.book.bestAsk, 6)} />
          </dl>
        </Section>
      )}

      <Section label={relay.ran ? 'what just happened' : 'what a pass would do'}>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-2 text-[10px] leading-relaxed">
          {JSON.stringify(steps, null, 2)}
        </pre>
      </Section>

      {relay.stderr && (
        <p className="text-[10px] leading-relaxed text-destructive">{relay.stderr}</p>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border">
      <p className="border-b border-border px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="p-2.5">{children}</div>
    </section>
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
