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

export type MarketplaceTalent = {
  /** `local:<name>` for one the app performs, or the URL of the service it connects to. */
  id: string;
  name: string;
  /**
   * LOCAL means the app performs it itself. REMOTE means it is a connector to a service, and it
   * exists because that service does — installed by hand, because the relationship is deliberate
   * rather than discovered.
   *
   * Either way its actions ARE the agent's: a connector is how the agent reaches a service, and
   * what the service offers is what the agent can do through it.
   */
  kind: 'local' | 'remote';
  description: string;
  actions: TalentAction[];
  /** Only for remote talents: where the service's manifest lives. */
  url?: string;
};

export const MARKETPLACE: MarketplaceTalent[] = [
  {
    id: 'local:query',
    name: 'query',
    kind: 'local',
    description: 'Read the chain. No permission needed, because nothing is spent.',
    actions: [
      { id: 'status', title: 'Report what the wallet and the guarded position hold' },
    ],
  },
  {
    id: 'local:swap',
    name: 'swap',
    kind: 'local',
    description: 'Escrow SUI or USDC and let someone fill it. Needs an on-chain grant.',
    actions: [
      { id: 'swap', title: 'Swap SUI for USDC, or USDC for SUI, through an escrowed order' },
    ],
  },
  {
    id: 'local:position',
    name: 'position',
    kind: 'local',
    description: 'Open and manage a guarded liquidity position. Needs a grant and a guard.',
    actions: [
      { id: 'deposit_liquidity', title: 'Add liquidity to the guarded position' },
      { id: 'rebalance', title: 'Move the guarded position into a new tick range' },
      { id: 'redeem', title: 'Exit the guarded position and take everything back' },
    ],
  },
];

/**
 * SERVICES: somewhere that fills a role.
 *
 * NOT TALENTS. A talent is something the agent can do; a service is who it asks. They were one
 * list, which is why installing a filler looked like gaining the ability to fill — a real user
 * installed it, asked to swap, was refused, then installed `swap` and asked why both were needed.
 *
 * REGISTERED BY HAND. The relationship is deliberate: a service exists on-chain and the connector
 * follows, not the other way round. An on-chain registry would later be a SOURCE for this list
 * rather than a replacement for it.
 */
export type KnownService = {
  id: string;
  name: string;
  role: string;
  url: string;
  description: string;
};

export const KNOWN_SERVICES: KnownService[] = [
  {
    id: 'http://127.0.0.1:8790',
    name: 'sui-tokyo-filler',
    role: 'filler',
    url: 'http://127.0.0.1:8790',
    description: 'Fills the orders you escrow. Without one, an order simply expires.',
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
