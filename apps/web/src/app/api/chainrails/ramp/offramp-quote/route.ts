import { NextRequest, NextResponse } from "next/server";
import { CHAINRAILS_OFFRAMP_ENABLED } from "@/rails/chainrails";

const API_URL = "https://api.chainrails.io/api/v1/ramp/quotes";
const ORDERS_URL = "https://api.chainrails.io/api/v1/ramp/orders";

/**
 * When the quotes endpoint returns nothing, it doesn't say why — the amount is
 * simply outside the fillable range. The ORDER endpoint, however, returns an
 * exact human-readable limit ("Minimum off-ramp value for NGN is ~5 USDC"), and
 * that check runs before any order is created. So we probe it with a
 * deliberately incomplete payload (no `userEmail`/`fields`): a valid amount
 * would stop at the KYC/fields validation, never creating an order, while an
 * out-of-range amount hands back the limit message we want to show. Returns a
 * cleaned message, or null when the probe yields no usable limit reason.
 */
async function probeOfframpLimit(
  apiKey: string,
  params: URLSearchParams
): Promise<string | null> {
  try {
    const res = await fetch(ORDERS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "off-ramp",
        fiatCurrency: params.get("fiatCurrency"),
        cryptoAmount: Number(params.get("cryptoAmount")),
        sourceChain: params.get("sourceChain"),
        countryCode: params.get("countryCode"),
        amountSymbol: params.get("amountSymbol"),
        senderAddress: "probe", // non-empty; the limit check needs no real one
      }),
    });
    const data: unknown = await res.json().catch(() => null);
    const raw =
      data && typeof data === "object" && "message" in data
        ? String((data as Record<string, unknown>).message)
        : "";
    // Only trust genuine min/max limit messages — ignore KYC/provider errors.
    if (!/minimum|maximum/i.test(raw)) return null;
    // Clean it up: the floor is a crypto amount (~5 USDC), so drop the fiat
    // currency and the internal "(requested net: 4.0000)" detail.
    //   "Minimum off-ramp value for NGN is ~5 USDC (requested net: 4.0000)"
    //   → "Minimum amount to sell is ~5 USDC"
    return raw
      .replace(/\s*\(requested net:[^)]*\)/i, "")
      .replace(/off-ramp value for [A-Z]{3}/i, "amount to sell")
      .trim();
  } catch {
    return null;
  }
}

/**
 * Live Chainrails OFF-ramp quote (crypto → fiat). Unlike the SDK on-ramp quote,
 * this REST endpoint returns each provider's `paymentChannels[].
 * directTransferDetails.fieldsRequired` — including the dynamic `bankCode` enum
 * whose options ARE the bank list. The client renders those fields directly, so
 * there's no separate "banks" endpoint to call.
 *
 * We proxy from the server to keep the API key off the browser.
 */
export async function POST(req: NextRequest) {
  // Off-ramp is paused until Fiat KYB is approved (see CHAINRAILS_OFFRAMP_ENABLED).
  if (!CHAINRAILS_OFFRAMP_ENABLED) {
    return NextResponse.json(
      { error: "Selling from this network is temporarily unavailable." },
      { status: 503 }
    );
  }

  const apiKey = process.env.CHAINRAILS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "CHAINRAILS_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const cryptoAmount = Number(body.cryptoAmount);
  if (!Number.isFinite(cryptoAmount) || cryptoAmount <= 0) {
    return NextResponse.json(
      { error: "cryptoAmount must be a positive number." },
      { status: 400 }
    );
  }
  if (
    typeof body.fiatCurrency !== "string" ||
    typeof body.sourceChain !== "string" ||
    typeof body.countryCode !== "string"
  ) {
    return NextResponse.json(
      { error: "fiatCurrency, sourceChain, and countryCode are required." },
      { status: 400 }
    );
  }

  const params = new URLSearchParams({
    type: "off-ramp",
    fiatCurrency: body.fiatCurrency.toUpperCase(),
    cryptoAmount: String(cryptoAmount),
    sourceChain: body.sourceChain,
    countryCode: body.countryCode.toUpperCase(),
    // Which stablecoin is being sold; ChainRails defaults to USDC.
    amountSymbol: body.token === "USDT" ? "USDT" : "USDC",
  });

  try {
    const upstream = await fetch(`${API_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      // Don't leave the user on a spinner if ChainRails hangs.
      signal: AbortSignal.timeout(15_000),
    });
    const data: unknown = await upstream.json().catch(() => null);
    // ChainRails crashes (500) instead of saying "unsupported" when asked for
    // USDT on a chain where it doesn't handle USDT (e.g. Base, Solana; checked
    // 2026-10-27 — Optimism works). Turn that into a clear "use USDC" answer.
    if (upstream.status >= 500 && params.get("amountSymbol") === "USDT") {
      console.warn(
        `[chainrails] off-ramp USDT not supported from ${params.get("sourceChain")} (upstream ${upstream.status})`
      );
      return NextResponse.json(
        {
          error:
            "USDT can't be sold from this network right now. Switch to USDC or pick another chain.",
        },
        { status: 422 }
      );
    }
    if (!upstream.ok) {
      console.error(
        `[chainrails] off-ramp quote failed (${upstream.status})`,
        JSON.stringify(data)
      );
      const message =
        data && typeof data === "object" && "message" in data
          ? String((data as Record<string, unknown>).message)
          : `Chainrails quote failed (${upstream.status}).`;
      return NextResponse.json({ error: message }, { status: upstream.status });
    }

    const result =
      data && typeof data === "object"
        ? (data as Record<string, unknown>)
        : null;
    const quotes = result?.quotes;
    const hasQuote =
      Boolean(result?.recommended) ||
      (Array.isArray(quotes) && quotes.length > 0);
    if (!hasQuote) {
      console.warn("[chainrails] off-ramp quote unavailable (422)", {
        fiatCurrency: params.get("fiatCurrency"),
        cryptoAmount: params.get("cryptoAmount"),
        sourceChain: params.get("sourceChain"),
        countryCode: params.get("countryCode"),
        response: data,
      });
      // Empty quotes means the amount is outside the provider's fillable range
      // — could be under the min or over the max. The quotes endpoint won't say
      // which, so ask the order endpoint for the exact limit (e.g. "Minimum
      // amount to sell for NGN is ~5 USDC") and surface that when we can.
      // A rate preview (body.preview) just wants a number — skip the probe so
      // browsing countries never pokes the order endpoint.
      const limit =
        body.preview === true ? null : await probeOfframpLimit(apiKey, params);
      return NextResponse.json(
        {
          error:
            limit ??
            "No provider can fill that amount right now — try a different amount.",
        },
        { status: 422 }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("[chainrails] off-ramp quote request failed", error);
    return NextResponse.json(
      { error: "Couldn't reach Chainrails for an off-ramp quote." },
      { status: 502 }
    );
  }
}
