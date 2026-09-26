/*
 * The talents that ship with the app.
 *
 * A TALENT IS A CAPABILITY. Some are served over MCP and installed from a server's manifest;
 * these are built in, and the difference matters because a built-in one is always available and
 * an MCP one is only as good as the address it came from.
 *
 * THE LOCAL MODEL IS STATELESS, so what it can do has to be TOLD to it on every request. That is
 * what this registry is for: the agent's prompt is assembled from the talents that are available
 * rather than being a constant that happens to describe swapping. Before this, the model was
 * told about one capability because one capability existed.
 *
 * ONLY WHAT WORKS IS DECLARED. A talent that lists an action it cannot perform is worse than one
 * that lists nothing — the prompt would promise it, the model would offer it, and the refusal
 * would arrive from somewhere the user cannot see. So the query talent is NOT here yet: it is
 * designed and not written, and it gets an entry the day it answers.
 */

export type TalentAction = {
  id: string;
  /** One line, phrased as what the user gets. This is what the model is told it can do. */
  title: string;
};

export type BuiltInTalent = {
  id: string;
  name: string;
  kind: 'built-in';
  actions: TalentAction[];
};

export const BUILT_IN_TALENTS: BuiltInTalent[] = [
  {
    id: 'built-in:swap',
    name: 'swap',
    kind: 'built-in',
    actions: [
      {
        id: 'swap',
        title: 'Swap SUI for USDC, or USDC for SUI, through an escrowed order',
      },
    ],
  },
  {
    // Provisioning, not trading. It needs its own on-chain grant and its own guard, and it is
    // separate from swap because the two have nothing to do with each other: a hire that may
    // swap has no business opening positions unless the owner said so.
    id: 'built-in:position',
    name: 'position',
    kind: 'built-in',
    actions: [
      { id: 'deposit_liquidity', title: 'Add liquidity to the guarded position' },
      { id: 'rebalance', title: 'Move the guarded position into a new tick range' },
      { id: 'redeem', title: 'Exit the guarded position and take everything back' },
    ],
  },
  {
    id: 'built-in:status',
    name: 'status',
    kind: 'built-in',
    actions: [
      { id: 'status', title: 'Report what the wallet and the guarded position hold' },
    ],
  },
];

/**
 * The action ids the model may choose from.
 *
 * Derived from the registry rather than written into the prompt, which is the whole point: the
 * prompt said `swap, deposit_liquidity, rebalance, redeem, status` while nothing checked that
 * against what the code could actually plan. Two lists, one of them in a string.
 */
export const ACTION_IDS = BUILT_IN_TALENTS.flatMap((t) => t.actions.map((a) => a.id));

/**
 * What the agent may tell the user it can do.
 *
 * Assembled from the talents rather than written out, so adding one is adding an entry rather
 * than editing a prompt in two places and hoping they agree. A prompt that disagrees with the
 * code is the same class of bug as a `.d.ts` that disagrees with its implementation.
 */
export function describeTalents(talents: { name: string; actions: TalentAction[] }[]): string {
  const lines: string[] = [];
  for (const t of talents) {
    for (const a of t.actions) {
      lines.push(`- ${a.id} (${t.name}): ${a.title}`);
    }
  }
  return lines.join('\n');
}
