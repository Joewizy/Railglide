"use client";

import { useEffect, useState } from "react";
import type { RampCountry } from "@/rails/chainrails";
import { cachedFetch, ONE_HOUR } from "@/lib/cachedFetch";

export type RampDirection = "on-ramp" | "off-ramp";

const cache: Partial<Record<RampDirection, RampCountry[]>> = {};

/**
 * ChainRails' live country list. "on-ramp" for Buy; "off-ramp" for Sell, which
 * only includes countries ChainRails can pay out to.
 */
export function useRampCountries(direction: RampDirection) {
  const [countries, setCountries] = useState<RampCountry[]>(
    cache[direction] ?? []
  );
  const [loading, setLoading] = useState(!cache[direction]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Already loaded on this page — don't ask again on every screen.
    if (cache[direction]) return;
    let cancelled = false;
    const query = direction === "off-ramp" ? "?type=off-ramp" : "";
    // cachedFetch also merges screens that mount at the same moment into one call.
    cachedFetch(`/api/chainrails/ramp/countries${query}`, {}, ONE_HOUR)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Couldn't load countries.");
        const next = (data.countries ?? []) as RampCountry[];
        cache[direction] = next;
        if (!cancelled) setCountries(next);
      })
      .catch((err) => {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Couldn't load countries."
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [direction]);

  return { countries, loading, error };
}
