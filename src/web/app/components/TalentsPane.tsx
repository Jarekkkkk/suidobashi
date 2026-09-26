import { useState, useEffect, useCallback } from 'react';
import { Trash2, Check, ChevronDown } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/*
 * The marketplace, and what is installed.
 *
 * TWO SECTIONS, AND BOTH FOLD. The pattern is the one the "add by address" bar used before it was
 * removed: a chevron that turns and a body below it. Two groups is what there is — what this machine
 * has, and what it could take — and folding is how a pane with two lists stays readable when one of
 * them is long.
 *
 * THE AXIS IS "INSTALLED OR NOT", which is a different split from the one that was wrong here
 * before. The earlier mistake was separating a talent's TWO SIDES — your half from the server's half
 * — and a protocol is only readable with both in view. A talent still shows both halves in one card;
 * the sections divide the LIST, not the protocol.
 *
 * Show a section's heading even when it is empty, with a line saying so: a heading that disappears
 * when its section empties reads as a bug, and "everything here is installed" is worth knowing.
 *
 * ONE TO ONE. A talent is how the agent talks to a server: installing it means "I can do this, by
 * asking that". There is no talent without a server and no server reached without a talent.
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

/**
 * A foldable group.
 *
 * The whole header is the button, so the target is the width of the pane rather than a 12px chevron,
 * and the count rides at the right of it. The body is REMOVED rather than hidden when folded, so a
 * collapsed section costs nothing to lay out.
 */
function Section({ label, count, open, onToggle, empty, children }: {
  label: string; count: number; open: boolean; onToggle: () => void;
  empty: string; children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 border-b border-border px-2.5 py-1.5 text-left transition-colors hover:bg-accent/50"
      >
        <ChevronDown
          size={12}
          className={cn(
            'shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">{count}</span>
      </button>
      {open && (
        <div className="animate-rise-in p-2.5">
          {count === 0
            ? <p className="text-[11px] leading-relaxed text-muted-foreground">{empty}</p>
            : <ul className="flex flex-col gap-2">{children}</ul>}
        </div>
      )}
    </section>
  );
}

/**
 * One talent, both of its halves.
 *
 * `on` is passed in rather than derived here, because the CALLER already knows it — the card is
 * rendered from one of two lists, and deriving it again would be a second opinion about which list
 * it came from.
 */
function TalentCard({ t, on, busy, manifest, onInstall, onRemove }: {
  t: Entry; on: boolean; busy: string | null; manifest: Manifest | undefined;
  onInstall: () => void; onRemove: () => void;
}) {
  const theirs = manifest?.actions ?? [];
  const version = manifest?.strategy?.version;

  return (
    <li
      className={cn(
        'rounded-lg border p-2.5 transition-colors',
        on ? 'border-brand/40 bg-brand-soft/40' : 'border-border bg-card',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t.name}</span>
        {version && (
          <span className="shrink-0 text-[10px] text-muted-foreground">v{version}</span>
        )}
        {on ? (
          <>
            <Check size={13} className="shrink-0 text-brand" />
            <Button size="icon" variant="ghost" className="h-6 w-6"
              disabled={busy === t.id} title="remove" aria-label={`remove ${t.name}`}
              onClick={onRemove}>
              <Trash2 size={12} />
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]"
            disabled={busy === t.id} onClick={onInstall}>
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
            <span className="w-[68px] shrink-0 text-right text-[10px] uppercase tracking-wide text-muted-foreground">
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
        {/* The server's half only exists once its manifest has been fetched, which is what
            installing does — so an uninstalled talent has nothing to show here yet. */}
        {on && theirs.map((a) => (
          <div key={a.id} className="flex items-baseline gap-2">
            <span className="w-[68px] shrink-0 text-right text-[10px] uppercase tracking-wide text-muted-foreground">
              the server
            </span>
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {a.id}
            </span>
            <span className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">
              {a.title ?? a.id}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-1.5 break-all font-mono text-[10px] text-muted-foreground">
        {t.server}
      </div>
    </li>
  );
}

export function TalentsPane() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [installedIds, setInstalledIds] = useState<string[]>([]);
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Both open to begin with: folding is for getting a long list out of the way, not for hiding the
  // pane's contents from somebody who has just opened it.
  const [openInstalled, setOpenInstalled] = useState(true);
  const [openMarketplace, setOpenMarketplace] = useState(true);

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
      // A SUCCESSFUL INSTALL SAYS NOTHING. The card moves from marketplace to installed, and that IS
      // the feedback — a line of text restating it just sits at the top of the list ("installed
      // query") until the next action. A FAILURE changes nothing visible, so that one still speaks.
      if (!r.ok) setNote(r.why ?? 'could not install it');
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

  const storedManifest = (id: string) => installed.find((t) => t.id === id)?.manifest;

  const isOn = (id: string) => installedIds.includes(id);
  const installedEntries = entries.filter((t) => isOn(t.id));
  const availableEntries = entries.filter((t) => !isOn(t.id));

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* Install and remove report HERE, at the top of the list they changed. It used to live
            under the add-by-address field, which is gone. */}
        {note && (
          <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">{note}</p>
        )}

        {/* The registry has nothing in it at all — a different fact from "everything in it is
            installed", which is the note inside the marketplace section. */}
        {loaded && entries.length === 0 && (
          <div className="mb-3 rounded-lg border border-dashed border-border px-3 py-6 text-center">
            <p className="text-[12px] text-muted-foreground">The marketplace is empty.</p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          <Section
            label="installed"
            count={installedEntries.length}
            open={openInstalled}
            onToggle={() => setOpenInstalled((v) => !v)}
            empty="nothing installed yet — take one from the marketplace"
          >
            {installedEntries.map((t) => (
              <TalentCard
                key={t.id} t={t} on busy={busy}
                manifest={storedManifest(t.id)}
                onInstall={() => void install(t.id)}
                onRemove={() => void remove(t.id)}
              />
            ))}
          </Section>

          <Section
            label="marketplace"
            count={availableEntries.length}
            open={openMarketplace}
            onToggle={() => setOpenMarketplace((v) => !v)}
            empty="everything in the marketplace is installed"
          >
            {availableEntries.map((t) => (
              <TalentCard
                key={t.id} t={t} on={false} busy={busy}
                manifest={storedManifest(t.id)}
                onInstall={() => void install(t.id)}
                onRemove={() => void remove(t.id)}
              />
            ))}
          </Section>
        </div>
      </div>
    </div>
  );
}
