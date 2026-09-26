import { useState, useRef, useEffect } from 'react';
import { api, fromUnits, type Event } from '@/lib/api';
import { signAndSubmit } from '@/lib/flow';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SourceAvatar } from '@/components/Avatar';
import { Bubble, BubbleContent, BubbleReactions } from '@/components/ui/bubble';

/*
 * The chat: the core loop, and the reclaim that follows it.
 *
 * Ported from page.js, and the sequence is the point — it is not an implementation detail. The
 * server PROPOSES and BUILDS; the browser SIGNS; the server SUBMITS. The server never holds a
 * key and the browser never chooses the transaction, so neither side can do the whole thing
 * alone. Any refactor that collapses these into one call has thrown away the property the
 * design exists for.
 *
 *   propose  the gate's verdict, before anything is built
 *   build    bytes, held server-side and identified by id
 *   sign     in the wallet, by the user
 *   submit   the signature is paired with THOSE bytes, by id
 */

/**
 * What each source IS, in three words. Shown on hover.
 *
 * A creature says WHO is talking, not what they are — and the difference matters here more than
 * usual: the model's words are advisory, the pipeline's are unconfirmed, and the chain's are
 * facts. The avatar carries the identity; this carries the standing.
 */
const SOURCE_TITLE: Record<Event['source'], string> = {
  model: 'the local model — advisory',
  pipeline: 'our own pipeline — not yet confirmed',
  chain: 'read from the chain — authoritative',
};

/**
 * WHAT THE FOLD HIDES, named rather than derived.
 *
 * It used to hide "everything not said", and that default is what broke: `answered` was missing
 * from TERMINAL_KINDS, so every capabilities answer was classified as progress — counted as a
 * step and folded away. The user's questions survived and the answers to them did not.
 *
 * A fold whose default is HIDE fails silently every time a kind is added. This names what it folds
 * and shows everything else, so an unclassified kind is VISIBLE — the safe direction, and the one
 * a reader can check at a glance.
 *
 * Note this is a different question from "bubble or line": that one asks whether the event is
 * addressed to you, this one asks whether the fold may put it away.
 */
const PROGRESS_KINDS = new Set([
  'extracting', 'proposed', 'building', 'signing', 'submitting',
  'notified', 'filling', 'reclaiming',
]);

/**
 * USDC has 6 decimals, SUI has 9.
 *
 * Every amount the server sends is in base units — `10000`, not `0.01` — because that is what
 * the chain deals in and converting early would lose the exactness. The conversion belongs here,
 * at the last moment before display, and it is the reason a fee once rendered as "fee 10000 to
 * the filler": the number was right and the units were not.
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
  /** The progress lines of a FINISHED flow, shown on request. */
  const [showSteps, setShowSteps] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the newest line in view. The pipeline narrates as it goes, so the interesting part is
  // always at the bottom.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events]);

  // The events live in the app above, because the signing pane reads them too. One source of
  // truth, so the pane cannot drift out of step with the conversation.
  const say = onSay;

  /** The whole swap: propose, then the escrow, then hand it to the filler. */
  async function send(answer?: string) {
    const request = (answer ?? text).trim();
    if (!request || busy) return;
    setBusy(true);
    setText('');
    say({ kind: 'ask', source: 'pipeline', text: request, terminal: false });

    try {
      // 1. PROPOSE — the deterministic gate runs before anything is built.
      //
      // The decision is UPPERCASE, matching agent.ts's own vocabulary. Comparing against a
      // lowercase spelling silently never matches and the flow stops here — which is how this
      // read before, and why the type below names the exact strings rather than leaving it a
      // bare string.
      const proposed = await api<{ events?: Event[]; decision?: 'PROPOSED' | 'REFUSED' }>(
        '/api/propose', { text: request },
      );
      (proposed.events ?? []).forEach(say);
      if (proposed.decision !== 'PROPOSED') return;

      // 2-4. BUILD, SIGN, SUBMIT.
      //
      // An ORDER, not a swap. The escrow path is the one the chat uses: a swap would draw from
      // the vault, which is empty and always will be, while an order escrows from the maker's
      // own wallet into something the old package versions cannot reach. The server reads the
      // amount from the agent and derives the floor from a live quote, so the text is all that
      // needs sending.
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
      // An order lives a minute, so this is the moment it can be filled. Nobody is watching for
      // orders on this side: the maker tells the server the order exists, and the server decides
      // whether the terms are worth taking. "Not filled" is therefore ROUTINE, not an error —
      // the order expires and anyone may refund it, which is what the design expects to happen
      // to an unattractive order.
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
        // What the maker KEEPS is the number that matters, and it is the floor rather than an
        // exact figure: settlement asserts `output - fee >= min_out`, so the maker received at
        // least this and possibly more. Saying "at least" is the honest phrasing; the exact
        // amount would need a chain read.
        say({
          kind: 'filled',
          source: 'chain',
          text: `filled — ${f.digest} · you received at least ${usdc(f.minOut)} · `
            + `fee ${usdc(f.fee)} to the filler`,
          terminal: true,
          data: { orderId: f.orderId, digest: f.digest },
        });
      } else {
        // NOT filled. Named as the routine outcome it is, and it says where to act on it: the
        // outstanding tab in the left pane, which is exactly what that tab is for.
        //
        // "Refund" was the old word for this and it was misleading — it read as paying someone
        // out when it is taking your own escrow back. The action is called `revoke` everywhere
        // else, and two names for one thing in adjacent panes is the kind of drift that makes a
        // UI feel unreliable.
        say({
          kind: 'unfilled',
          source: 'chain',
          text: `not filled: ${f.why ?? 'no reason given'}. It expires shortly — the `
            + 'outstanding tab will offer to revoke it and return your escrow.',
          terminal: true,
          data: { orderId: f.orderId },
        });
      }

      // A settled order stays on chain, and its storage rebate goes to whoever signs the burn —
      // so leaving it alive is what lets the MAKER reclaim it rather than the server that filled
      // it. That is the whole reason `burn` is maker-gated.
      //
      // Reclaimed AUTOMATICALLY, as the tail of this flow rather than a button. There is nothing
      // to weigh: it is a net gain of ~0.0041 SUI every time, and asking the user to authorise
      // something that is always correct is a worse interface than just doing it. The wallet
      // pops a second signature, the same as the first.
      //
      // Only after a FILL. An unfilled order has not expired, so `burn` would refuse it and the
      // refusal would be guaranteed rather than informative.
      if (f.filled && f.orderId) await reclaim(f.orderId);
    } catch (e) {
      // A rejected signature is routine — the user may simply have declined. It is worded as an
      // ending rather than an error, matching the server's vocabulary.
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
   * burn's gas is ~0.0001 SUI and the rebate is ~0.0042, so it nets about +0.0041. It needs the
   * MAKER's signature because `order::burn` asserts the caller is the maker — a stranger cannot
   * take the rebate, and neither can we.
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
        // server's reason. This adds what that reason cannot know: that it is a TIMING outcome
        // rather than a lost one.
        //
        // The build already retried on its own — eight attempts with a short backoff — so
        // reaching here means the settlement stayed unreadable for several seconds. Rare, and
        // not lost: the order is on chain and the storage is still the maker's.
        //
        // The message names WHERE to retry, because the chat cannot: the reclaim runs only as
        // the tail of a fill, and a standing field here was removed as bad UI. Saying "retry it"
        // without saying where would be a path that does not exist.
        say({
          kind: 'reclaim-pending',
          source: 'pipeline',
          text: 'the reclaim could not be built yet — the order is still on chain and its '
            + 'storage is still yours, so nothing was lost. It can be burned from the '
            + 'original page at / or with src/burn-order.ts, using the id shown in the '
            + 'signing pane.',
          terminal: true,
          data: { orderId },
        });
      }
    } catch (e) {
      // A declined second signature is routine and must not undo the fill, which has already
      // landed. The order stays on chain and can still be reclaimed later.
      say({
        kind: 'ended',
        source: 'pipeline',
        text: `the reclaim was not signed: ${e instanceof Error ? e.message : String(e)}. `
          + 'The order is still on chain and can be reclaimed later.',
        terminal: true,
      });
    }
  }

  const empty = events.length === 0;

  // WHAT WAS SAID GETS A BUBBLE; WHAT HAPPENED GETS A LINE.
  //
  // A response is addressed to you. Progress is the machine narrating itself, and bubbling it
  // would give it the same weight as an answer — the opposite of what the four source colours
  // are for. So `ask` and the terminal outcomes are bubbles, everything else is a quiet row.
  const isSaid = (e: Event) => e.kind === 'ask' || e.terminal;

  // A FINISHED FLOW COLLAPSES ITS STEPS. Eight progress lines above an answer push the answer up
  // the screen, and once the flow has ended the steps are the record rather than the point. While
  // it is RUNNING they stay visible, because then they ARE the point.
  const lastTerminal = events.reduce((at, e, i) => (e.terminal ? i : at), -1);
  const steps = events.filter((e, i) => PROGRESS_KINDS.has(e.kind) && i < lastTerminal).length;
  const hidden = !showSteps && steps > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-[13px] text-muted-foreground">Ask for something.</p>
            <p className="max-w-[36ch] text-[12px] leading-relaxed text-muted-foreground/60">
              The gate checks it before anything is built, and the terms appear in the signing
              pane before your wallet is asked.
            </p>
            {address && (
              <button
                onClick={() => setText('swap 1 SUI to USDC')}
                className="mt-2 rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                swap 1 SUI to USDC
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 px-4 py-3">
            {/* The steps of a finished flow, folded into one line. They are the record rather than
                the point once the flow has ended, and eight of them above an answer push the
                answer up the screen. Still one click away, so nothing is hidden. */}
            {hidden && (
              <button
                onClick={() => setShowSteps(true)}
                className="mb-1.5 self-start rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
              >
                {steps} steps · show
              </button>
            )}
            {events.map((e, i) => {
              const isAsk = e.kind === 'ask';
              const said = isSaid(e);

              // Hidden only when a LATER terminal event has closed the flow, and only if it is
              // PROGRESS. Steps still running, and steps after the last outcome, are always shown.
              if (hidden && PROGRESS_KINDS.has(e.kind) && i < lastTerminal) return null;

              if (!said) {
                return (
                  <div
                    key={i}
                    className="animate-fade-in flex items-center gap-2.5 py-0.5 pl-1"
                  >
                    <SourceAvatar source={e.source} size={14} />
                    <span className="min-w-0 whitespace-pre-line break-words text-[12px] leading-relaxed text-muted-foreground/70">
                      {e.text}
                    </span>
                  </div>
                );
              }

              return (
                <div
                  key={i}
                  className={cn(
                    'flex w-full',
                    isAsk ? 'justify-end' : 'justify-start',
                    // Arrives from the side it belongs to.
                    isAsk ? 'animate-send-in' : 'animate-receive-in',
                    i > 0 && 'mt-1.5',
                  )}
                >
                  <Bubble
                    align={isAsk ? 'end' : 'start'}
                    // What each source IS, not just what it is called. The creature says WHO is
                    // talking; this says their standing — advisory, unconfirmed, or a fact.
                    title={isAsk ? 'you asked this' : SOURCE_TITLE[e.source]}
                    // The user's own words are the strong surface; an outcome is neutral, because a
                    // refusal is routine here and colouring it as an error would make a working
                    // system feel broken.
                    variant={isAsk ? 'tinted' : 'secondary'}
                  >
                    <BubbleContent>{e.text}</BubbleContent>

                    {/* A QUESTION, ANSWERED BY CLICKING. The options are the candidates the gate
                        could not choose between — asking is a third outcome, not a refusal.

                        The answer is the TEMPLATE plus the chosen name, not the original request:
                        the original named two, and sending it back would ask forever. */}
                    {e.kind === 'asking' && Array.isArray(e.data?.options) && (
                      <BubbleReactions align="start" className="mt-2">
                        {(e.data!.options as string[]).map((o) => (
                          <button
                            key={o}
                            disabled={busy}
                            onClick={() => void send(`use the ${o} agent to ${e.data!.template ?? ''}`)}
                            className={cn(
                              'rounded-md border border-brand/40 bg-brand-soft px-2.5 py-1',
                              'text-[12px] text-brand transition-colors hover:bg-brand/20',
                              'disabled:opacity-50',
                            )}
                          >
                            {o}
                          </button>
                        ))}
                      </BubbleReactions>
                    )}
                  </Bubble>
                </div>
              );
            })}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* The composer as a pill: the field and the send button are ONE surface, which is what
          makes it read as a place to type rather than as two controls that happen to be adjacent. */}
      <div className="shrink-0 p-3">
        <div
          className={cn(
            'flex items-center gap-2 rounded-xl border border-input bg-card px-3 py-1.5',
            'transition-colors focus-within:border-brand/60',
            (busy || !address) && 'opacity-60',
          )}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
            // 1 SUI, not 0.01: the fee is a fixed 0.01 USDC, so a tiny escrow is refused for the
            // tip exceeding what the maker keeps. A placeholder suggesting an amount that always
            // fails is worse than no placeholder.
            placeholder={address ? 'swap 1 SUI to USDC' : 'connect a wallet first'}
            disabled={busy || !address}
            className="min-w-0 flex-1 bg-transparent py-1 text-[13px] outline-none placeholder:text-muted-foreground/50"
          />
          <Button
            size="icon"
            variant={text.trim() && !busy && address ? 'brand' : 'ghost'}
            onClick={() => void send()}
            disabled={busy || !text.trim() || !address}
            aria-label="send"
          >
            {busy ? <span className="animate-pulse text-[11px]">···</span> : '↑'}
          </Button>
        </div>
      </div>
    </div>
  );
}
