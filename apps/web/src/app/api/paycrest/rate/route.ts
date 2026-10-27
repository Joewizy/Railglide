import { NextRequest, NextResponse } from "next/server";
import { PAYCREST_BASE_URL, isPaycrestFiat } from "@/rails/paycrest";

/**
 * GET /api/paycrest/rate?fiat=NGN&token=USDC&side=buy|sell
 *
 * Returns the current unit rate (fiat per 1 token) for the on-screen estimate.
 * Buy and Sell have different rates (e.g. buy 1,389.98 vs sell 1,374.12 NGN),
 * so `side` picks one from Paycrest's public /v2/rates/:network/:token/:amount/:fiat
 * — "use data.buy.rate for on-ramp, data.sell.rate for off-ramp" (their docs).
 * Sell falls back to the older /v1 endpoint, which only knows the sell rate.
 */
export async function GET(req: NextRequest) {
  const fiat = req.nextUrl.searchParams.get("fiat");
  const token = (req.nextUrl.searchParams.get("token") || "USDC").toUpperCase();

  if (!fiat || !isPaycrestFiat(fiat)) {
    return NextResponse.json(
      { error: `Unsupported currency "${String(fiat)}"` },
      { status: 400 }
    );
  }

  // Allowlist the token rather than interpolating it raw into the upstream
  // path (path injection / constrained SSRF against the keyed Paycrest host).
  if (token !== "USDC" && token !== "USDT") {
    return NextResponse.json(
      { error: `Unsupported token "${token}"` },
      { status: 400 }
    );
  }

  const side = req.nextUrl.searchParams.get("side") === "buy" ? "buy" : "sell";
  const network = req.nextUrl.searchParams.get("network") || "base";
  if (!/^[a-z0-9-]+$/.test(network)) {
    return NextResponse.json({ error: "Invalid network" }, { status: 400 });
  }

  try {
    const v2 = await fetch(
      `${PAYCREST_BASE_URL}/v2/rates/${network}/${token}/100/${fiat.toUpperCase()}?side=${side}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }
    );
    const body = (await v2.json().catch(() => null)) as {
      data?: Record<string, { rate?: string } | undefined>;
    } | null;
    const v2Rate = Number(body?.data?.[side]?.rate);
    if (v2.ok && Number.isFinite(v2Rate) && v2Rate > 0) {
      return NextResponse.json({ rate: v2Rate, fiat: fiat.toUpperCase(), token, side });
    }
    console.error(`[paycrest] v2 ${side} rate failed (${v2.status})`, body);
  } catch (error) {
    console.error(`[paycrest] v2 ${side} rate failed`, error);
  }
  // The v1 endpoint is sell-only, so a buy estimate has nothing to fall back on.
  if (side === "buy") {
    return NextResponse.json({ error: "Couldn't fetch a rate." }, { status: 502 });
  }

  let res: Response;
  try {
    res = await fetch(
      `${PAYCREST_BASE_URL}/v1/rates/${token.toLowerCase()}/1/${fiat.toLowerCase()}`,
      { headers: { Accept: "application/json" } }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Upstream request failed",
      },
      { status: 502 }
    );
  }

  const raw: unknown = await res.json().catch(() => null);
  const data =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).data
      : null;
  const rate = typeof data === "string" ? Number(data) : Number(data);

  if (!res.ok || !Number.isFinite(rate) || rate <= 0) {
    const message =
      raw && typeof raw === "object"
        ? String((raw as Record<string, unknown>).message ?? "")
        : "";
    return NextResponse.json(
      { error: message || "Couldn't fetch a rate." },
      { status: 502 }
    );
  }

  return NextResponse.json({ rate, fiat: fiat.toUpperCase(), token: token.toUpperCase() });
}
