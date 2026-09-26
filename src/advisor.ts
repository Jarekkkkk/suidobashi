/* Advisor-only route discovery.
 *
 * Read-only. Nothing here signs, spends, or holds authority: the output is
 * information handed to the agent as advice, and execution still happens inside
 * `policy::swap_and_route` against an allowlisted Cetus CLMM pool.
 *
 * Two filters matter, and both exist because the unfiltered answer was usable
 * only as a warning:
 *
 *  1. Providers pinned to Cetus. Advice we cannot execute is noise, since our
 *     module only knows how to trade Cetus CLMM pools. (The SDK exports the
 *     provider name as a constant — passing a lowercase string silently does
 *     nothing and returns routes across every DEX.)
 *
 *  2. A deviation ceiling. The aggregator's own `deviationRatio` compares its
 *     quote against a reference market price. A route quoted far off market is
 *     not a bargain, it is a signal that the price is not real — typically
 *     multi-hop routes through thin tokens. Acting on one would produce a bad
 *     fill. Above the ceiling we refuse to recommend anything.
 *
 * Usage: node src/advisor.js [amountIn] [direction]
 */
import 'dotenv/config';
// The coin types and the trailing-segment comparison both come from addresses.ts. They used to be
// duplicated here, which is how a comparison rule ends up applied in one place and not another.
import { DIRECTIONS, shortCoinType, type Direction } from './addresses.js';

/**
 * WHICH WAY, as the second argument. Defaulting to SUI -> USDC keeps every existing caller working
 * — it is what the one direction used to mean.
 */
const DIRECTION = (process.argv[3] ?? 'SUI->USDC') as Direction;
const DIR = DIRECTIONS[DIRECTION];
if (!DIR) {
  console.error(
    `direction must be one of ${Object.keys(DIRECTIONS).join(', ')}, not "${process.argv[3]}"`,
  );
  process.exit(2);
}

/**
 * 0.5 of the INPUT coin, so asking for a quote is cheap.
 *
 * `AMOUNT_MIST` was the old name and it defaulted to 500000000 — 0.5 SUI, which would be 500 SUI if
 * it were read as USDC units. Deriving it from the direction's decimals makes the default mean half
 * a coin in either direction instead of silently meaning half a billion of something else.
 */
const AMOUNT_IN = BigInt(process.argv[2] ?? String(10n ** BigInt(DIR.in.decimals) / 2n));
const MAX_DEVIATION = 0.02; // 2% off reference market — refuse beyond this

async function main() {
  const { AggregatorClient, getProvidersIncluding, CETUS } =
    await import('@cetusprotocol/aggregator-sdk');
  // bn.js ships no types. The aggregator's SDK takes its values, so this is the one
  // place the shape is genuinely unknown and a cast is the honest answer.
  const BN = ((await import('bn.js')) as any).default;

  const client = new AggregatorClient({});

  const res = await client.findRouters({
    from: DIR.in.type,
    target: DIR.out.type,
    amount: new BN(AMOUNT_IN.toString()),
    byAmountIn: true,
    providers: getProvidersIncluding([CETUS]),
  });

  if (!res) throw new Error('no route returned');

  const paths = res.paths ?? [];
  const deviation = res.deviationRatio != null ? Number(res.deviationRatio) : null;

  // Only a direct single-hop path IN THIS DIRECTION is executable by our module: one pool, no
  // intermediate tokens. The direction is the caller's now, so this compares against it rather than
  // against the pair that used to be the only one.
  const direct = paths.find(
    (p) => shortCoinType(p.from) === shortCoinType(DIR.in.type)
      && shortCoinType(p.target) === shortCoinType(DIR.out.type),
  );

  const admissible = deviation == null || deviation <= MAX_DEVIATION;

  console.log(JSON.stringify({
    mode: 'advisor',
    pair: `${DIR.in.symbol} -> ${DIR.out.symbol}`,
    amountIn: String(res.amountIn ?? AMOUNT_IN),
    quoteAmountOut: String(res.amountOut ?? ''),
    deviationRatio: deviation,
    deviationCeiling: MAX_DEVIATION,
    admissible,
    providersUsed: [...new Set(paths.map((p) => p.provider))],
    pathCount: paths.length,
    directPathFound: Boolean(direct),
  }, null, 2));

  if (!admissible) {
    console.log('\nREFUSED: quote is off reference market beyond the ceiling. Not recommending a route.');
    process.exit(2);
  }

  if (!direct) {
    console.log(`\nNo direct ${DIR.in.symbol} -> ${DIR.out.symbol} Cetus CLMM path. `
      + 'Our module cannot execute a multi-hop route.');
    process.exit(3);
  }

  console.log('\nRECOMMENDATION (advice only — execution is a separate, allowlisted step):');
  console.log(JSON.stringify({
    poolId: direct.id,
    a2b: direct.direction,
    amountIn: String(direct.amountIn),
    expectedAmountOut: String(direct.amountOut),
    feeRate: direct.feeRate,
    provider: direct.provider,
  }, null, 2));
}

main().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});
