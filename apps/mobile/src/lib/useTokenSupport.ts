// Which stablecoins Paycrest and ChainRails support on each chain.
// Starts on the shared fallback (so pickers never flash empty) and swaps in the
// live list from the backend's /api/tokens once it loads. Fetched once per app
// session. Mirrors apps/web/src/hooks/useTokenSupport.ts.
import { useEffect, useState } from "react";
import {
  TOKEN_SUPPORT_FALLBACK,
  type TokenSupport,
} from "@railglide/shared/tokenSupport";
import type { ChainId } from "@/config/network";
import { paycrestNetworkSlug } from "@/rails/paycrest";
import { apiFetch } from "@/api/client";

let cache: TokenSupport | null = null;

export function useTokenSupport() {
  const [support, setSupport] = useState<TokenSupport>(
    cache ?? TOKEN_SUPPORT_FALLBACK
  );

  useEffect(() => {
    if (cache) return;
    let cancelled = false;
    apiFetch<TokenSupport>("/api/tokens")
      .then((data) => {
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
