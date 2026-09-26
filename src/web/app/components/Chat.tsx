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
      const built = await api<BuildResult>('/api/build', { kind: 'swap', text: request });
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
          placeholder={address ? 'swap 0.01 SUI to USDC' : 'connect a wallet first'}
          disabled={busy || !address}
        />
        <Button onClick={() => void send()} disabled={busy || !text.trim() || !address}>
          {busy ? '…' : 'Send'}
        </Button>
      </div>
    </div>
  );
}
