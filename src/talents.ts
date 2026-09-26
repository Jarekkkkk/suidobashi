/*
 * The marketplace: capabilities, each one a protocol with a server.
 *
 * ONE TO ONE. A talent is how the agent talks to a server — installing it means "I can do this,
 * by asking that". There is no talent without a server, and no server is reached without a
 * talent, which is why they were never two lists.
 *
 * A TALENT HAS TWO SIDES, and conflating them caused the bug this file exists to prevent:
 *
 *   actions        YOUR side — what the agent does. Declared here.
 *   the manifest   THEIR side — what the server does. Fetched from it.
 *
 * The reference filler's manifest declares `fill`. That was being offered to the agent as
 * something IT could do, and the agent claimed it — "I can do these: fill" — for a capability
 * that lives on the other side of the trade, with someone else's key and someone else's risk.
 *
 * So a manifest is read as what the SERVER does, never as what the agent does.
 */

export type TalentAction = {
  id: string;
  /** One line, phrased as what the user gets. This is what the model is told it can do. */
  title: string;
};

export type MarketplaceTalent = {
  /** The server's address. Unique, and it is what the agent has to reach. */
  id: string;
  name: string;
  /**
   * YOUR SIDE. What the agent can do through this talent — declared here, because it is the
   * client's half of the protocol and the server has no idea it exists.
   */
  actions: TalentAction[];
  /** The server this talent talks to. One to one, always present. */
  server: string;
  description: string;
};

export const MARKETPLACE: MarketplaceTalent[] = [
  {
    id: 'http://127.0.0.1:8790',
    name: 'swap',
    server: 'http://127.0.0.1:8790',
    description: 'Escrow SUI or USDC and let someone fill it. Needs an on-chain grant.',
    // The client's half: the agent builds and signs the escrow. The server's half is `fill`,
    // which its manifest declares and which the agent never performs.
    actions: [
      {
        id: 'swap',
        // ONE DIRECTION, because that is what the order path can do. The title used to promise
        // both — the contract has `settle_a2b` and `settle_b2a`, so both look reachable, but the
        // ORDER only escrows SUI and the filler only settles SUI -> USDC. A user asked for the
        // other direction and the gate refused, correctly, against a talent that had offered it.
        title: 'Escrow SUI and receive USDC, filled by whoever takes the order',
      },
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
 * YOUR SIDE ONLY. A server's manifest lists what the server does, and offering that to the model
 * is how an agent came to claim it could fill orders.
 *
 * Assembled rather than written out, so installing something is what makes it available and
 * removing it is what takes it away.
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
