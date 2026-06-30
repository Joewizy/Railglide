/**
 * Solana balance lookups for the Relay SVM wallet, read straight from the
 * web3.js Connection — no third-party balance API.
 *
 * Relay's SwapWidget reads SVM balances via the adapter's `getBalance` when it
 * exists (see useCurrencyBalance: `adaptedWalletBalanceIsEnabled`), otherwise it
 * falls back to Dune Sim (which is being sunset). We provide `getBalance` so the
 * RPC is the single source of truth.
 *
 * Contract note: this must resolve a bigint or throw — never resolve
 * `undefined`, which React Query rejects. Throwing surfaces as an error state
 * (balance shows "-") rather than a crash, and crucially does NOT block the
 * swap (the widget's insufficient-balance guard ignores errored balances).
 */
import { Connection, PublicKey } from "@solana/web3.js";

/** Addresses Relay uses for native SOL (all-ones placeholder) and wrapped SOL. */
const NATIVE_SOL_ADDRESSES = new Set([
  "11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
]);

/** Raw on-chain balance (base units) matching AdaptedWallet.getBalance. */
export async function getSolanaBalance(
  connection: Connection,
  walletAddress: string,
  tokenAddress?: string
): Promise<bigint> {
  const owner = new PublicKey(walletAddress);

  if (!tokenAddress || NATIVE_SOL_ADDRESSES.has(tokenAddress)) {
    const lamports = await connection.getBalance(owner);
    return BigInt(lamports);
  }

  const mint = new PublicKey(tokenAddress);
  const { value } = await connection.getParsedTokenAccountsByOwner(
    owner,
    { mint },
    "confirmed"
  );
  let total = 0n;
  for (const { account } of value) {
    const amount = account.data.parsed?.info?.tokenAmount?.amount;
    if (amount) total += BigInt(amount);
  }
  return total;
}
