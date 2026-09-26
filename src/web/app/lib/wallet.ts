/*
 * The wallet bridge, typed.
 *
 * `window.agentWallet` is installed by the separately-built wallet bundle (see
 * src/web/wallet-entry.js) which holds the dApp Kit instance. It is a deliberately narrow
 * surface: it hands out an address and a signature and nothing else, so no wallet object
 * or key material crosses into this app.
 *
 * The declaration below is the contract. If the bundle's shape changes, this file is
 * where the mismatch shows up — at typecheck rather than at the moment a user clicks.
 */
export type AgentWallet = {
  listWallets(): { name: string }[];
  connect(name?: string): Promise<string>;
  disconnect(): Promise<void>;
  address(): string | null;
  onChange(cb: (address: string | null) => void): () => void;
  sign(txBytesBase64: string): Promise<{ signature: string }>;
};

declare global {
  interface Window {
    agentWallet?: AgentWallet;
  }
}

/** The bridge, or null if the wallet bundle has not loaded yet. */
export function wallet(): AgentWallet | null {
  return window.agentWallet ?? null;
}

/** Shorten an address for display: 0x1234…abcd. */
export function short(address: string | null): string {
  if (!address) return '';
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}
