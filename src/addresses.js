/* Deployed mainnet addresses. Single source of truth so nothing depends on
 * terminal scrollback.
 *
 * The Vault's address IS its object ID: `object::id_address` is a direct cast
 * of the UID's inner bytes, not a hash. That is why the balance-change address
 * and the object ID are the same string.
 */

/**
 * The package id EVERY module call uses.
 *
 * One id, deliberately. Each upgrade publishes a separate package object, and a call
 * runs the bytecode of the id it names -- so calling an older id runs older logic.
 * That is not theoretical here: `swap_and_route` gained a slippage bound in version
 * 4, and a caller still pointing at version 1 runs the unbounded body and never
 * consults it. One constant removes the choice.
 *
 * Earlier ids are deliberately NOT exported. They are dead, and a stale reference to
 * one is a silent downgrade rather than an error. The history lives in
 * move/Published.toml (`original-id` plus the version chain) and in NOTES.md.
 *
 *   v1  0x2441fb74…  original — object TYPES still bind to this id
 *   v2  0xbaf5205c…  added position_guard
 *   v3  0x0517705e…  added the reward-aware variants
 *   v4  0x859e239f…  slippage bound + idempotent set_pool_allowed
 *   v5  0x9167a804…  added `order` — escrowed swaps with a maker-committed minimum
 *   v6  0x70b9289c…  a settled order survives, so its storage can be reclaimed
 *
 * Object types keep their original-id identity across upgrades, so an OwnerCap
 * minted before any of this still matches the newest code.
 */
export const PACKAGE_LATEST_ID =
  '0x70b9289cda382fb636ad75cb166e99b80102a5c91a8fce336fbb21e5154eea8b';

/**
 * The UpgradeCap, for running an upgrade from the CLI. Not referenced by any code
 * path: no script should ever hold it.
 */
export const UPGRADE_CAP_ID =
  '0x50a57fce03614745395e2a9e1aac204cfd0f7979532106669066283898b97ec9';

/** The pinned SUI/USDC pool's tick spacing — ranges must be aligned to it. */
export const POOL_TICK_SPACING = 10;

/**
 * Cetus's rewarder vault (type `rewarder::RewarderGlobalVault`), required by
 * `collect_reward`. Holds reward emissions in a Bag. Created at package init, so
 * the address comes from Cetus's own mainnet `clmmConfig.global_vault_id` rather
 * than from any on-chain lookup path.
 *
 * It matters because this pool streams CETUS to LPs, and `close_position`
 * refuses while any reward is owed.
 */
export const REWARDER_VAULT_ID =
  '0xce7bceef26d3ad1f6d9b6f13a953f053e6ed3ca77907516481ce99ae8e588f2b';
export const REWARDER_VAULT_SHARED_VERSION = 1574190;

/** The pool's single reward coin, read from the pool's rewarder_manager. */
export const REWARD_TYPE =
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS';

/** Shared. Holds the funds as an object-owned address balance. */
export const VAULT_ID =
  '0x153bb450c5bbb06c4587f95eec2b14f81cd6163792d43b59175a6df6504c2d42';

/** Owned by the deployer. The single admin credential for vault and policy. */
export const OWNER_CAP_ID =
  '0x7150c87b41ba35e8841acc0ab146ba7f0dbb6dd032d4a15860b1f7c641953372';

/** Owned by the deployer until phase B embeds it into the Policy. */
export const SPENDER_CAP_ID =
  '0x21b3bb053c65eed825cd7acb80417dd11dd437e057c3c056a5fab789b4c00580';

/**
 * Shared purpose gate. After phase B the SpenderCap is owned by this object,
 * so no external party holds spend authority — it is reachable only through the
 * module's sender-gated paths.
 */
export const POLICY_ID =
  '0x8a68c6ebb9aab5ef378c51172a88b23c3cad51ec62b8b7c96ab847a5f9f820c0';

// === Hire B — a second grant on the same vault, no new contracts needed ===
//
// A policy *is* a grant, so a second policy is a second hire: its own cap, its
// own budget, its own venue allowlist, its own agent. Both draw on one vault.
// Note its `allowed_pools` starts empty — fail-closed — so a new hire cannot
// trade until the owner opens a venue for it explicitly.
export const HIRE_B_CAP_ID =
  '0x3dc65a1020c2123f590fe330d815888b7aca2545be325018daba26fbd0e4421a';
export const HIRE_B_POLICY_ID =
  '0xb6834527ba04c81915d320990a96d66e6931b541276b372a206917e3d35f1d7d';
export const HIRE_B_POLICY_SHARED_VERSION = 1013000096;

/**
 * Shared versions are per-object, set when the object is shared — they are NOT
 * all 1. Passing the wrong one is rejected as "not a shared object".
 *   Vault  1           (observed)
 *   Policy 963323800   (version at which phase B shared hire A)
 *   Clock  1           (genesis)
 */
export const VAULT_SHARED_VERSION = 1;
/** Hire A's policy (the one POLICY_ID names). Hire B has its own, above. */
export const POLICY_SHARED_VERSION = 963323800;
export const CLOCK_SHARED_VERSION = 1;

export const CLOCK_ID = '0x6';
export const SUI_TYPE = '0x2::sui::SUI';

export const USDC_TYPE =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

/**
 * Cetus CLMM SUI/USDC pool recommended by the aggregator advisor.
 * Object type is `Pool<USDC, SUI>` — so A=USDC, B=SUI, and a SUI→USDC swap is
 * `a2b = false`. Fee 0.05%.
 *
 * Note the aggregator's advice is non-deterministic between calls (it randomises
 * split optimisation), which is why the pool is pinned here rather than chosen
 * per transaction.
 */
export const POOL_ID =
  '0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab';
export const POOL_SHARED_VERSION = 376543995;

/**
 * A second direct SUI/USDC pool on the same Cetus deployment, at a different fee
 * tier: 0.01% versus the one above at 0.05%. Same `Pool<USDC, SUI>` type, so it
 * needs no type-argument change — which makes it usable as a genuinely different
 * *venue* for a different hire, rather than a second name for the same thing.
 */
export const POOL_ALT_ID =
  '0x413ddc5745aa6398e9da66c4843947e479f4bf63bade39ffc94c9197b433b332';
export const POOL_ALT_SHARED_VERSION = 415321657;

/**
 * Cetus CLMM GlobalConfig (type `cetus_clmm::config::GlobalConfig`), required by
 * `flash_swap` / `repay_flash_swap`. Not to be confused with the per-DEX config
 * objects the aggregator SDK also carries — this is the CLMM one.
 */
export const GLOBAL_CONFIG_ID =
  '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f';
export const GLOBAL_CONFIG_SHARED_VERSION = 1574190;

/** Swap size: the whole vault balance, so the existing funds fund the demo. */
export const SWAP_AMOUNT_MIST = 20_000_000n;

/**
 * The CURRENT position guard (version-2 module).
 *
 * This is not stable, and that is the point: every `create` mints a brand-new guard,
 * and `redeem` leaves the old one permanently empty because the position is a dynamic
 * object field with no way to put one back. So after opening a position, these two
 * values have to be re-pointed from that transaction's effects — the guard id is
 * generated on the validator and cannot be predicted here.
 *
 * Pointing these at a guard that has been exited is the failure you will actually
 * hit: deposit, rebalance and redeem all build against this id, and an empty guard
 * fails with `borrow_child_object` abort code 1, which reads like "you forgot to
 * open a position" even when you did not.
 */
export const GUARD_ID =
  '0x62ced3a9785fb75a8f4188b1da311ab1975fbad9c585069b71d05cf649ba3754';
export const GUARD_SHARED_VERSION = 1017706391;

/**
 * The Cetus position currently inside that guard. Informational: nothing reads it.
 * The authoritative location is the guard's dynamic object field, which is what the
 * module operates on — this copy goes stale the moment a position is exited, and a
 * stale value proves nothing either way.
 */
export const POSITION_ID =
  '0x554e85af3500afd7d8c638400093e56405ecbd6044e1090670ac1d73f367f210';

/** Tick range of the guard's position, and the bounds the agent is held to. */
export const TICK_LOWER = 68_460;
export const TICK_UPPER = 69_460;
export const MIN_TICK_WIDTH = 100;
export const MAX_TICK_WIDTH = 2_000;

/** Slippage bound for the price limit, in basis points of the current price. */
export const SLIPPAGE_BPS = 100n; // 1%

export const DEPLOYER =
  '0x0b3fc768f8bb3c772321e3e7781cac4a45585b4bc64043686beb634d65341798';
