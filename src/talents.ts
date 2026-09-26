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
 * So a manifest is read as what the SERVER does, never as what the agent does. The two sides are
 * also allowed to be DIFFERENT SIZES: the query server answers object lookups that no client
 * action names yet, exactly as the filler declares `fill` that the agent never performs.
 */

export type TalentAction = {
  id: string;
  /** One line, phrased as what the user gets. This is what the model is told it can do. */
  title: string;
  /**
   * DOES ACTING ON THIS MOVE VALUE? It decides whether a grant is involved at all.
   *
   * Declared here rather than inferred from the action's name, because the gate has to know
   * BEFORE it can decide whether to demand a hire, an allowance and a venue. Seen from outside,
   * this is the difference between a download and a permission.
   *
   * A read spends nothing, so it needs no grant — no policy, no allowance, no suspension check,
   * no venue allowlist. That is not an optimisation: every one of those bounds SPENDING, and a
   * balance lookup cannot violate any of them. A suspended hire can still read its own balance.
   */
  spends: boolean;
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
        // BOTH DIRECTIONS, and that sentence is now true: the order escrows whichever coin the
        // direction names, the gate accepts both, and the filler picks `settle_a2b` or `settle_b2a`
        // from the order's own type. It used to promise both while nothing called `settle_a2b`, and
        // was corrected to one direction for saying a thing it did not do — so it is corrected back
        // for the same reason, not because the wording was ever wrong.
        title: 'Escrow SUI or USDC and receive the other, filled by whoever takes the order',
        spends: true,
      },
    ],
  },
  {
    // The first genuinely REMOTE talent, and the first that does not move value. It exists to
    // exercise the case the one-to-one model was built for: a capability that lives on somebody
    // else's server, reached over HTTP, with nothing to sign and no grant behind it.
    id: 'http://127.0.0.1:8791',
    name: 'query',
    server: 'http://127.0.0.1:8791',
    description: 'Read balances and objects from the chain. No grant needed — it never moves value.',
    actions: [
      {
        id: 'status',
        // "Read", not "check": what the user gets is a number, and the number is the whole
        // result. There is no transaction behind this one and nothing to approve.
        title: 'Read your SUI and USDC balances',
        spends: false,
      },
    ],
  },
];

/** The entry for an installed id, or null if it is no longer in the list. */
export function talentFor(id: string): MarketplaceTalent | null {
  return MARKETPLACE.find((t) => t.id === id) ?? null;
}

/**
 * Every action the installed talents provide, paired with the talent that provides it.
 *
 * The pairing is the point: an action's spend class and the server it is reached through both
 * belong to its talent, and looking them up separately is how a caller ends up asking one talent
 * about another's action.
 */
export function installedActions(
  installedIds: string[],
): { action: TalentAction; talent: MarketplaceTalent }[] {
  const out: { action: TalentAction; talent: MarketplaceTalent }[] = [];
  for (const id of installedIds) {
    const t = talentFor(id);
    if (!t) continue;
    for (const action of t.actions) out.push({ action, talent: t });
  }
  return out;
}

/**
 * Whether acting on this action moves value, read from the talent that provides it.
 *
 * FAIL-CLOSED, and deliberately: an action NOTHING provides is treated as spending, and so is one
 * two talents provide with disagreement (`some`). The expensive mistake is letting something
 * spend without a grant; the cheap one is demanding a grant for a read. Only a talent saying so
 * in as many words takes an action off the money path.
 */
export function actionSpends(installedIds: string[], actionId: string): boolean {
  const found = installedActions(installedIds).filter((a) => a.action.id === actionId);
  if (!found.length) return true;
  return found.some((a) => a.action.spends);
}

/** The server an action is reached through, or null when nothing installed provides it. */
export function serverForAction(installedIds: string[], actionId: string): string | null {
  return installedActions(installedIds).find((a) => a.action.id === actionId)?.talent.server ?? null;
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
  const actions = installedActions(installedIds).map((a) => a.action);
  return {
    actions,
    text: actions.map((a) => `- ${a.id}: ${a.title}`).join('\n'),
  };
}
