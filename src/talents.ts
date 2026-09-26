/*
 * The marketplace: what CAN be installed.
 *
 * A TALENT IS A CAPABILITY. Built-in ones the app performs itself; MCP ones are served by a
 * server and fetched from its manifest. Both are installed the same way and both end up in the
 * same table, because from the model's point of view there is no difference — it is stateless,
 * so what it can do has to be TOLD to it, and installed is what tells it.
 *
 * WHY SWAP IS INSTALLABLE RATHER THAN ALWAYS ON. The model you described is "the local AI is
 * stateless, so we equip it per talent". A capability that is always on is not equipped, it is
 * wired in — and then "install" only ever applies to extras, and the marketplace is decoration.
 * Equipping swap is what makes it a talent rather than a label on hardcoded behaviour.
 *
 * THE RULE FOR WHAT SHIPS BUILT IN: does it need a permission? A query reads the chain and needs
 * nothing. A swap spends and needs an on-chain grant; a position needs a grant and a guard. So
 * query is built in and the other two are installed — which is also why `query` is the one that
 * needs no address, no grant, and no counterparty.
 *
 * THE ADDRESS IS IN THE LIST, not typed by hand. A marketplace you browse is the point; the URL
 * field was a scaffold for having nothing to browse.
 */

export type TalentAction = {
  id: string;
  /** One line, phrased as what the user gets. This is what the model is told it can do. */
  title: string;
};

export type TalentSide = 'maker' | 'filler';

export type MarketplaceTalent = {
  /** `built-in:<name>` for one the app performs, or the URL for one served over MCP. */
  id: string;
  name: string;
  kind: 'built-in' | 'mcp';
  /**
   * WHICH SIDE OF A TRADE THIS SERVES, and it is a field rather than a sentence because it was
   * the thing that confused a real user: a talent called `sui-tokyo-swap` provides `fill`, which
   * takes someone ELSE's order. Installing it and then asking to swap is a reasonable mistake to
   * make, and a description buried under the name is not enough to prevent it.
   *
   *   maker    you create the intent; something else fills it
   *   filler   you take intents someone else created
   */
  side: TalentSide;
  description: string;
  actions: TalentAction[];
  /** Only for MCP talents: where its manifest lives. */
  url?: string;
};

export const MARKETPLACE: MarketplaceTalent[] = [
  {
    id: 'built-in:query',
    name: 'query',
    kind: 'built-in',
    side: 'maker',
    description: 'Read the chain. No permission needed, because nothing is spent.',
    actions: [
      { id: 'status', title: 'Report what the wallet and the guarded position hold' },
    ],
  },
  {
    id: 'built-in:swap',
    name: 'swap',
    kind: 'built-in',
    side: 'maker',
    description: 'Escrow SUI or USDC and let someone fill it. Needs an on-chain grant.',
    actions: [
      { id: 'swap', title: 'Swap SUI for USDC, or USDC for SUI, through an escrowed order' },
    ],
  },
  {
    id: 'built-in:position',
    name: 'position',
    kind: 'built-in',
    side: 'maker',
    description: 'Open and manage a guarded liquidity position. Needs a grant and a guard.',
    actions: [
      { id: 'deposit_liquidity', title: 'Add liquidity to the guarded position' },
      { id: 'rebalance', title: 'Move the guarded position into a new tick range' },
      { id: 'redeem', title: 'Exit the guarded position and take everything back' },
    ],
  },
  {
    // THE FILLER'S SIDE, not the maker's — kept in the list so it is visible and honest rather
    // than something a user has to work out from a manifest. Its action takes someone ELSE's
    // order, which is why installing it gives the agent nothing to do.
    id: 'http://127.0.0.1:8790',
    // Named for what it DOES. It was `sui-tokyo-swap`, which promised a verb it does not
    // provide — the manifest's action is `fill`, the other side of the trade.
    name: 'sui-tokyo-filler',
    kind: 'mcp',
    side: 'filler',
    url: 'http://127.0.0.1:8790',
    description: 'Takes escrowed orders that OTHERS create. You do not need this to swap.',
    actions: [
      { id: 'fill', title: 'Fill an escrowed swap order created by someone else' },
    ],
  },
];

/** The entry for an installed id, or null if it is no longer in the list. */
export function talentFor(id: string): MarketplaceTalent | null {
  return MARKETPLACE.find((t) => t.id === id) ?? null;
}

/**
 * What the model is told it can do, from the talents that are INSTALLED.
 *
 * Assembled rather than written out, so installing something is what makes it available and
 * removing it is what takes it away. A prompt that lists capabilities regardless of what is
 * installed is the same class of bug as a `.d.ts` that disagrees with its implementation.
 */
export function describeTalents(installedIds: string[]): {
  actions: TalentAction[];
  text: string;
} {
  const actions: TalentAction[] = [];
  for (const id of installedIds) {
    const t = talentFor(id);
    if (t) actions.push(...t.actions);
  }
  return {
    actions,
    text: actions.map((a) => `- ${a.id}: ${a.title}`).join('\n'),
  };
}
