import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
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
  onDeleted,
}: {
  current: string | null;
  onSelect: (id: string) => void;
  onNew: (id: string) => void;
  /** Called when the OPEN chat was the one deleted, so the app can move somewhere real. */
  onDeleted: () => void;
}) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** The row whose delete is one click from happening. Not a browser confirm: this is a list,
      and the second click is the confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ chats: Chat[] }>('/api/chats');
      setChats(r.chats);
    } catch {
      setChats([]);
    }
  }, []);

  // `current` is a dependency, not just `load`: on mount the app creates a chat if there are
  // none, and that happens AFTER this list has loaded. Without it the list showed empty,
  // and the next click on + made a second chat — which is exactly the bug reported.
  useEffect(() => { void load(); }, [load, current]);

  // Focus the field the moment it appears, so renaming is one click and typing rather than
  // click, find, click.
  useEffect(() => {
    if (editing) editRef.current?.select();
  }, [editing]);

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

  async function saveTitle(id: string) {
    const title = draft.trim();
    setEditing(null);
    // Nothing to do if it is unchanged or empty. The server refuses an empty one too; not
    // sending it saves a round trip that could only fail.
    if (!title) return;
    const existing = chats?.find((c) => c.id === id);
    if (existing?.title === title) return;
    await api(`/api/chats/${id}`, { title }, 'PATCH');
    await load();
  }

  async function remove(id: string) {
    setConfirming(null);
    await api(`/api/chats/${id}`, undefined, 'DELETE');
    await load();
    // If that was the open chat, the transcript on screen is gone. Say so, and let the app pick
    // another rather than leaving the user typing into a conversation that no longer exists.
    if (id === current) onDeleted();
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
          {(chats ?? []).map((c) => {
            const isCurrent = c.id === current;
            const isEditing = editing === c.id;
            const isConfirming = confirming === c.id;

            return (
              <li key={c.id} className="group relative">
                {isEditing ? (
                  <input
                    ref={editRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => void saveTitle(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveTitle(c.id);
                      // Escape abandons the edit, which is what Escape means everywhere else.
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    maxLength={80}
                    className={cn(
                      'w-full rounded-md border border-brand/60 bg-background px-2.5 py-2',
                      'text-[12px] text-foreground outline-none',
                    )}
                  />
                ) : (
                  <button
                    onClick={() => onSelect(c.id)}
                    onDoubleClick={() => { setDraft(c.title); setEditing(c.id); }}
                    className={cn(
                      'w-full rounded-md px-2.5 py-2 text-left transition-colors',
                      isCurrent
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px]">{c.title}</span>
                      <span className={cn(
                        'shrink-0 text-[10px] text-muted-foreground/60',
                        // The actions replace the timestamp on hover, so the row does not grow.
                        'group-hover:opacity-0',
                      )}>
                        {ago(c.updatedAt)}
                      </span>
                    </div>
                  </button>
                )}

                {/* Hover actions. `opacity-0 group-hover:opacity-100` rather than conditionally
                    rendering, so the row never changes size under the cursor. */}
                {!isEditing && (
                  <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      title="rename"
                      aria-label={`rename ${c.title}`}
                      onClick={() => { setDraft(c.title); setEditing(c.id); }}
                    >
                      <Pencil size={12} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      title={isConfirming ? 'click again to delete' : 'delete'}
                      aria-label={`delete ${c.title}`}
                      onClick={() => (isConfirming ? void remove(c.id) : setConfirming(c.id))}
                    >
                      <Trash2 size={12} className={cn(isConfirming && 'text-destructive')} />
                    </Button>
                  </div>
                )}

                {/* The second click. Overlays the row rather than replacing it, so the target
                    does not move between the two clicks. */}
                {isConfirming && (
                  <div className="absolute inset-0 flex items-center justify-between rounded-md bg-destructive px-2.5">
                    <span className="text-[11px] text-destructive-foreground">delete this chat?</span>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
                        onClick={() => setConfirming(null)}>keep</Button>
                      <Button size="sm" variant="destructive" className="h-6 px-2 text-[11px]"
                        onClick={() => void remove(c.id)}>delete</Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
