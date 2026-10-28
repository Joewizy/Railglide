/**
 * RailGlide's Paycrest fee, shared by web and mobile.
 *
 * MUST match the sender fee set in the Paycrest Sender Dashboard — it's used
 * to size orders so the user sends exactly what they typed.
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
