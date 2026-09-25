/* The browser side of signing.
 *
 * Exposed to the page as `window.agentWallet`. Deliberately narrow: list wallets,
 * connect, read the address, and sign already-built bytes. It cannot build a
 * transaction, cannot execute one, and never touches key material — the wallet
 * extension owns the key and shows its own approval prompt.
 *
 * Why the signature is separated from submission: the server builds the bytes and
 * keeps them, the browser returns *only a signature*. So a stale tab or a tampered
 * page cannot swap in different bytes — the signature simply would not verify
 * against what the server built. The page never gets to say what was signed.
 *
 * Built into a single local file by `bun run build:web`; nothing is fetched from a
 * CDN, because a local-first tool that pulls its wallet code off the internet at
 * page load has given back the property it was selling.
 */
import { createDAppKit } from '@mysten/dapp-kit-core';
import { SuiGrpcClient } from '@mysten/sui/grpc';

const GRPC_URLS = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
};

const dAppKit = createDAppKit({
  networks: ['mainnet'],
  defaultNetwork: 'mainnet',
  createClient: (network) => new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network] }),
  // Left at its default: Slush is a first-class wallet here, so no extra
  // initializer is needed to make it appear.
});

/** Current connected address, or null. */
function currentAddress() {
  const c = dAppKit.stores.$connection.get();
  return c?.isConnected ? c.account.address : null;
}

window.agentWallet = {
  /** Wallets the extension(s) have registered, as {name} only — no objects leak out. */
  listWallets() {
    return dAppKit.stores.$wallets.get().map((w) => ({ name: w.name }));
  },

  /** Ask a wallet to connect. Returns the authorised address, or throws. */
  async connect(name) {
    const wallets = dAppKit.stores.$wallets.get();
    const wallet = name
      ? wallets.find((w) => String(w.name).toLowerCase().includes(String(name).toLowerCase()))
      : wallets[0];
    if (!wallet) {
      throw new Error(
        `no wallet matching "${name}" — found: ${wallets.map((w) => w.name).join(', ') || 'none'}`,
      );
    }
    const { accounts } = await dAppKit.connectWallet({ wallet });
    if (!accounts?.length) throw new Error('wallet returned no accounts');
    return accounts[0].address;
  },

  async disconnect() {
    await dAppKit.disconnectWallet();
  },

  address: currentAddress,

  /** Subscribe to connection changes. Returns an unsubscribe function. */
  onChange(cb) {
    return dAppKit.stores.$connection.subscribe((c) => {
      cb(c?.isConnected ? c.account.address : null);
    });
  },

  /**
   * Sign already-built transaction bytes. Returns the signature only — the caller
   * keeps the bytes and submits them itself, so the browser cannot substitute a
   * different transaction.
   */
  async sign(txBytesBase64) {
    if (!currentAddress()) throw new Error('no wallet connected');
    const { signature } = await dAppKit.signTransaction({ transaction: txBytesBase64 });
    if (!signature) throw new Error('wallet returned no signature');
    return { signature };
  },
};
