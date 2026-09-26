/*
 * The React entry.
 *
 * Ported from src/web/page.js, which stays in the tree until this is confirmed working —
 * the old UI is the reference to check the port against, and deleting it first would
 * throw away the only thing that can tell us the port is faithful.
 *
 * This step moves the wallet connection and the chat loop across. The order form, the
 * owner actions and the panes' remaining content come next; they are additions to a
 * working shell rather than part of proving the shell works.
 */
import { createRoot } from 'react-dom/client';
import { useState, useEffect } from 'react';
import { wallet, short } from '@/lib/wallet';
import { Chat } from '@/components/Chat';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The wallet bundle is a separate script and may not have run yet when this app mounts.
 *
 * Rather than assume script order — which would break the moment either file is loaded
 * differently — poll briefly for the bridge to appear. Bounded, so a genuinely missing
 * wallet bundle surfaces as a message instead of a spinner that never resolves.
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
    <div className={cn(
      'grid h-full',
      'grid-cols-1 md:grid-cols-[240px_1fr] xl:grid-cols-[240px_1fr_400px]',
    )}>
      {/* Left — the marketplace. Published tools and installed ones. */}
      <aside className="hidden border-r border-white/10 p-4 md:block">
        <div className="text-xs uppercase tracking-wider text-white/40">agents</div>
        <p className="mt-3 text-sm text-white/50">
          Published and installed tools will list here.
        </p>
      </aside>

      {/* Centre — the chat. */}
      <main className="flex min-w-0 flex-col">
        <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <span className="font-semibold">sui-tokyo</span>
          <div className="ml-auto flex items-center gap-2">
            {address ? (
              <>
                <span className="font-mono text-xs text-white/50">{short(address)}</span>
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
          <p className="border-b border-white/10 px-4 py-2 text-xs text-amber-300/80">{note}</p>
        )}

        <Chat address={address} />
      </main>

      {/* Right — what is about to be signed, and which step of the flow we are at. */}
      <aside className="hidden border-l border-white/10 p-4 xl:block">
        <div className="text-xs uppercase tracking-wider text-white/40">signing</div>
        <p className="mt-3 text-sm text-white/50">
          The step indicator and the transaction's terms, read from the chain.
        </p>
      </aside>
    </div>
  );
}

const root = document.getElementById('app');
if (!root) throw new Error('no #app element — the page shell is missing');
createRoot(root).render(<App />);
