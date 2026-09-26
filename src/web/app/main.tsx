/*
 * The React entry and the shell.
 *
 * LAYOUT IS FLEX, NOT A FIXED GRID. The previous version used grid-cols with hardcoded pixel
 * widths, which meant the panes were a fixed composition rather than three regions that share
 * the space — and at any width the author had not pictured, something was slightly wrong.
 *
 * The panes now differ by SURFACE, not only by a hairline border: the sidebar has its own
 * colour, the signing pane sits on the card colour, and the conversation is the page. That is
 * the whole reason a three-pane layout reads as one workspace instead of three boxes.
 *
 * Ported from src/web/page.js, WHICH IS NOW DELETED — this is the only UI. What did NOT come across
 * is the admin surface: `topup`, `withdraw` and the position lifecycle have no control here, so they
 * are reached through the `--emit-bytes` scripts instead of a page. That gap is real and is written
 * down in HANDOFF rather than left for someone to discover by looking for a button.
 */
import { createRoot } from 'react-dom/client';
import { useState, useEffect, useCallback } from 'react';
import { wallet } from '@/lib/wallet';
import { api, type Event } from '@/lib/api';
// The vocabulary. ONE hop, not two: this file is at src/web/app/, so `..` is src/web/.
// Extensionless, because a `.js` specifier resolves for the compiler and not for the server.
import { TERMINAL_KINDS, type EventKind } from '../events';
import { Chat } from '@/components/Chat';
import { LeftPane } from '@/components/LeftPane';
import { SigningPane } from '@/components/SigningPane';
import { Home } from '@/components/Home';
import { cn } from '@/lib/utils';

/**
 * The wallet bundle is a separate script and may not have run yet when this app mounts.
 *
 * Rather than assume script order — which would break the moment either file is loaded
 * differently — poll briefly for the bridge to appear. Bounded, so a genuinely missing wallet
 * bundle surfaces as a message instead of a spinner that never resolves.
 */
function useWalletBridge() {
  const [ready, setReady] = useState(() => wallet() !== null);

  useEffect(() => {
    if (ready) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (wallet() || Date.now() - started > 10_000) {
        setReady(wallet() !== null);
        clearInterval(timer);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [ready]);

  return ready;
}

function App() {
  const ready = useWalletBridge();
  const [address, setAddress] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // The flow's events and the terms of the last build live HERE rather than in the chat,
  // because two panes read them. Keeping them in the chat and copying them across would
  // create a second source of truth to drift.
  const [events, setEvents] = useState<Event[]>([]);
  const [terms, setTerms] = useState<Record<string, unknown> | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);

  /**
   * Show an event, and keep it.
   *
   * ONE WRITE POINT, which is the point of doing it here rather than in the chat. An event and a
   * stored message are the same object — the transcript cannot come to disagree with what
   * happened, because there is only one thing happening.
   *
   * Fire and forget: a failed write must not stop the conversation, and the alternative is
   * awaiting a round trip before the user sees their own message.
   */
  const say = useCallback((e: Event) => {
    setEvents((prev) => [...prev, e]);
    if (!chatId) return;
    // `ask` is what the chat renders as "you", so it is stored as the user's turn rather than
    // as its pipeline source.
    void api(`/api/chats/${chatId}`, {
      role: e.kind === 'ask' ? 'user' : e.source,
      // THE KIND IS STORED TOO, and it is the field that matters: `role` cannot tell a refusal
      // from an extraction, so a transcript rebuilt from roles alone lost every bubble.
      kind: e.kind,
      text: e.text,
    }).catch(() => { /* the message is on screen either way */ });
  }, [chatId]);

  /** Load a conversation's history into the transcript. */
  const openChat = useCallback(async (id: string) => {
    try {
      const r = await api<{ messages: { role: string; kind: string | null; text: string }[] }>(
        `/api/chats/${id}`,
      );
      setEvents(r.messages.map((m) => ({
        // The stored kind, not one derived from the role — deriving it is what lost the bubbles.
        // A row from before the column existed has none, and renders as a step: wrong for old
        // history, right for everything after, and no fallback invents a kind it cannot know.
        kind: m.kind ?? '',
        source: (m.role === 'user' ? 'pipeline' : m.role) as Event['source'],
        text: m.text,
        // The same rule the server applies, so there is no second opinion about what terminal
        // means. Hardcoding `false` here is what turned every reloaded answer into a progress row.
        terminal: m.kind ? TERMINAL_KINDS.includes(m.kind as EventKind) : false,
      })));
      setChatId(id);
    } catch {
      setNote('could not open that conversation');
    }
  }, []);

  /**
   * Land somewhere real: the newest chat if there is one, a fresh one otherwise.
   *
   * Used on mount AND after a delete, because they are the same question — "where should the
   * user be now?" — and two copies would be two places for the answer to change.
   *
   * There is always a chat, so nothing said is lost for want of somewhere to put it.
   */
  const settle = useCallback(async () => {
    try {
      const r = await api<{ chats: { id: string }[] }>('/api/chats');
      if (r.chats.length > 0) return void openChat(r.chats[0].id);
      const c = await api<{ id: string }>('/api/chats', { title: 'new chat' });
      setEvents([]);
      setChatId(c.id);
    } catch {
      setNote('could not reach local storage');
    }
  }, [openChat]);

  useEffect(() => { void settle(); }, [settle]);

  // Follow the wallet's own connection state rather than tracking it locally: the user can
  // disconnect from the extension, and a stale address here would let them try to sign.
  useEffect(() => {
    const w = wallet();
    if (!w) return;
    setAddress(w.address());
    return w.onChange(setAddress);
  }, [ready]);

  async function connect() {
    const w = wallet();
    if (!w) return;
    setNote(null);
    try {
      setAddress(await w.connect('slush'));
      // IN, and the URL says so: the app lives at /app and Home at /. One bundle serves both, so
      // this is a history write rather than a navigation — no reload and no second bundle.
      history.replaceState(null, '', '/app');
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function disconnect() {
    await wallet()?.disconnect();
    // The effect below turns this into the home page. Clearing the address IS the action — one
    // place decides what "not connected" means on screen.
    setAddress(null);
  }

  /**
   * NOT CONNECTED MEANS THE HOME PAGE, and the address is the only thing consulted.
   *
   * GUARDED ON `ready` so a slow wallet-bridge load cannot bounce: without it the first render has
   * no address, and the user is sent home before the bridge has had a chance to report one. ONE
   * DIRECTION ONLY — this never sends a CONNECTED user anywhere, so there is no loop to get into.
   */
  useEffect(() => {
    if (!ready || address) return;
    if (window.location.pathname !== '/') history.replaceState(null, '', '/');
  }, [ready, address]);

  // ONE SHELL, THREE STATES. The texture is the theme's paper grain — fixed, and out of the flex
  // flow — and it belongs on all three, because a page that loses its paper reads as a different
  // product.
  const shell = (children: React.ReactNode) => (
    <>
      <div className="texture" />
      {children}
    </>
  );

  // THE BRIDGE IS STILL LOADING, which is its own state rather than "not connected". Rendering
  // Home here would flash a connect button at somebody who is already connected; rendering the app
  // would flash panes that cannot sign.
  if (!ready) {
    return shell(
      <div className="flex h-full items-center justify-center">
        <p className="text-[12px] text-muted-foreground">loading the wallet bridge…</p>
      </div>,
    );
  }

  // NOT CONNECTED IS THE HOME PAGE: the wallet is the account, so there is nothing to show and
  // nothing to sign without one.
  if (!address) {
    return shell(<Home ready={ready} note={note} onConnect={() => void connect()} />);
  }

  return shell(
    <div className="flex h-full min-w-0 overflow-hidden bg-background text-foreground">
      {/* Left — what is installed, and what is left over. Its own surface, so it reads as a
          region of the app rather than as a box with a border. */}
      <aside className={cn(
        // Wider than it was (260): the talent cards are the widest thing in here — a name, a version,
        // two actions, then a fixed 68px label column beside a mono id and a sentence — and at 260
        // there was about 140px left for that last pair. One number, tunable.
        'hidden w-[320px] shrink-0 flex-col border-r border-border bg-sidebar',
        'md:flex',
      )}>
        <LeftPane
          events={events}
          say={say}
          onTerms={setTerms}
          chatId={chatId}
          address={address}
          onDisconnect={() => void disconnect()}
          onSelectChat={(id) => void openChat(id)}
          onNewChat={(id) => { setChatId(id); setEvents([]); }}
          onChatDeleted={() => void settle()}
        />
      </aside>

      {/* Centre — the conversation. The page colour, because it is the thing you look at. */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <span className="text-[13px] font-medium tracking-tight">suidobashi</span>
          <span className="hidden rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground lg:inline">
            on-device agent wallet
          </span>

          {/* THE ACCOUNT IS NOT HERE ANY MORE. The address and its actions moved to the left
              pane's footer, beside the identity they belong to — one place, not two. This header
              keeps the app's name. */}
        </header>

        {note && (
          <p className="shrink-0 border-b border-border bg-destructive/10 px-4 py-2 text-[12px] text-destructive">
            {note}
          </p>
        )}

        <Chat address={address} events={events} onSay={say} onTerms={setTerms} />
      </main>

      {/* Right — what is about to be signed, and what the chain actually did. The card
          surface, because it holds discrete facts rather than a stream. */}
      <aside className={cn(
        'hidden w-[380px] shrink-0 overflow-y-auto border-l border-border bg-card',
        'xl:block',
      )}>
        <SigningPane events={events} terms={terms} />
      </aside>
    </div>,
  );
}

const root = document.getElementById('app');
if (!root) throw new Error('no #app element — the page shell is missing');
createRoot(root).render(<App />);
