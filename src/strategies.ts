/*
 * The listing for flavor (b): strategies a maker can point a guard at.
 *
 * A strategy here is not code and not an object on chain. It is a description of what an OPERATOR
 * does, plus the address that operator signs as — because that is all a maker needs to decide,
 * given that the guard holds the limits and the operator holds nothing (`set_agent` in
 * `deepbook_guard.move`).
 *
 * Terms are written the way a maker reads them, in whole coins and seconds, not in the raw integers
 * DeepBook wants. `src/deepbook.ts` does the scaling. The one entry is a long grid on SUI/USDC,
 * which is what `src/runner.ts` actually implements, so the listing describes something real rather
 * than something aspirational.
 *
 * Sizes and budget are in SUI, not USDC, and that is not a slip: they are order QUANTITIES, and a
 * quantity on a `Pool<SUI, USDC>` book is base units. A maker reading "5 SUI per level" against a
 * band in USDC is reading the terms that will be enforced.
 */
import { DEPLOYER } from './addresses.js';

export type Strategy = {
  id: string;
  name: string;
  /** The address the operator signs as. Authority over any guard stays with that guard. */
  operator: string;
  summary: string;
  /** The band the runner may quote inside, in USDC per SUI. */
  bandUsdc: { low: number; high: number };
  levels: number;
  /** Order size per level, in SUI. */
  perLevelSui: number;
  /** The ceiling on everything the operator may ever ask for, in SUI. */
  budgetSui: number;
  /** How often the runner looks, in seconds. */
  everySeconds: number;
  /**
   * What it will not do, in its own words. A listing that states only upside is an advert, and the
   * whole point of this design is that a maker can see the edges before handing over the seat.
   */
  willNot: string;
};

export const STRATEGIES: Strategy[] = [
  {
    id: 'sui-usdc-grid',
    name: 'SUI/USDC long grid',
    operator: DEPLOYER,
    summary:
      'Rests five bids inside the band and re-quotes them as the book moves, so the ladder follows the market without ever crossing it.',
    bandUsdc: { low: 0.9, high: 1.1 },
    levels: 5,
    perLevelSui: 0.5,
    budgetSui: 2.5,
    everySeconds: 60,
    willNot:
      'It never sells. Every order it places is a bid, it cancels only bids, and a sell resting on the account is left for the maker to decide about. It also never quotes at or above the best ask, so it pays no taker fee and cannot fill at a price the grid did not choose.',
  },
];
