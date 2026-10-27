/**
 * paycrestRate — fetch the live unit rate (fiat per 1 token) for a corridor.
 *
 * Paycrest's rate is amount-independent at these sizes, so we fetch the unit
 * rate once per (currency, token) pair and let the UI compute estimates
 * locally as the user types — no per-keystroke API calls. The exact rate is
 * locked when the order is created; this is only ever an estimate.
 */

import { isPaycrestFiat } from "@/rails/paycrest";
import { cachedFetch } from "./cachedFetch";

/** Current fiat-per-token rate, or null if it can't be fetched. */
export async function fetchPaycrestRate(
  currency: string,
  token: string,
  /** Buy (on-ramp) and Sell (off-ramp) use different rates. */
  side: "buy" | "sell" = "sell"
): Promise<number | null> {
  if (!currency || !token || !isPaycrestFiat(currency)) return null;
  try {
    // Cached for a minute, so switching back to a currency/token is instant.
    const res = await cachedFetch(
      `/api/paycrest/rate?fiat=${encodeURIComponent(currency)}&token=${token}&side=${side}`
    );
    const data = await res.json();
    if (res.ok && data?.rate) {
      const rate = Number(data.rate);
      return Number.isFinite(rate) && rate > 0 ? rate : null;
    }
  } catch {
    // Rate is a nicety — the exact figure comes from the order invoice.
  }
  return null;
}
