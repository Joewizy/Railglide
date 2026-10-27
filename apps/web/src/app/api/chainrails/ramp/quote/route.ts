import { NextRequest, NextResponse } from "next/server";

const API_URL = "https://api.chainrails.io/api/v1/ramp/quotes";

/**
 * Live fiat→USDC ON-ramp quotes. We proxy the REST endpoint directly rather
 * than the SDK because the SDK omits the required `type` query param (causing a
 * 400) and hides the real error body inside a generic axios message. Raw REST
 * lets us pass `type=on-ramp` and surface the actual upstream error.
 */
export async function POST(req: NextRequest) {
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
    typeof body.destinationChain !== "string" ||
    typeof body.countryCode !== "string"
  ) {
    return NextResponse.json(
      {
        error: "fiatCurrency, destinationChain, and countryCode are required.",
      },
      { status: 400 }
    );
  }

  const params = new URLSearchParams({
    type: "on-ramp",
    fiatCurrency: body.fiatCurrency.toUpperCase(),
    cryptoAmount: String(cryptoAmount),
    destinationChain: body.destinationChain,
    countryCode: body.countryCode.toUpperCase(),
  });

  try {
    const upstream = await fetch(`${API_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      // Don't leave the user on a spinner if ChainRails hangs.
      signal: AbortSignal.timeout(15_000),
    });
    const data: unknown = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      console.error(
        `[chainrails ramp quote] upstream ${upstream.status}:`,
        JSON.stringify(data)
      );
      const message =
        data && typeof data === "object" && "message" in data
          ? String((data as Record<string, unknown>).message)
          : `Chainrails quote failed (${upstream.status}).`;
      // Pass client errors (bad amount/corridor) through; mask 5xx as 502.
      return NextResponse.json(
        { error: message },
        { status: upstream.status >= 500 ? 502 : upstream.status }
      );
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach Chainrails for a quote." },
      { status: 502 }
    );
  }
}
