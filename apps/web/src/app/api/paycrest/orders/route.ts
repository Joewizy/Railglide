import { NextRequest, NextResponse } from "next/server";
import {
  PAYCREST_BASE_URL,
  isPaycrestConfigured,
  orderMatchesWallet,
  summarizePaycrestOrderForHistory,
  type PaycrestHistoryOrder,
} from "@/rails/paycrest";
import { getSession } from "@/lib/session";

/**
 * GET /api/paycrest/orders
 *
 * Lists the authenticated wallet's Paycrest orders so History can show live
 * status. The wallet is taken from a verified SIWE session — never from a
 * query param — because a wallet address is public on-chain data and proves
 * nothing about who is asking. Proxies Paycrest's v2 sender orders list
 * (server-only API key) and filters to orders tied to this wallet (refund
 * address on off-ramp, crypto recipient on on-ramp).
 */

export async function GET(req: NextRequest) {
  const session = getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const address = session.address;

  const apiKey = process.env.PAYCREST_API_KEY;
  if (!isPaycrestConfigured() || !apiKey) {
    return NextResponse.json(
      { error: "Order history isn't available right now." },
      { status: 501 }
    );
  }

  // Paycrest returns at most 100 orders per page, and the account holds every
  // user's orders — so walk the pages (capped) instead of reading only page 1.
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  const list: Record<string, unknown>[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetch(
        `${PAYCREST_BASE_URL}/v2/sender/orders?page=${page}&pageSize=${PAGE_SIZE}`,
        { headers: { "API-Key": apiKey, Accept: "application/json" } }
      );
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Request failed",
        },
        { status: 502 }
      );
    }

    const raw: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`[paycrest] order list failed (${res.status})`, raw);
      return NextResponse.json(
        { error: `Couldn't load orders (${res.status}).` },
        { status: 502 }
      );
    }

    const data =
      raw && typeof raw === "object"
        ? ((raw as Record<string, unknown>).data as Record<string, unknown>)
        : null;
    const orders = Array.isArray(data?.orders)
      ? (data.orders as Record<string, unknown>[])
      : [];
    list.push(...orders);
    const total = Number(data?.total ?? 0);
    if (orders.length < PAGE_SIZE || (total && list.length >= total)) break;
  }

  const orders: PaycrestHistoryOrder[] = list
    .filter((o) => orderMatchesWallet(o, address))
    .map((o) => summarizePaycrestOrderForHistory(o))
    .sort((a, b) => {
      const aExpired = a.status === "expired" ? 1 : 0;
      const bExpired = b.status === "expired" ? 1 : 0;
      if (aExpired !== bExpired) return aExpired - bExpired;
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });

  return NextResponse.json({ orders, address });
}
