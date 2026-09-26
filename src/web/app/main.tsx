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
 * Ported from src/web/page.js, which stays in the tree until this is confirmed working — the
 * old UI is the reference to check the port against, and deleting it first would throw away the
 * only thing that can tell us the port is faithful.
 */
import { createRoot } from 'react-dom/client';
import { useState, useEffect, useCallback } from 'react';
import { wallet, short } from '@/lib/wallet';
import type { Event } from '@/lib/api';
import { Chat } from '@/components/Chat';
import { LeftPane } from '@/components/LeftPane';
import { SigningPane } from '@/components/SigningPane';
import { Button } from '@/components/ui/button';
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
  const say = useCallback((e: Event) => setEvents((prev) => [...prev, e]), []);

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
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function disconnect() {
    await wallet()?.disconnect();
    setAddress(null);
  }

  return (
    <div className="flex h-full min-w-0 overflow-hidden bg-background text-foreground">
      {/* Left — what is installed, and what is left over. Its own surface, so it reads as a
          region of the app rather than as a box with a border. */}
      <aside className={cn(
        'hidden w-[260px] shrink-0 flex-col border-r border-border bg-sidebar',
        'md:flex',
      )}>
        <LeftPane events={events} say={say} onTerms={setTerms} />
      </aside>

      {/* Centre — the conversation. The page colour, because it is the thing you look at. */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <span className="text-[13px] font-medium tracking-tight">sui-tokyo</span>
          <span className="hidden rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground lg:inline">
            on-device agent wallet
          </span>

          <div className="ml-auto flex items-center gap-2">
            {address ? (
              <>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {short(address)}
                </span>
                <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
                  disconnect
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => void connect()} disabled={!ready}>
                {ready ? 'connect wallet' : 'loading wallet…'}
              </Button>
            )}
          </div>
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
    </div>
  );
}

const root = document.getElementById('app');
if (!root) throw new Error('no #app element — the page shell is missing');
createRoot(root).render(<App />);
