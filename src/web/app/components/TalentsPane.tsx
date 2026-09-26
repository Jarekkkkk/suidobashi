import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Check, ChevronDown } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/*
 * The marketplace, and what is installed.
 *
 * A TALENT IS A CAPABILITY. Installing one is what tells a stateless model it can do something —
 * remove it and the agent stops offering it, which is the whole design rather than a side effect.
 *
 * GROUPED BY SIDE, NOT BY KIND. A talent called `sui-tokyo-swap` that provides `fill` is a
 * reasonable thing to install and then ask to swap with, and the mistake is easy to make because
 * the name reads like the verb you want. The grouping says it before the name does:
 *
 *   maker    you create the intent; something else fills it
 *   filler   you take intents someone else created
 *
 * INSTALLED STATE COMES FROM THE LIST, not from a stored copy of the name. The database holds
 * which ids are in; everything shown about them — the name, what they do, which side — is read
 * from the marketplace, so renaming an entry renames it everywhere rather than leaving a stale
 * copy in a row.
 */

type Action = { id: string; title: string };
type Entry = {
  id: string;
  name: string;
  kind: 'local' | 'remote';
  description: string;
  actions: Action[];
  url?: string;
};

/** Somewhere that fills a role. Not a talent: registering one does not make the agent able. */
type Service = { id: string; name: string; role: string; url: string; description: string };

const KIND_LABEL: Record<Entry['kind'], string> = {
  local: 'your agent can do',
  remote: 'connects to a service',
};

const KIND_NOTE: Record<Entry['kind'], string> = {
  local: 'Performed by the app itself. No service, no address.',
  remote: 'A connector. Its actions are yours; the work happens at the service.',
};

export function TalentsPane() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [installed, setInstalled] = useState<string[]>([]);
  const [known, setKnown] = useState<Service[]>([]);
  const [registered, setRegistered] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [byAddress, setByAddress] = useState(false);
  const [address, setAddress] = useState('');

  const load = useCallback(async () => {
    try {
      const [t, sv] = await Promise.all([
        api<{ marketplace: Entry[]; installedIds: string[] }>('/api/talents'),
        api<{ known: Service[]; registered: { id: string }[] }>('/api/services'),
      ]);
      setEntries(t.marketplace ?? []);
      setInstalled(t.installedIds ?? []);
      setKnown(sv.known ?? []);
      setRegistered((sv.registered ?? []).map((x) => x.id));
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

  async function registerService(id: string) {
    setBusy(id);
    try {
      await api('/api/services', { id });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function unregisterService(id: string) {
    setBusy(id);
    try {
      await api(`/api/services/${encodeURIComponent(id)}`, undefined, 'DELETE');
      await load();
    } finally {
      setBusy(null);
    }
  }

  const isInstalled = (id: string) => installed.includes(id);
  const kinds: Entry['kind'][] = ['local', 'remote'];

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

        {kinds.map((kind) => {
          const group = entries.filter((e) => e.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind} className="mb-5 last:mb-0">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {KIND_LABEL[kind]}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/60">
                {KIND_NOTE[kind]}
              </p>

              <ul className="mt-2.5 flex flex-col gap-2">
                {group.map((t) => {
                  const on = isInstalled(t.id);
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
                        {on ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            disabled={busy === t.id}
                            title="remove"
                            aria-label={`remove ${t.name}`}
                            onClick={() => void remove(t.id)}
                          >
                            <Trash2 size={12} />
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 shrink-0 px-2 text-[11px]"
                            disabled={busy === t.id}
                            onClick={() => void install(t.id)}
                          >
                            install
                          </Button>
                        )}
                        {on && <Check size={13} className="shrink-0 text-brand" />}
                      </div>

                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                        {t.description}
                      </p>

                      {/* What it actually provides. The honest answer to "what does this give
                          me", and more useful than any description. */}
                      <ul className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
                        {t.actions.map((a) => (
                          <li key={a.id} className="flex items-baseline gap-2">
                            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                              {a.id}
                            </span>
                            <span className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
                              {a.title}
                            </span>
                          </li>
                        ))}
                      </ul>

                      {t.kind === 'remote' && (
                        <div className="mt-1.5 break-all font-mono text-[10px] text-muted-foreground/50">
                          {t.url}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}

        {/* SERVICES, NOT TALENTS. Registering one does not make the agent able to do anything —
            it says who it asks. They were one list, which is why installing a filler looked like
            gaining the ability to fill. */}
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            services
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/60">
            Who fills a role. Registering one does not give your agent a new ability — it says
            who to ask. Without one, an order simply expires.
          </p>

          <ul className="mt-2.5 flex flex-col gap-2">
            {known.map((sv) => {
              const on = registered.includes(sv.id);
              return (
                <li
                  key={sv.id}
                  className={cn(
                    'rounded-lg border p-2.5 transition-colors',
                    on ? 'border-brand/40 bg-brand-soft/40' : 'border-border bg-card',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{sv.name}</span>
                    <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {sv.role}
                    </span>
                    {on ? (
                      <Button size="icon" variant="ghost" className="h-6 w-6"
                        disabled={busy === sv.id} title="unregister"
                        aria-label={`unregister ${sv.name}`}
                        onClick={() => void unregisterService(sv.id)}>
                        <Trash2 size={12} />
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]"
                        disabled={busy === sv.id}
                        onClick={() => void registerService(sv.id)}>
                        register
                      </Button>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {sv.description}
                  </p>
                  <div className="mt-1.5 break-all font-mono text-[10px] text-muted-foreground/50">
                    {sv.url}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
