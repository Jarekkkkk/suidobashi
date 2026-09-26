import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Package, Boxes } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/*
 * Installed talents.
 *
 * A TALENT IS A CAPABILITY, served by an MCP server. Installing means fetching what that server
 * exposes and keeping it locally, so the local model can be equipped with it — the model is
 * stateless, so what it can do has to come from somewhere, and this is that somewhere.
 *
 * WHAT IS NOT HERE: grants. A talent that SPENDS needs an on-chain permission as well, and that
 * is a separate act with its own signature — one is a download, the other is a permission. The
 * grants live in the tab beside this one, and keeping the two apart is the whole reason neither
 * is called "hire" any more.
 */

type Action = { id: string; title?: string; description?: string };
type Manifest = { strategy?: { id?: string; version?: string }; actions?: Action[] };
type Talent = { id: string; name: string; manifest: Manifest; installedAt: number };
type BuiltIn = { id: string; name: string; actions: Action[] };

/** The default a person will actually want, so the field is not empty on first use. */
const DEFAULT_URL = 'http://127.0.0.1:8790';

export function TalentsPane() {
  const [talents, setTalents] = useState<Talent[] | null>(null);
  const [builtIn, setBuiltIn] = useState<BuiltIn[]>([]);
  const [url, setUrl] = useState(DEFAULT_URL);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ talents: Talent[]; builtIn: BuiltIn[] }>('/api/talents');
      setTalents(r.talents);
      setBuiltIn(r.builtIn ?? []);
    } catch {
      setTalents([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function install() {
    const target = url.trim();
    if (!target || busy) return;
    setBusy(true);
    setNote(null);
    try {
      // The SERVER fetches the manifest, not this page: an MCP server sends no CORS headers, so
      // a browser fetch of /metadata would fail on a cross-origin request.
      const r = await api<{ ok?: boolean; name?: string; why?: string }>('/api/talents', { url: target });
      if (r.ok) {
        setNote(`installed ${r.name}`);
        await load();
      } else {
        setNote(r.why ?? 'could not install it');
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function uninstall(id: string) {
    await api(`/api/talents/${encodeURIComponent(id)}`, undefined, 'DELETE');
    await load();
  }

  const installed = talents ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* Adding one. The URL rather than a name, because the address is what the server has to
          reach and a name is what the manifest supplies once it does. */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-2">
        <div className="flex items-center gap-1.5">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void install(); }}
            placeholder="http://127.0.0.1:8790"
            spellCheck={false}
            className={cn(
              'min-w-0 flex-1 rounded-sm border border-input bg-background px-2 py-1.5',
              'font-mono text-[11px] text-foreground outline-none',
              'placeholder:text-muted-foreground/40 focus:border-brand/60',
            )}
          />
          <Button
            size="icon"
            variant="ghost"
            disabled={busy || !url.trim()}
            onClick={() => void install()}
            aria-label="install talent"
            title="install talent"
          >
            <Plus size={14} />
          </Button>
        </div>
        {note && (
          <p className="px-0.5 text-[11px] leading-relaxed text-muted-foreground">{note}</p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* WHAT THE AGENT CAN ALWAYS DO. These ship with the app, need no address, and cannot
            fail to be reachable — which is why they come first and why they are marked. */}
        {builtIn.length > 0 && (
          <div className="mb-4">
            <div className="px-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              built in
            </div>
            <ul className="mt-2 flex flex-col gap-2">
              {builtIn.map((t) => (
                <li key={t.id} className="rounded-lg border border-border bg-card p-2.5">
                  <div className="flex items-center gap-2">
                    <Boxes size={13} className="shrink-0 text-muted-foreground" />
                    <span className="text-[13px] font-medium">{t.name}</span>
                  </div>
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
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="px-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          installed over mcp
        </div>

        {talents !== null && installed.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
            <p className="text-[12px] text-muted-foreground">Nothing installed.</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/60">
              A talent is a capability served over MCP. Installing keeps what it exposes so the
              local model can be equipped with it.
            </p>
          </div>
        )}

        <ul className="flex flex-col gap-2">
          {installed.map((t) => {
            const actions = t.manifest?.actions ?? [];
            const version = t.manifest?.strategy?.version;
            return (
              <li key={t.id} className="group rounded-lg border border-border bg-card p-2.5">
                <div className="flex items-center gap-2">
                  <Package size={13} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t.name}</span>
                  {version && (
                    <span className="shrink-0 text-[10px] text-muted-foreground/60">v{version}</span>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    title="uninstall"
                    aria-label={`uninstall ${t.name}`}
                    onClick={() => void uninstall(t.id)}
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>

                <div className="mt-1.5 break-all font-mono text-[10px] text-muted-foreground/60">
                  {t.id}
                </div>

                {/* What it can actually do. The manifest's actions are the honest answer to
                    "what does this talent give me" — more useful than a description. */}
                {actions.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
                    {actions.map((a) => (
                      <li key={a.id} className="flex items-baseline gap-2">
                        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {a.id}
                        </span>
                        <span className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
                          {a.title ?? a.description ?? ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
