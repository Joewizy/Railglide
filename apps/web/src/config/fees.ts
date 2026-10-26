/**
 * Platform fee config.
 *
 * Relay app fees are charged on cross-chain swaps and paid to
 * NEXT_PUBLIC_FEE_RECIPIENT. Relay denominates app fees in basis points
 * (100 bps = 1%), so the default 20 bps = 0.2%. When no recipient is set, no
 * app fee is applied — the swap still works, it just isn't monetised.
 *
 * Paycrest off/on-ramp fees are configured separately (senderFeePercent) in
 * the Paycrest Sender Dashboard, not here.
 *
 * NOTE: NEXT_PUBLIC_* is read via literal access so Next.js inlines it for the
 * client bundle (the Relay widget path). A fee recipient is a public address,
 * so exposing it in the bundle is fine.
 */

const FEE_RECIPIENT = process.env.NEXT_PUBLIC_FEE_RECIPIENT;
/** Relay app fee in basis points. 20 = 0.2%. */
const RELAY_FEE_BPS = process.env.NEXT_PUBLIC_RELAY_FEE_BPS || "20";

export interface RelayAppFee {
  recipient: string;
  fee: string;
}

/**
 * The Relay app-fee array, or undefined when no recipient is configured.
 * Shape matches Relay's /quote `appFees` and RelayKitProvider `options.appFees`.
 */
export function relayAppFees(): RelayAppFee[] | undefined {
  if (!FEE_RECIPIENT) return undefined;
  return [{ recipient: FEE_RECIPIENT, fee: RELAY_FEE_BPS }];
}

/**
 * RailGlide's Paycrest fee, in percent. MUST match the sender fee set in the
 * Paycrest Sender Dashboard — it's used to size orders so the user sends
 * exactly what they typed.
 */
export const PAYCREST_SENDER_FEE_PERCENT = 0.5;

/**
 * The order amount that, with our fee added on top, comes to `total`.
 * Paycrest adds the fee to the order amount (since Oct 2026), so to keep
 * "you sell 800" true we order 800 / 1.005 = 796.02. Rounded down so the
 * total never goes over what the user typed.
 */
export function amountBeforeFee(total: number): number {
  const net = total / (1 + PAYCREST_SENDER_FEE_PERCENT / 100);
  return Math.floor(net * 1e6) / 1e6;
}
