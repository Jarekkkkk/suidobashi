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
 * Usage: node src/advisor.js [amountMist]
 */
import 'dotenv/config';

const SUI_TYPE = '0x2::sui::SUI';
// Native USDC on Sui mainnet.
const USDC_TYPE =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

const AMOUNT_MIST = BigInt(process.argv[2] ?? '500000000'); // 0.5 SUI
const MAX_DEVIATION = 0.02; // 2% off reference market — refuse beyond this

/**
 * Compare coin types on their trailing segments only. The aggregator returns
 * SUI in full form (0x000...002::sui::SUI) while our constants use short form,
 * and `normalizeCoinType` does not bridge that — so a naive equality test
 * silently never matches and every route looks multi-hop.
 */
const shortType = (t) => String(t).split('::').slice(-2).join('::');

async function main() {
  const { AggregatorClient, getProvidersIncluding, CETUS } =
    await import('@cetusprotocol/aggregator-sdk');
  const BN = (await import('bn.js')).default;

  const client = new AggregatorClient({});

  const res = await client.findRouters({
    from: SUI_TYPE,
    target: USDC_TYPE,
    amount: new BN(AMOUNT_MIST.toString()),
    byAmountIn: true,
    providers: getProvidersIncluding([CETUS]),
  });

  if (!res) throw new Error('no route returned');

  const paths = res.paths ?? [];
  const deviation = res.deviationRatio != null ? Number(res.deviationRatio) : null;

  // Only a direct single-hop SUI -> USDC path is executable by our module: one
  // pool, one direction, no intermediate tokens.
  const direct = paths.find(
    (p) => shortType(p.from) === shortType(SUI_TYPE)
      && shortType(p.target) === shortType(USDC_TYPE),
  );

  const admissible = deviation == null || deviation <= MAX_DEVIATION;

  console.log(JSON.stringify({
    mode: 'advisor',
    pair: 'SUI -> USDC',
    amountIn: String(res.amountIn ?? AMOUNT_MIST),
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
    console.log('\nNo direct SUI -> USDC Cetus CLMM path. Our module cannot execute a multi-hop route.');
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
