import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Check, ChevronDown } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/*
 * The marketplace, and what is installed.
 *
 * ONE TO ONE. A talent is how the agent talks to a server: installing it means "I can do this, by
 * asking that". There is no talent without a server and no server reached without a talent, so
 * there is one list rather than two — and the earlier attempt to split them came from a mistake
 * this pane is now built to make visible.
 *
 * A TALENT HAS TWO SIDES, and showing them as two is the point:
 *
 *   you can        YOUR half. Declared by the talent, because the server does not know it exists.
 *   the server     THEIR half. Read from its manifest.
 *
 * The reference filler's manifest declares `fill`. Offering that as something the AGENT could do
 * is how it came to claim "I can do these: fill" for a capability with someone else's key and
 * someone else's risk. The rule is one line: a manifest is what the SERVER does, never the agent.
 */

type Action = { id: string; title?: string };
type Entry = {
  id: string;
  name: string;
  server: string;
  description: string;
  /** YOUR side. */
  actions: Action[];
};
type Manifest = { strategy?: { id?: string; version?: string }; actions?: Action[] };
type Installed = { id: string; name: string; manifest: Manifest };

export function TalentsPane() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [installedIds, setInstalledIds] = useState<string[]>([]);
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [byAddress, setByAddress] = useState(false);
  const [address, setAddress] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ marketplace: Entry[]; installedIds: string[]; installed: Installed[] }>(
        '/api/talents',
      );
      setEntries(r.marketplace ?? []);
      setInstalledIds(r.installedIds ?? []);
      setInstalled(r.installed ?? []);
    } catch {
      setEntries([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function install(id: string) {
    setBusy(id);
    setNote(null);
    try {
      const r = await api<{ ok?: boolean; name?: string; why?: string }>('/api/talents', { id });
      setNote(r.ok ? `installed ${r.name}` : (r.why ?? 'could not install it'));
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await api(`/api/talents/${encodeURIComponent(id)}`, undefined, 'DELETE');
      await load();
    } finally {
      setBusy(null);
    }
  }

  /** Anything not in the list, by its address. Behind a disclosure: the list is the way in. */
  async function installByAddress() {
    const target = address.trim();
    if (!target) return;
    setBusy('address');
    setNote(null);
    try {
      const r = await api<{ ok?: boolean; name?: string; why?: string }>('/api/talents', { url: target });
      setNote(r.ok ? `installed ${r.name}` : (r.why ?? 'could not install it'));
      await load();
    } finally {
      setBusy(null);
    }
  }

  const storedManifest = (id: string) => installed.find((t) => t.id === id)?.manifest;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border p-2">
        <button
          onClick={() => setByAddress((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown size={12} className={cn('transition-transform', byAddress && 'rotate-180')} />
          add by address
        </button>
        {byAddress && (
          <div className="animate-rise-in mt-1.5 flex items-center gap-1.5">
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void installByAddress(); }}
              placeholder="http://127.0.0.1:8790"
              spellCheck={false}
              className={cn(
                'min-w-0 flex-1 rounded-sm border border-input bg-background px-2 py-1.5',
                'font-mono text-[11px] outline-none placeholder:text-muted-foreground/40',
                'focus:border-brand/60',
              )}
            />
            <Button size="icon" variant="ghost" disabled={busy !== null || !address.trim()}
              onClick={() => void installByAddress()} aria-label="install by address" title="install">
              <Plus size={14} />
            </Button>
          </div>
        )}
        {note && <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{note}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loaded && entries.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
            <p className="text-[12px] text-muted-foreground">The marketplace is empty.</p>
          </div>
        )}

        <ul className="flex flex-col gap-2">
          {entries.map((t) => {
            const on = installedIds.includes(t.id);
            const manifest = storedManifest(t.id);
            const theirs = manifest?.actions ?? [];
            const version = manifest?.strategy?.version;

            return (
              <li
                key={t.id}
                className={cn(
                  'rounded-lg border p-2.5 transition-colors',
                  on ? 'border-brand/40 bg-brand-soft/40' : 'border-border bg-card',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t.name}</span>
                  {version && (
                    <span className="shrink-0 text-[10px] text-muted-foreground/60">v{version}</span>
                  )}
                  {on ? (
                    <>
                      <Check size={13} className="shrink-0 text-brand" />
                      <Button size="icon" variant="ghost" className="h-6 w-6"
                        disabled={busy === t.id} title="remove" aria-label={`remove ${t.name}`}
                        onClick={() => void remove(t.id)}>
                        <Trash2 size={12} />
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]"
                      disabled={busy === t.id} onClick={() => void install(t.id)}>
                      install
                    </Button>
                  )}
                </div>

                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {t.description}
                </p>

                {/* BOTH HALVES, labelled. The distinction the agent depends on, made visible:
                    it is told about the first and never the second. */}
                <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
                  {t.actions.map((a) => (
                    <div key={a.id} className="flex items-baseline gap-2">
                      <span className="w-[68px] shrink-0 text-right text-[10px] uppercase tracking-wide text-muted-foreground/60">
                        you can
                      </span>
                      <span className="shrink-0 rounded-sm bg-brand-soft px-1.5 py-0.5 font-mono text-[10px] text-brand">
                        {a.id}
                      </span>
                      <span className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
                        {a.title}
                      </span>
                    </div>
                  ))}
                  {on && theirs.map((a) => (
                    <div key={a.id} className="flex items-baseline gap-2">
                      <span className="w-[68px] shrink-0 text-right text-[10px] uppercase tracking-wide text-muted-foreground/60">
                        the server
                      </span>
                      <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {a.id}
                      </span>
                      <span className="min-w-0 text-[11px] leading-relaxed text-muted-foreground/70">
                        {a.title ?? a.id}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="mt-1.5 break-all font-mono text-[10px] text-muted-foreground/50">
                  {t.server}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
