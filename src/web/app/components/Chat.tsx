import { useState, useRef, useEffect, useCallback } from 'react';
import { api, type Event, type BuildResult } from '@/lib/api';
import { wallet } from '@/lib/wallet';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/*
 * The chat: the core loop.
 *
 * Ported from page.js, and the sequence is the point — it is not an implementation
 * detail. The server PROPOSES and BUILDS; the browser SIGNS; the server SUBMITS. The
 * server never holds a key and the browser never chooses the transaction, so neither side
 * can do the whole thing alone. Any refactor that collapses these into one call has
 * thrown away the property the design exists for.
 *
 *   propose  the gate's verdict, before anything is built
 *   build    bytes, held server-side and identified by id
 *   sign     in the wallet, by the user
 *   submit   the signature is paired with THOSE bytes, by id
 */

/** The colour of an event's source. Advisory and authoritative must not look alike. */
const SOURCE_STYLE: Record<Event['source'], string> = {
  model: 'text-amber-300/80',
  pipeline: 'text-sky-300/70',
  chain: 'text-emerald-300/90',
};

export function Chat({ address }: { address: string | null }) {
  const [text, setText] = useState('');
  const [events, setEvents] = useState<Event[]>([]);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the newest line in view. The pipeline narrates as it goes, so the interesting
  // part is always at the bottom.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const say = useCallback((e: Event) => setEvents((prev) => [...prev, e]), []);

  async function send() {
    const request = text.trim();
    if (!request || busy) return;
    setBusy(true);
    setText('');
    say({ kind: 'ask', source: 'pipeline', text: request, terminal: false });

    try {
      // 1. PROPOSE — the deterministic gate runs before anything is built.
      //
      // The decision is UPPERCASE, matching agent.js's own vocabulary. Comparing against a
      // lowercase spelling silently never matches and the flow stops here — which is how
      // this read before, and why the type below names the exact strings rather than
      // leaving it a bare string.
      const proposed = await api<{ events?: Event[]; decision?: 'PROPOSED' | 'REFUSED' }>(
        '/api/propose', { text: request },
      );
      (proposed.events ?? []).forEach(say);
      if (proposed.decision !== 'PROPOSED') return;

      // 2. BUILD — bytes, held server-side under an id.
      //
      // An ORDER, not a swap. The escrow path is the one the chat uses: a swap would draw
      // from the vault, which is empty and always will be, while an order escrows from the
      // maker's own wallet into something the old package versions cannot reach. The
      // server reads the amount from the agent and derives the floor from a live quote, so
      // the text is all that needs sending.
      const built = await api<BuildResult>('/api/build', { kind: 'order', text: request });
      (built.events ?? []).forEach(say);
      if (built.error || !built.bytes || !built.id) {
        say({
          kind: 'build',
          source: 'pipeline',
          text: built.error ?? built.refused?.validation?.reason ?? 'could not build it',
          terminal: true,
        });
        return;
      }

      // 3. SIGN — in the wallet, by the user. The server never sees a key.
      const w = wallet();
      if (!w) {
        say({ kind: 'wallet', source: 'pipeline', text: 'the wallet has not loaded', terminal: true });
        return;
      }
      const signed = await w.sign(built.bytes);

      // 4. SUBMIT — signature paired with those bytes, by id.
      const out = await api<{ digest?: string; status?: string; output?: string; events?: Event[] }>(
        '/api/submit', { id: built.id, signature: signed.signature },
      );
      (out.events ?? []).forEach(say);
      if (out.digest) {
        say({
          kind: 'submitted',
          source: 'chain',
          text: `${out.status ?? 'submitted'} — ${out.digest}`,
          terminal: true,
          data: { digest: out.digest },
        });

        // 5. FILL — hand the order to the MCP server.
        //
        // An order lives a minute, so this is the moment it can be filled. Nobody is
        // watching for orders on this side: the maker tells the server the order exists,
        // and the server decides whether the terms are worth taking. "Not filled" is
        // therefore ROUTINE, not an error — the order expires and anyone may refund it,
        // which is what the design expects to happen to an unattractive order.
        say({
          kind: 'filling',
          source: 'pipeline',
          text: 'asking the mcp server to fill it…',
          terminal: false,
        });
        const f = await api<{ filled?: boolean; digest?: string; fee?: string; orderId?: string; why?: string }>(
          '/api/fill', { digest: out.digest },
        );
        say({
          kind: f.filled ? 'filled' : 'unfilled',
          source: 'chain',
          text: f.filled
            ? `filled — ${f.digest} · fee ${f.fee} to the filler`
            : `not filled: ${f.why ?? 'no reason given'}. It expires shortly, and anyone may refund it to you.`,
          terminal: true,
          data: { orderId: f.orderId, digest: f.digest },
        });
      }
    } catch (e) {
      // A rejected signature is routine — the user may simply have declined. It is
      // worded as an ending rather than an error, matching the server's vocabulary.
      say({
        kind: 'ended',
        source: 'pipeline',
        text: `ended: ${e instanceof Error ? e.message : String(e)}`,
        terminal: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-1.5 overflow-y-auto px-4 py-3">
        {events.length === 0 && (
          <p className="text-sm text-white/40">
            Ask for something. The gate checks it before anything is built.
          </p>
        )}
        {events.map((e, i) => (
          <div key={i} className="flex gap-2 text-sm leading-relaxed">
            <span className={cn('shrink-0 font-mono text-xs', SOURCE_STYLE[e.source])}>
              {e.source}
            </span>
            <span className={cn('min-w-0 break-words', e.terminal ? 'text-white/90' : 'text-white/60')}>
              {e.text}
            </span>
          </div>
        ))}
        {busy && <p className="text-sm text-white/40">working…</p>}
        <div ref={endRef} />
      </div>

      <div className="flex gap-2 border-t border-white/10 p-3">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
          // 1 SUI, not 0.01: the fee is a fixed 0.01 USDC, so a tiny escrow is refused
          // for the tip exceeding what the maker keeps. A placeholder suggesting an amount
          // that always fails is worse than no placeholder.
          placeholder={address ? 'swap 1 SUI to USDC' : 'connect a wallet first'}
          disabled={busy || !address}
        />
        <Button onClick={() => void send()} disabled={busy || !text.trim() || !address}>
          {busy ? '…' : 'Send'}
        </Button>
      </div>
    </div>
  );
}
