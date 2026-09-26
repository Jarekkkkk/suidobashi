import { useState, useRef, useEffect } from 'react';
import { api, fromUnits, type Event } from '@/lib/api';
import { signAndSubmit } from '@/lib/flow';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/*
 * The chat: the core loop, and the reclaim that follows it.
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

/**
 * USDC has 6 decimals, SUI has 9.
 *
 * Every amount the server sends is in base units — `10000`, not `0.01` — because that is
 * what the chain deals in and converting early would lose the exactness. The conversion
 * belongs here, at the last moment before display, and it is the reason a fee once
 * rendered as "fee 10000 to the filler": the number was right and the units were not.
 */
const usdc = (raw: string | number | undefined) => `${fromUnits(raw, 6)} USDC`;

export function Chat({
  address,
  events,
  onSay,
  onTerms,
}: {
  address: string | null;
  events: Event[];
  onSay: (e: Event) => void;
  onTerms: (t: Record<string, unknown> | null) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the newest line in view. The pipeline narrates as it goes, so the interesting
  // part is always at the bottom.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  // The events live in the app above, because the signing pane reads them too. One source
  // of truth, so the pane cannot drift out of step with the conversation.
  const say = onSay;

  /** The whole swap: propose, then the escrow, then hand it to the filler. */
  async function send() {
    const request = text.trim();
    if (!request || busy) return;
    setBusy(true);
    setText('');
    say({ kind: 'ask', source: 'pipeline', text: request, terminal: false });

    try {
      // 1. PROPOSE — the deterministic gate runs before anything is built.
      //
      // The decision is UPPERCASE, matching agent.js's own vocabulary. Comparing against
      // a lowercase spelling silently never matches and the flow stops here — which is how
      // this read before, and why the type below names the exact strings rather than
      // leaving it a bare string.
      const proposed = await api<{ events?: Event[]; decision?: 'PROPOSED' | 'REFUSED' }>(
        '/api/propose', { text: request },
      );
      (proposed.events ?? []).forEach(say);
      if (proposed.decision !== 'PROPOSED') return;

      // 2-4. BUILD, SIGN, SUBMIT.
      //
      // An ORDER, not a swap. The escrow path is the one the chat uses: a swap would draw
      // from the vault, which is empty and always will be, while an order escrows from the
      // maker's own wallet into something the old package versions cannot reach. The
      // server reads the amount from the agent and derives the floor from a live quote, so
      // the text is all that needs sending.
      const digest = await signAndSubmit('order', { text: request }, say, onTerms);
      if (!digest) return;

      say({
        kind: 'submitted',
        source: 'chain',
        text: `escrowed and submitted — ${digest}`,
        terminal: false,
        data: { digest },
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
      const f = await api<{
        filled?: boolean; digest?: string; fee?: string; minOut?: string;
        orderId?: string; why?: string;
      }>('/api/fill', { digest });

      if (f.filled) {
        // What the maker KEEPS is the number that matters, and it is the floor rather
        // than an exact figure: settlement asserts `output - fee >= min_out`, so the
        // maker received at least this and possibly more. Saying "at least" is the
        // honest phrasing; the exact amount would need a chain read.
        say({
          kind: 'filled',
          source: 'chain',
          text: `filled — ${f.digest} · you received at least ${usdc(f.minOut)} · `
            + `fee ${usdc(f.fee)} to the filler`,
          terminal: true,
          data: { orderId: f.orderId, digest: f.digest },
        });
      } else {
        say({
          kind: 'unfilled',
          source: 'chain',
          text: `not filled: ${f.why ?? 'no reason given'}. It expires shortly, and anyone `
            + 'may refund it to you.',
          terminal: true,
          data: { orderId: f.orderId },
        });
      }

      // A settled order stays on chain, and its storage rebate goes to whoever signs the
      // burn — so leaving it alive is what lets the MAKER reclaim it rather than the server
      // that filled it. That is the whole reason `burn` is maker-gated.
      //
      // Reclaimed AUTOMATICALLY, as the tail of this flow rather than a button. There is
      // nothing to weigh: it is a net gain of ~0.0041 SUI every time, and asking the user
      // to authorise something that is always correct is a worse interface than just doing
      // it. The wallet pops a second signature, the same as the first.
      //
      // Only after a FILL. An unfilled order has not expired, so `burn` would refuse it and
      // the refusal would be guaranteed rather than informative.
      if (f.filled && f.orderId) await reclaim(f.orderId);
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

  /**
   * Reclaim a settled order's storage.
   *
   * This is the step that pays the user rather than costing them: measured on mainnet, the
   * burn's gas is ~0.0001 SUI and the rebate is ~0.0042, so it nets about +0.0041. It needs
   * the MAKER's signature because `order::burn` asserts the caller is the maker — a stranger
   * cannot take the rebate, and neither can we.
   *
   * No busy handling of its own: it is called from inside the flow, which already owns that
   * state. The guard it used to carry was for the button, and the button is gone.
   */
  async function reclaim(orderId: string) {
    say({
      kind: 'reclaiming',
      source: 'pipeline',
      text: 'reclaiming the settled order\u2019s storage…',
      terminal: false,
    });
    try {
      const digest = await signAndSubmit('burn', { orderId }, say, onTerms);
      if (digest) {
        say({
          kind: 'reclaimed',
          source: 'chain',
          text: `reclaimed — ${digest} · about 0.0042 SUI of storage back`,
          terminal: true,
          data: { digest, orderId },
        });
      } else {
        // The build was refused and did not throw, so signAndSubmit has already emitted the
        // server's reason. This adds what that reason cannot know: that it is a TIMING
        // outcome rather than a lost one.
        //
        // The build already retried on its own — eight attempts with a short backoff — so
        // reaching here means the settlement stayed unreadable for several seconds. Rare,
        // and not lost: the order is on chain and the storage is still the maker's.
        //
        // The message names WHERE to retry, because the chat cannot: the reclaim runs only
        // as the tail of a fill, and a standing field here was removed as bad UI. Saying
        // "retry it" without saying where would be a path that does not exist.
        say({
          kind: 'reclaim-pending',
          source: 'pipeline',
          text: 'the reclaim could not be built yet — the order is still on chain and its '
            + 'storage is still yours, so nothing was lost. It can be burned from the '
            + 'original page at / or with src/burn-order.js, using the id shown in the '
            + 'signing pane.',
          terminal: true,
          data: { orderId },
        });
      }
    } catch (e) {
      // A declined second signature is routine and must not undo the fill, which has
      // already landed. The order stays on chain and can still be reclaimed later.
      say({
        kind: 'ended',
        source: 'pipeline',
        text: `the reclaim was not signed: ${e instanceof Error ? e.message : String(e)}. `
          + 'The order is still on chain and can be reclaimed later.',
        terminal: true,
      });
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
