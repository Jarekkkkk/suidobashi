import { useState, useEffect, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/*
 * The conversations.
 *
 * The model is STATELESS, so history is ours to keep — it is the only thing that makes a chat a
 * chat rather than a series of unrelated requests. It lives in SQLite rather than in the browser
 * so it survives a reload, a different browser, and the app being restarted.
 *
 * A chat is not bound to a talent. One conversation can use several — a swap and a lookup in the
 * same thread — and which are equipped is the next step rather than a property of this list.
 */

type Chat = { id: string; title: string; createdAt: number; updatedAt: number };

/** "2m ago", because an absolute timestamp in a list is harder to scan than a distance. */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function ChatsPane({
  current,
  onSelect,
  onNew,
}: {
  current: string | null;
  onSelect: (id: string) => void;
  onNew: (id: string) => void;
}) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ chats: Chat[] }>('/api/chats');
      setChats(r.chats);
    } catch {
      setChats([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      const c = await api<Chat>('/api/chats', { title: 'new chat' });
      await load();
      onNew(c.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* NO "chats" LABEL HERE — the tab above already says it, and a heading that repeats the
          tab is the same word twice on one screen. The bar exists only to hold the button, so it
          is as thin as that allows. */}
      <div className="flex shrink-0 items-center border-b border-border px-2 py-1.5">
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto"
          disabled={busy}
          onClick={() => void create()}
          aria-label="new chat"
          title="new chat"
        >
          <Plus size={14} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {chats !== null && chats.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
            <p className="text-[12px] text-muted-foreground">No conversations yet.</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/60">
              A chat keeps its own history, so the model can be given it back.
            </p>
          </div>
        )}

        <ul className="flex flex-col gap-1">
          {(chats ?? []).map((c) => (
            <li key={c.id}>
              <button
                onClick={() => onSelect(c.id)}
                className={cn(
                  'w-full rounded-md px-2.5 py-2 text-left transition-colors',
                  c.id === current
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground',
                )}
              >
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px]">{c.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/60">
                    {ago(c.updatedAt)}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
