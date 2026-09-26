import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { signAndSubmit, type Say, type OnTerms } from '@/lib/flow';
import type { Event } from '@/lib/api';
import { cn } from '@/lib/utils';
import { short } from '@/lib/wallet';
import { Button } from '@/components/ui/button';
import { SourceAvatar } from '@/components/Avatar';
import { PolicySheet } from '@/components/PolicySheet';
import { ChatsPane } from '@/components/ChatsPane';
import { TalentsPane } from '@/components/TalentsPane';

/*
 * The left pane: what is installed, and what is left over.
 *
 * The second tab exists because this system is NOTIFIED, NOT WATCHING — the maker tells the
 * server an order exists, and nothing polls. So something has to hold the things that were left
 * behind, and the honest answer is the user, with a place that shows them.
 *
 * IT MUST NOT BE A DEAD END. A list of things you cannot act on is worse than no list: it
 * reports a problem and withholds the remedy. Every row carries its action, and the action is
 * wired to the same build→sign→submit the chat uses.
 */

type Order = {
  orderId: string;
  state: 'live' | 'settled';
  action: 'revoke' | 'burn';
  expired: boolean;
  minOut: string;
  expiresAtMs: string;
};

type Outstanding = {
  orders: Order[];
  scanned: number;
  candidates: number;
  orderObjects: number;
  at: number;
};

type Hire = {
  name: string;
  policyId: string;
  agent?: string;
  budgetSui?: string;
  suspended?: boolean;
  venues?: number;
  /** The allowed pools themselves, for the settings sheet. A count cannot tell one venue from
   *  another, and the sheet has to show what a save would change. */
  venueIds?: string[];
  destination?: string;
};

/** Seconds until an order expires, or null once it has. */
function countdown(expiresAtMs: string): number | null {
  const left = Number(expiresAtMs) - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : null;
}

function Tab({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** One row of the account menu. A button, because everything in it acts. */
function MenuRow({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'block w-full px-3 py-1.5 text-left text-[12px] transition-colors',
        'hover:bg-accent hover:text-accent-foreground disabled:opacity-50',
      )}
    >
      {children}
    </button>
  );
}

/** A small status pill. Colour carries the meaning, so it is a token and not a literal. */
function Pill({ tone, children }: { tone: 'muted' | 'chain' | 'advisory'; children: React.ReactNode }) {
  const tones = {
    muted: 'bg-muted text-muted-foreground',
    chain: 'bg-success/15 text-chain',
    advisory: 'bg-warning/15 text-advisory',
  } as const;
  return (
    <span className={cn('rounded-sm px-1.5 py-0.5 text-[10px] font-medium', tones[tone])}>
      {children}
    </span>
  );
}

/**
 * What this pane needs from the app.
 *
 * Named rather than written inline, because it is seven fields and because the app passes every
 * one of them by name — an inline type makes the contract visible only from inside the component
 * that consumes it, which is the wrong side of the boundary.
 */
export type LeftPaneProps = {
  events: Event[];
  say: Say;
  onTerms: OnTerms;
  /** The open conversation, or null before the first one exists. */
  chatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: (id: string) => void;
  /** The OPEN chat was deleted, so the transcript on screen is gone. */
  onChatDeleted: () => void;
  /**
   * The connected address, or null. ONE SOURCE OF TRUTH: the app owns this and feeds it from the
   * wallet's own change events, so this pane never asks the wallet anything itself.
   */
  address: string | null;
  onDisconnect: () => void;
};

export function LeftPane({
  events,
  say,
  onTerms,
  chatId,
  onSelectChat,
  onNewChat,
  onChatDeleted,
  address,
  onDisconnect,
}: LeftPaneProps) {
  // Chats first: it is the tab you return to, and the one that says what the app is for.
  const [tab, setTab] = useState<'chats' | 'talents' | 'notifications'>('chats');
  const [out, setOut] = useState<Outstanding | null>(null);
  const [hires, setHires] = useState<Hire[] | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** A chain read in flight. Distinct from `busy`, which means a SIGNATURE is pending — the
   *  two look similar in the UI and are not the same thing to be waiting on. */
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** The account row, for the click-outside test. */
  const menuRef = useRef<HTMLDivElement>(null);

  // CLICK-OUTSIDE AND ESCAPE CLOSE THE MENU — the same two rules PolicySheet follows, and for the
  // same reason: a menu a click cannot dismiss reads as a modal on a page you cannot navigate.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const load = useCallback(async () => {
    setReading(true);
    try {
      const [o, h] = await Promise.all([
        api<Outstanding>('/api/outstanding'),
        api<{ hires?: Hire[] } | Hire[]>('/api/hires'),
      ]);
      setOut(o);
      setHires(Array.isArray(h) ? h : (h.hires ?? []));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // RELOAD WHEN A FLOW ENDS, not on every event. A reload is a multi-second chain scan, so
  // firing it per event would run dozens per swap; a terminal event is the signal that
  // on-chain state may have changed, and it is the same signal the signing pane uses to know
  // the flow is over.
  //
  // Without this the pane was a snapshot taken at page load, so an order created afterwards
  // was invisible until the user thought to press refresh — which is not a feature, it is a
  // chore. Found by the user reporting a missing row while the endpoint was correct all along.
  const terminalCount = events.reduce((n, e) => n + (e.terminal ? 1 : 0), 0);
  useEffect(() => {
    if (terminalCount > 0) void load();
  }, [terminalCount, load]);

  /**
   * Act on one row.
   *
   * ONE PATH, wallet-signed, for both actions. A burn and a revoke are the same three steps as
   * every other action here: the server builds the bytes, the wallet signs them, the server
   * submits. Nothing about a revoke is special enough to justify a second mechanism.
   *
   * This briefly ran server-side, because Slush refused to prepare the refund transaction —
   * failing before it showed a modal — while the chain executed the identical bytes happily.
   * That was a workaround for a diagnosis I never made, and it had a real cost: the maker could
   * no longer tell who was signing their own transaction without opening an explorer.
   */
  async function act(order: Order) {
    if (busy) return;
    setBusy(true);

    say({
      kind: order.action === 'revoke' ? 'revoking' : 'reclaiming',
      source: 'pipeline',
      text: order.action === 'revoke'
        ? 'revoking the expired order…'
        : 'reclaiming a settled order\u2019s storage…',
      terminal: false,
    });

    try {
      const digest = await signAndSubmit(order.action, { orderId: order.orderId }, say, onTerms);
      if (digest) {
        say({
          kind: order.action === 'revoke' ? 'revoked' : 'reclaimed',
          source: 'chain',
          text: order.action === 'revoke'
            ? `revoked — ${digest} · your escrow is back in your wallet`
            : `reclaimed — ${digest} · about 0.0042 SUI of storage back`,
          terminal: true,
          data: { digest, orderId: order.orderId },
        });
        await load();
      }
    } catch (e) {
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
   * Run any of the owner actions.
   *
   * ONE RUNNER FOR ALL OF THEM. They differ in their parameters, not in their shape: the server
   * builds the bytes, the wallet signs them, the server submits. Ten separate handlers would be
   * ten places to get the busy state and the wording wrong.
   *
   * The values arrive as the user typed them — "0.5", not 500000000 — because the server's
   * `toMist` parses a decimal string and is the one place that knows how. Converting here would
   * be a second implementation of the same rule.
   */
  async function run(kind: string, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    say({ kind: 'building', source: 'pipeline', text: `${kind}…`, terminal: false });
    try {
      const digest = await signAndSubmit(kind, body, say, onTerms);
      if (digest) {
        say({
          kind: 'done',
          source: 'chain',
          text: `${kind} — ${digest}`,
          terminal: true,
          data: { digest },
        });
        await load();
      }
    } catch (e) {
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

  const outstanding = out?.orders ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* A plain tab strip rather than the shadcn Tabs component: two tabs, no keyboard
          roving, and vendoring Radix for this would be more code than it replaces. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        <Tab active={tab === 'chats'} onClick={() => setTab('chats')}>chats</Tab>
        <Tab active={tab === 'talents'} onClick={() => setTab('talents')}>talents</Tab>
        <Tab active={tab === 'notifications'} onClick={() => setTab('notifications')}>
          outstanding
          {outstanding.length > 0 && (
            <span className="ml-1.5 rounded-full bg-warning/20 px-1.5 text-[10px] text-advisory">
              {outstanding.length}
            </span>
          )}
        </Tab>
      </div>

      {note && (
        <p className="shrink-0 border-b border-border bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          {note}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* No padding: ChatsPane is a full-height list with its own header and scroll area, and
            an outer inset stopped it reaching the pane's edges. */}
        {tab === 'chats' && (
          <ChatsPane
            current={chatId}
            onSelect={onSelectChat}
            onNew={onNewChat}
            onDeleted={onChatDeleted}
          />
        )}

        {tab === 'talents' && (
          <div className="flex h-full flex-col">
            {/* What the model can DO. */}
            <TalentsPane />
            {/* HIDDEN for now, not deleted. The deepbook guard and the strategy listing are still
                `GuardPane.tsx` and `StrategiesPane.tsx` in this directory, and bringing either back
                is one import and one line here. They were showing live chain JSON — useful while it
                was being built, and noise in a pane whose job is to list what the model can call. */}
          </div>
        )}

        {tab === 'notifications' && (
          <div className="p-3">
            {out && outstanding.length === 0 && (
              <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
                <p className="text-[12px] text-muted-foreground">Nothing needs attention.</p>
                {/* The counters are shown, not hidden: an empty list on its own cannot be told
                    apart from a broken scan, so the numbers that distinguish them are visible. */}
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  {out.scanned} transactions scanned · {out.candidates} created objects read
                </p>
              </div>
            )}

            <ul className="flex flex-col gap-2">
              {outstanding.map((o) => {
                const left = countdown(o.expiresAtMs);
                return (
                  <li key={o.orderId} className="rounded-lg border border-border bg-card p-2.5">
                    <div className="flex items-center gap-2">
                      <Pill tone={o.state === 'settled' ? 'chain' : 'muted'}>{o.state}</Pill>
                      <span className="text-[11px] text-muted-foreground">
                        {o.state === 'settled'
                          ? 'storage is yours'
                          : left === null
                            ? 'expired'
                            : `expires in ${left}s`}
                      </span>
                    </div>
                    <div className="mt-1.5 break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
                      {o.orderId}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 w-full"
                      // A live, unexpired order cannot be revoked: refund aborts with
                      // ENotExpired, which is the guard stopping a maker racing their own
                      // order. Offering the button would promise a guaranteed failure.
                      disabled={busy || (o.action === 'revoke' && left !== null)}
                      onClick={() => void act(o)}
                    >
                      {o.action}
                      {o.action === 'revoke' && left !== null ? ` in ${left}s` : ''}
                    </Button>
                  </li>
                );
              })}
            </ul>

            {out && outstanding.length > 0 && (
              <p className="mt-3 px-1 text-[10px] text-muted-foreground">
                snapshot · {out.scanned} scanned · {out.orderObjects} on chain
              </p>
            )}
          </div>
        )}
      </div>

      {/* THE FOOTER IS THE PANE'S, NOT A TAB'S — the account row and the pane's actions, both of
          which are true whatever tab is showing. The grant is not a property of the talents tab.

          THE ACCOUNT LIVES HERE because a disconnected wallet never reaches this pane (it goes to
          the home page), so this reads as the pane's own row rather than as chrome at the top. Its
          actions sit behind ONE menu: three buttons in a footer is three things to read, and only
          one of them is pressed often. The menu opens UPWARD — a dropdown below the last row of a
          full-height pane has nowhere to go. */}
      <div ref={menuRef} className="relative flex shrink-0 items-center gap-2 border-t border-border p-2">
        <SourceAvatar source="wallet" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {address ? short(address) : 'not connected'}
        </span>
        <Button
          size="icon" variant="ghost" className="h-7 w-7 shrink-0"
          aria-label="account and pane actions" aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {/* Three dots, inline: it takes currentColor like every other glyph here, and one menu
              does not justify an icon dependency. */}
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="19" cy="12" r="1.7" />
          </svg>
        </Button>

        {menuOpen && (
          <div className="absolute bottom-full right-2 z-20 mb-1 w-44 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md">
            <MenuRow onClick={() => { setMenuOpen(false); void load(); }} disabled={reading}>
              {reading ? 'reading…' : 'refresh'}
            </MenuRow>
            <MenuRow onClick={() => { setMenuOpen(false); setSheetOpen(true); }}>policy</MenuRow>
            <MenuRow onClick={() => { setMenuOpen(false); onDisconnect(); }}>disconnect</MenuRow>
          </div>
        )}
      </div>

      {sheetOpen && (() => {
        const h = (hires ?? []).find((x) => x.name === 'standard');
        return h ? (
          <PolicySheet hire={h} busy={busy} onClose={() => setSheetOpen(false)} run={run} />
        ) : null;
      })()}
    </div>
  );
}
