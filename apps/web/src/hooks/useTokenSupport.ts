"use client";

import { useEffect, useState } from "react";
import type { ChainId } from "@/config/network";
import { paycrestNetworkSlug } from "@/rails/paycrest";
import {
  TOKEN_SUPPORT_FALLBACK,
  type TokenSupport,
} from "@/rails/tokenSupport";

let cache: TokenSupport | null = null;

/**
 * Which stablecoins Paycrest and ChainRails support on each chain. Starts on
 * the built-in fallback (so pickers never flash empty) and swaps in the live
 * list from /api/tokens once it loads. Fetched once per page load.
 */
export function useTokenSupport() {
  const [support, setSupport] = useState<TokenSupport>(
    cache ?? TOKEN_SUPPORT_FALLBACK
  );

  useEffect(() => {
    if (cache) return;
    let cancelled = false;
    fetch("/api/tokens")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: TokenSupport | null) => {
        if (!data?.paycrest || !data?.chainrails) return;
        cache = data;
        if (!cancelled) setSupport(data);
      })
      .catch(() => {
        // Keep the fallback.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    /** Paycrest supports this token on our chain. */
    paycrest: (chainId: ChainId, token: string) => {
      const slug = paycrestNetworkSlug(chainId);
      return !!slug && (support.paycrest[slug] ?? []).some((t) => t === token);
    },
    /** ChainRails supports this token on its chain (e.g. "TRON_MAINNET"). */
    chainrails: (chainrailsChain: string, token: string) =>
      (support.chainrails[chainrailsChain] ?? []).some((t) => t === token),
  };
}
