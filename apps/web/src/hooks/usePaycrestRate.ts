"use client";

/**
 * usePaycrestRate — live unit rate (fiat per 1 token) for a fiat corridor.
 *
 * Fetches once per (currency, token) pair and refreshes on a slow timer so the
 * estimate stays roughly current without hammering the API. The UI multiplies
 * this by the typed amount locally for instant feedback; the exact rate locks
 * at order creation.
 *
 * Shared by CashoutFlow and BuyFlow.
 */

import { useEffect, useState } from "react";
import { fetchPaycrestRate } from "@/lib/paycrestRate";

/** Rates drift slowly — a minute is fresh enough for an on-screen estimate. */
const REFRESH_MS = 60_000;

export interface UsePaycrestRateReturn {
  /** Fiat per 1 token, or null until loaded / when unavailable. */
  rate: number | null;
  loading: boolean;
}

export function usePaycrestRate(
  currency: string,
  token: string,
  /** Skip fetching entirely when false — e.g. a non-Paycrest (Chainrails) chain
   *  is selected, so Paycrest's rate is irrelevant and shouldn't be requested. */
  enabled = true,
  /** Buy (on-ramp) and Sell (off-ramp) use different rates. */
  side: "buy" | "sell" = "sell"
): UsePaycrestRateReturn {
  const [rate, setRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setRate(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setRate(null);

    const load = async () => {
      const r = await fetchPaycrestRate(currency, token, side);
      if (cancelled) return;
      setRate(r);
      setLoading(false);
    };

    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [currency, token, enabled, side]);

  return { rate, loading };
}
