import { NextResponse } from "next/server";
import {
  CHAINRAILS_TOKENS_FALLBACK,
  CHAINRAILS_TOKEN_CHAINS,
  PAYCREST_TOKENS_FALLBACK,
  onlyStablecoins,
  type ChainrailsTokenMap,
  type PaycrestTokenMap,
  type TokenSupport,
} from "@/rails/tokenSupport";

/**
 * GET /api/tokens — which stablecoins Paycrest and ChainRails support on each
 * chain. Fetched live, kept for an hour, and each provider falls back to the
 * table in rails/tokenSupport.ts if its request fails (errors, 429s, timeouts).
 */

const ONE_HOUR = 60 * 60 * 1000;
let cached: { data: TokenSupport; at: number } | null = null;

async function fetchPaycrest(): Promise<PaycrestTokenMap> {
  const res = await fetch("https://api.paycrest.io/v1/tokens", {
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Paycrest tokens ${res.status}`);
  const body = (await res.json()) as {
    data?: { symbol: string; network: string }[];
  };
  const map: Record<string, string[]> = {};
  for (const t of body.data ?? []) (map[t.network] ??= []).push(t.symbol);
  const result: PaycrestTokenMap = {};
  for (const [network, symbols] of Object.entries(map))
    result[network] = onlyStablecoins(symbols);
  if (!Object.keys(result).length) throw new Error("Paycrest tokens empty");
  return result;
}

async function fetchChainrailsChain(
  apiKey: string,
  chain: string
): Promise<string[]> {
  const res = await fetch(
    `https://api.chainrails.io/api/v1/chains/${chain}/tokens`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    }
  );
  if (!res.ok) throw new Error(`ChainRails tokens ${chain} ${res.status}`);
  const list = (await res.json()) as { symbol: string }[];
  return list.map((t) => t.symbol);
}

async function fetchChainrails(): Promise<ChainrailsTokenMap> {
  const apiKey = process.env.CHAINRAILS_API_KEY;
  if (!apiKey) throw new Error("CHAINRAILS_API_KEY is not set");
  const result: ChainrailsTokenMap = {};
  // One chain failing only falls back for that chain.
  await Promise.all(
    CHAINRAILS_TOKEN_CHAINS.map(async (chain) => {
      try {
        result[chain] = onlyStablecoins(await fetchChainrailsChain(apiKey, chain));
      } catch (err) {
        console.error(`[tokens] ${String(err)} — using fallback`);
        result[chain] = CHAINRAILS_TOKENS_FALLBACK[chain];
      }
    })
  );
  return result;
}

export async function GET() {
  if (cached && Date.now() - cached.at < ONE_HOUR) {
    return NextResponse.json(cached.data);
  }

  const [paycrest, chainrails] = await Promise.all([
    fetchPaycrest().catch((err) => {
      console.error(`[tokens] ${String(err)} — using fallback`);
      return PAYCREST_TOKENS_FALLBACK;
    }),
    fetchChainrails().catch((err) => {
      console.error(`[tokens] ${String(err)} — using fallback`);
      return CHAINRAILS_TOKENS_FALLBACK;
    }),
  ]);

  const data: TokenSupport = { paycrest, chainrails };
  cached = { data, at: Date.now() };
  return NextResponse.json(data);
}
