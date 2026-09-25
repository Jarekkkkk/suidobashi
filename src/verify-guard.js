/*
 * Checks for src/guard-id.js, run against real mainnet data.
 *
 * Two things here are worth this much care. Reading the guard out of a create
 * transaction's effects is easy to get quietly wrong, because a create writes other
 * created objects too — including, on a fresh pool, a second shared object. And
 * adopting the guard rewrites src/addresses.js, which holds every deployed id in the
 * project: the failure mode is not a test going red, it is a config file that is
 * half-updated and no longer says where anything is.
 *
 * The transaction below is the real one, trimmed to the fields this code reads:
 *
 *   DjHVRm4irU5wvgctVW16rXCXechZPRrPEUMMJzyahbG1
 *
 *   bun run src/verify-guard.js
 */
import fs from 'node:fs';
import { findCreatedGuard, repointAddresses } from './guard-id.js';

const GUARD_ID = '0x8e536b0631b885f8cc3c9b2aaf5c4700b583abea79a09ec6f7cbb8029327cb18';
const GUARD_SHARED_VERSION = 1017413662;
const POOL_ID = '0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab';
const POOL_SHARED_VERSION = 376543995;

const POSITION_GUARD_TYPE =
  '0xbaf5205c0e5b8aeea6117a31e9b5e47af73e220ed58f32c2256f0e708cb2db9f'
  + '::position_guard::PositionGuard<0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7'
  + '::usdc::USDC,0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>';
const POOL_TYPE =
  '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb'
  + '::pool::Pool<0x2::sui::SUI,0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC>';

const sender = '0x0b3fc768f8bb3c772321e3e7781cac4a45585b4bc64043686beb634d65341798';

/** The real objectChanges, in the order the CLI returns them. */
const realTxBlock = {
  digest: 'DjHVRm4irU5wvgctVW16rXCXechZPRrPEUMMJzyahbG1',
  objectChanges: [
    { type: 'mutated', sender, owner: { ObjectOwner: '0x0bad9ea1bcb68c4ac3eb71819639360906392047f5fcd1675902cbb84d6157e8' }, objectType: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::PositionInfo', objectId: '0x1183079ba61c830b462a090b6ed911cb818a2ca09a484b623116a144394ecfea' },
    { type: 'created', sender, owner: { ObjectOwner: '0x8e536b0631b885f8cc3c9b2aaf5c4700b583abea79a09ec6f7cbb8029327cb18' }, objectType: '0x2::dynamic_field::Field<0x2::object::ID,0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::PositionInfo>', objectId: '0x11dfb38f6e005b40ee1a1f32a84bdd80d591a25f5461830d138dc7fec0ff8f32' },
    // The pool: shared, and the same package prefix as the position. Matching on
    // "a shared object" rather than on the type lands here.
    { type: 'mutated', sender, owner: { Shared: { initial_shared_version: POOL_SHARED_VERSION } }, objectType: POOL_TYPE, objectId: POOL_ID },
    { type: 'created', sender, owner: { ObjectOwner: '0x11dfb38f6e005b40ee1a1f32a84bdd80d591a25f5461830d138dc7fec0ff8f32' }, objectType: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::Position', objectId: '0x554e85af3500afd7d8c638400093e56405ecbd6044e1090670ac1d73f367f210' },
    { type: 'mutated', sender, owner: { AddressOwner: sender }, objectType: '0x2441fb74d7684f43019fdabf27d6de24dc8e42826ddd86ba07bc21aded80c014::policy::OwnerCap', objectId: '0x7150c87b41ba35e8841acc0ab146ba7f0dbb6dd032d4a15860b1f7c641953372' },
    // The guard. The only entry that is created, shared, and a PositionGuard.
    { type: 'created', sender, owner: { Shared: { initial_shared_version: GUARD_SHARED_VERSION } }, objectType: POSITION_GUARD_TYPE, objectId: GUARD_ID },
    { type: 'created', sender, owner: { ObjectOwner: '0x0bad9ea1bcb68c4ac3eb71819639360906392047f5fcd1675902cbb84d6157e8' }, objectType: '0x2::dynamic_field::Field<0x2::object::ID,0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::PositionInfo>', objectId: '0xd7544e066c12e0e7d74414d56d42192a53a05a4efa2bcba5e9f8f22e6a0cbace' },
  ],
};

const withoutGuard = (mutate) => ({
  ...realTxBlock,
  objectChanges: realTxBlock.objectChanges
    .filter((c) => !c.objectType.includes('::position_guard::PositionGuard'))
    .map(mutate ?? ((c) => c)),
});

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures += 1;
  console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
};

// === reading the guard out of the transaction ===

const found = findCreatedGuard(realTxBlock);
check('finds the guard in the real transaction', found.id === GUARD_ID, JSON.stringify(found));
check('finds its shared version', found.version === GUARD_SHARED_VERSION, JSON.stringify(found));
check('does not mistake the pool for the guard', found.id !== POOL_ID, JSON.stringify(found));

check('no guard in the transaction is an error, not a wrong pick',
  Boolean(findCreatedGuard(withoutGuard()).error), JSON.stringify(findCreatedGuard(withoutGuard())));

// A guard present but not created: a later transaction mutates the guard, and adopting
// one of those would record an id that a subsequent create has already replaced.
check('a mutated guard is not adopted',
  Boolean(findCreatedGuard(withoutGuard((c) => ({ ...c, type: 'mutated' }))).error),
  JSON.stringify(findCreatedGuard(withoutGuard((c) => ({ ...c, type: 'mutated' })))));

// Created and correctly typed, but with no shared version. The id alone is useless:
// every later call needs the pair, so adopting this would be worse than failing.
check('a guard with no shared version is refused',
  Boolean(findCreatedGuard(withoutGuard((c) => ({ ...c, owner: { ObjectOwner: sender } }))).error),
  JSON.stringify(findCreatedGuard(withoutGuard((c) => ({ ...c, owner: { ObjectOwner: sender } })))));

check('a malformed object id is refused',
  Boolean(findCreatedGuard(withoutGuard((c) => ({ ...c, objectId: '0xdeadbeef' }))).error),
  JSON.stringify(findCreatedGuard(withoutGuard((c) => ({ ...c, objectId: '0xdeadbeef' })))));

check('a document with no objectChanges is an error',
  Boolean(findCreatedGuard({}).error), JSON.stringify(findCreatedGuard({})));
check('a null document is an error, not a throw', Boolean(findCreatedGuard(null).error));

// === rewriting the config ===

const realSource = fs.readFileSync('src/addresses.js', 'utf8');
const NEW_ID = `0x${'ab'.repeat(32)}`;

const rewritten = repointAddresses(realSource, NEW_ID, 4242);
check('rewrites the config for a new guard', typeof rewritten === 'string' && rewritten !== realSource);
check('the new id is present', rewritten.includes(NEW_ID), String(rewritten).slice(0, 200));
check('the new shared version is present', rewritten.includes('GUARD_SHARED_VERSION = 4242'));
check('the old id is gone', !rewritten.includes(GUARD_ID));

// Everything else in a file full of deployed ids must survive untouched.
check('nothing else in the file changes',
  rewritten.replace(/export const GUARD_ID\s*=\s*'[0-9a-fx]+'/, '')
    .replace(/export const GUARD_SHARED_VERSION = \d+/, '')
    === realSource.replace(/export const GUARD_ID\s*=\s*'[0-9a-fx]+'/, '')
      .replace(/export const GUARD_SHARED_VERSION = \d+/, ''));

// Refuse rather than half-write. Each of these must return null so nothing is written.
check('a source without GUARD_ID returns null', repointAddresses('const x = 1;\n', NEW_ID, 4242) === null);
check('a malformed id returns null', repointAddresses(realSource, '0xnothex', 4242) === null);
check('a non-integer version returns null', repointAddresses(realSource, NEW_ID, '4242') === null);
check('a missing version returns null', repointAddresses(realSource, NEW_ID, undefined) === null);

// A property, not a snapshot. Repoint a COPY to the fixture guard first, then repoint
// again: the second call must do nothing. The first version of this check repointed the
// live file straight at the fixture guard and expected null, which stopped being true the
// moment a new guard was created -- so it went red while nothing was wrong.
const pointed = repointAddresses(realSource, GUARD_ID, GUARD_SHARED_VERSION);
check('repointing to a value already present is a no-op',
  typeof pointed === 'string' && repointAddresses(pointed, GUARD_ID, GUARD_SHARED_VERSION) === null,
  `first repoint returned ${pointed === null ? 'null' : 'a string'}`);

// The config must be WELL-FORMED, which is what the scripts depend on. It deliberately
// does NOT assert that addresses.js names the guard from the fixture transaction: the
// config advances every time a position is opened, so asserting a snapshot turns this
// check into a false alarm on a correct system. Asserting a property is what is wanted.
const idLine = realSource.match(/export const GUARD_ID\s*=\s*'([0-9a-fx]+)'/);
const verLine = realSource.match(/export const GUARD_SHARED_VERSION\s*=\s*(\d+)/);
check('addresses.js declares a well-formed guard id',
  Boolean(idLine) && /^0x[0-9a-f]{64}$/.test(idLine[1]), idLine ? idLine[1] : 'no GUARD_ID found');
check('addresses.js declares a numeric guard shared version',
  Boolean(verLine) && Number.isInteger(Number(verLine[1])), verLine ? verLine[1] : 'none');
const live = findCreatedGuard(realTxBlock);
check('the fixture transaction still parses as a guard',
  live.id === GUARD_ID && live.version === GUARD_SHARED_VERSION, JSON.stringify(live));

// === the code that runs is the code that is tested ===
//
// This is the check that would have caught the real mistake here. The first version of
// the adoption code kept its own copy of both of these functions inside src/ui.js, so
// every check above tested a module that nothing ran, while the code that actually ran
// was untested -- and the two had already drifted apart on a CLI spelling. A test that
// exercises a copy is worse than no test, because it reports green.
const uiSource = fs.readFileSync('src/ui.js', 'utf8');
check('the server imports this module instead of keeping its own copy',
  uiSource.includes("from './guard-id.js'"), 'src/ui.js does not import src/guard-id.js');
check('the server does not search the transaction itself any more',
  !/position_guard::PositionGuard/.test(uiSource),
  'src/ui.js still contains its own guard lookup');
check('the server does not rewrite the config itself any more',
  !uiSource.includes('GUARD_SHARED_VERSION = '),
  'src/ui.js still contains its own config rewrite');

// The contract that made src/web/page.js crash: a failure has an `error` and no `id`,
// so a caller that reads `.id` unconditionally throws on the failure path. Kept explicit
// so the shape cannot quietly change to something the page does not expect.
const failure = findCreatedGuard({});
check('a failure carries an error and no id for callers to trip over',
  typeof failure.error === 'string' && failure.id === undefined, JSON.stringify(failure));

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('guard id: all checks passed');
