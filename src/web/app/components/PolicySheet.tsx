import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { suiToMist } from '../../units';

/**
 * The whole policy, in one place, saved in one transaction.
 *
 * Before this, each boundary was its own form with its own button and its own signature: set
 * budget, swap pool, hand the grant on, suspend or resume. Four forms is four signatures, and
 * five chances for the policy to end up in a state nobody chose — the suspension lands, the venue
 * change is refused, and what is on chain is half of what was asked for.
 *
 * So the sheet collects the WHOLE desired state and sends only the DIFFERENCE. That is what the
 * route was built for, and the budget is why it matters: `set_allowance` upserts the ledger entry
 * in place, including resetting the spend tracking, so sending it on every save would quietly
 * restore an exhausted hire's ceiling every time the owner changed a venue.
 *
 * A field left alone produces no instruction at all. Absent means unchanged, never default —
 * which is also why the fields start at the chain's values rather than at empty.
 */
export type PolicyHire = {
  name: string;
  policyId: string;
  budgetSui?: string;
  agent?: string;
  suspended?: boolean;
  venueIds?: string[];
  destination?: string;
  error?: string;
};

type Run = (kind: string, body: Record<string, unknown>) => Promise<void>;

export function PolicySheet({
  hire,
  onClose,
  busy,
  run,
}: {
  hire: PolicyHire;
  onClose: () => void;
  busy: boolean;
  run: Run;
}) {
  // What the chain says, kept as the baseline. The diff is computed against THIS, not against
  // the last thing typed, so re-typing a value back to its original produces no instruction.
  const original = {
    agent: hire.agent ?? '',
    budgetSui: hire.budgetSui ?? '',
    suspended: Boolean(hire.suspended),
    venues: (hire.venueIds ?? []).map((v) => v.toLowerCase()),
  };

  const [agent, setAgent] = useState(original.agent);
  const [budgetSui, setBudgetSui] = useState(original.budgetSui);
  const [suspended, setSuspended] = useState(original.suspended);
  const [venues, setVenues] = useState<string[]>(original.venues);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // Escape closes it, because a sheet you cannot back out of is a trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const allow = venues.filter((v) => !original.venues.includes(v));
  const revoke = original.venues.filter((v) => !venues.includes(v));
  const budgetChanged = budgetSui.trim() !== original.budgetSui.trim();
  const agentChanged = agent.trim().toLowerCase() !== original.agent.toLowerCase();
  const suspendedChanged = suspended !== original.suspended;
  const changed = allow.length + revoke.length + Number(budgetChanged) + Number(agentChanged) + Number(suspendedChanged);

  async function save() {
    setErr(null);
    if (!changed) return onClose();

    const body: Record<string, unknown> = { hire: hire.name };
    if (agentChanged) body.agent = agent.trim();
    // The bound travels with the agent, in the same transaction. A grant handed over without a
    // price bound — even for one instruction — is the case the bound exists for.
    if (agentChanged) body.boundBps = '5';
    if (budgetChanged) {
      const mist = suiToMist(budgetSui.trim());
      if (mist === null) return setErr(`"${budgetSui.trim()}" is not a plain decimal with at most 9 places`);
      body.budgetMist = mist;
    }
    if (suspendedChanged) body.suspended = suspended;
    if (allow.length) body.allowPools = allow;
    if (revoke.length) body.revokePools = revoke;

    try {
      await run('policy', body);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function addVenue() {
    const v = draft.trim();
    if (!v) return;
    if (venues.includes(v.toLowerCase())) return setDraft('');
    setVenues([...venues, v.toLowerCase()]);
    setDraft('');
  }

  const short = (a: string) => (a.length > 14 ? `${a.slice(0, 10)}…${a.slice(-4)}` : a);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-full max-w-md flex-col overflow-hidden rounded-t-xl border border-border bg-card shadow-xl sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="text-[13px] font-medium">policy</div>
            <div className="font-mono text-[10px] text-muted-foreground">{short(hire.policyId)}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>close</Button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          {hire.error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              the chain read failed: {hire.error}
            </p>
          )}

          <Field
            label="agent"
            hint="who may spend. changing this hands over the ledger entry too — the budget is keyed by the cap, not the address."
          >
            <input
              className={inputCls}
              value={agent}
              placeholder="0x…"
              onChange={(e) => setAgent(e.target.value)}
            />
          </Field>

          <Field
            label="budget"
            hint="read from the OpenZeppelin ledger, and it is what is LEFT, not what was granted — the contract stores only the remaining figure, so the original grant is not recoverable. typing a new number sets it and resets the spent counter."
          >
            <div className="flex items-center gap-2">
              <input
                className={cn(inputCls, 'flex-1')}
                value={budgetSui}
                placeholder="0.03"
                onChange={(e) => setBudgetSui(e.target.value)}
              />
              <span className="text-[11px] text-muted-foreground">SUI</span>
            </div>
          </Field>

          <Field
            label="allowed_shared_objects"
            hint="the one object id the agent supplies. every other shared object in a swap — the policy, the vault, the config, the clock — is fixed in the code; this one arrives from the request, so it has to be approved here. empty means the agent can trade nowhere."
          >
            <div className="flex flex-col gap-1.5">
              {venues.map((v) => (
                <div key={v} className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
                  <span className="flex-1 truncate font-mono text-[11px]">{v}</span>
                  <button
                    className="text-[11px] text-muted-foreground hover:text-destructive"
                    onClick={() => setVenues(venues.filter((x) => x !== v))}
                  >
                    remove
                  </button>
                </div>
              ))}
              {venues.length === 0 && (
                <p className="px-1 text-[11px] text-muted-foreground/60">no venue approved</p>
              )}
              <div className="flex items-center gap-1.5">
                <input
                  className={cn(inputCls, 'flex-1')}
                  value={draft}
                  placeholder="0x…"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addVenue(); }}
                />
                <Button variant="outline" size="sm" onClick={addVenue} disabled={!draft.trim()}>add</Button>
              </div>
            </div>
          </Field>

          <Field label="suspended" hint="the kill switch. stops the agent without touching its budget or its allowed objects.">            <button
              className={cn(
                'rounded-md border px-3 py-1.5 text-[12px] transition-colors',
                suspended
                  ? 'border-destructive/50 bg-destructive/10 text-destructive'
                  : 'border-border bg-background text-muted-foreground',
              )}
              onClick={() => setSuspended(!suspended)}
            >
              {suspended ? 'suspended — click to resume' : 'active — click to suspend'}
            </button>
          </Field>

          {/* What saving would actually do. The sheet's whole premise is that the diff is the
              transaction, so showing the diff is showing the transaction. */}
          <div className="rounded-md border border-border bg-background px-2.5 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">will send</div>
            <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground">
              {agentChanged && <li>· set agent {short(agent.trim())} (bound 5 bps)</li>}
              {budgetChanged && <li>· set budget {budgetSui.trim()} SUI</li>}
              {allow.map((v) => <li key={v}>· allow {short(v)}</li>)}
              {revoke.map((v) => <li key={v}>· revoke {short(v)}</li>)}
              {suspendedChanged && <li>· {suspended ? 'suspend' : 'resume'}</li>}
              {!changed && <li>· nothing — one transaction, no changes</li>}
            </ul>
          </div>

          {err && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              {err}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <span className="text-[11px] text-muted-foreground">
            {changed ? `${changed} change${changed === 1 ? '' : 's'} · one signature` : 'no changes'}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>cancel</Button>
            <Button size="sm" onClick={save} disabled={busy || !changed}>
              {busy ? 'signing…' : 'save'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground/50 focus-visible:border-ring';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
      {hint && <p className="text-[10px] leading-relaxed text-muted-foreground/60">{hint}</p>}
    </div>
  );
}
