import { NextRequest, NextResponse } from "next/server";
import { CHAINRAILS_OFFRAMP_ENABLED } from "@/rails/chainrails";

const API_URL = "https://api.chainrails.io/api/v1/ramp/orders";

/** Payload keys whose values are PII and must never reach the logs. */
const REDACT_KEYS = new Set([
  "userEmail",
  "senderAddress",
  "recipientAddress",
]);

/**
 * A log-safe copy of an outbound order payload: PII values are masked and the
 * open-ended `fields` object is reduced to its keys, so a structural mismatch
 * is still visible without exposing email / wallet / KYC values.
 */
function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (REDACT_KEYS.has(key)) {
      safe[key] = "[redacted]";
    } else if (key === "fields" && value && typeof value === "object") {
      safe[key] = { keys: Object.keys(value as Record<string, unknown>) };
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Creates a Chainrails ramp order. We proxy the REST call rather than exposing
 * the provider API key to the browser.
 *
 * Handles both directions:
 *  - on-ramp  (fiat → crypto): needs destinationChain + recipientAddress.
 *  - off-ramp (crypto → fiat): needs sourceChain + senderAddress.
 *
 * `fields` stays open-ended because FONBNK's direct flow requires channel-
 * specific values (phoneNumber, bankCode, bankAccountNumber, userEmail) whose
 * exact set the quote's `fieldsRequired` describes.
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

  const type = body.type === "off-ramp" ? "off-ramp" : "on-ramp";
  const isOfframp = type === "off-ramp";

  if (isOfframp && !CHAINRAILS_OFFRAMP_ENABLED) {
    return NextResponse.json(
      { error: "Selling from this network is temporarily unavailable." },
      { status: 503 }
    );
  }

  const required = isOfframp
    ? [
        "provider",
        "fiatCurrency",
        "cryptoAmount",
        "sourceChain",
        "senderAddress",
        "countryCode",
      ]
    : [
        "provider",
        "fiatCurrency",
        "cryptoAmount",
        "destinationChain",
        "recipientAddress",
        "countryCode",
      ];
  const missing = required.filter((field) => !body[field]);
  if (missing.length) {
    return NextResponse.json(
      { error: `Missing required field(s): ${missing.join(", ")}` },
      { status: 400 }
    );
  }

  const cryptoAmount = Number(body.cryptoAmount);
  if (!Number.isFinite(cryptoAmount) || cryptoAmount <= 0) {
    return NextResponse.json(
      { error: "cryptoAmount must be a positive number." },
      { status: 400 }
    );
  }

  const payload: Record<string, unknown> = {
    type,
    provider: body.provider,
    fiatCurrency: String(body.fiatCurrency).toUpperCase(),
    cryptoAmount,
    countryCode: String(body.countryCode).toUpperCase(),
    ...(isOfframp
      ? {
          sourceChain: body.sourceChain,
          senderAddress: body.senderAddress,
          amountSymbol: body.amountSymbol === "USDT" ? "USDT" : "USDC",
        }
      : {
          destinationChain: body.destinationChain,
          recipientAddress: body.recipientAddress,
        }),
    // NOTE: the live orders endpoint rejects both `paymentChannelId` and
    // `quoteId` ("property … should not exist") even though the SDK types list
    // them — so we never forward them.
    // `userEmail` must be TOP-LEVEL: the provider 403s ("userEmail is required
    // for KYC verification") when it's nested inside `fields`.
    ...(typeof body.userEmail === "string"
      ? { userEmail: body.userEmail }
      : {}),
    ...(body.fields && typeof body.fields === "object"
      ? { fields: body.fields }
      : {}),
  };

  try {
    const upstream = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data: unknown = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      // Surface the real upstream failure to the server logs before we map it
      // to a user-facing message (KYC/email gating shows up here).
      console.error(
        `[chainrails ramp order] ${type} upstream ${upstream.status}:`,
        JSON.stringify(data)
      );
      // On failure, dump the shape of the payload we sent so we can diff it
      // against a known-good request (e.g. a working curl). The upstream 500 is
      // generic — the difference is almost always in `fields`. Values that
      // carry PII (email, wallet addresses, KYC `fields`) are masked; only the
      // keys survive, which is enough to spot a structural mismatch.
      console.error(
        `[chainrails ramp order] ${type} request payload:`,
        JSON.stringify(redactPayload(payload))
      );
      // Upstream 5xx means Chainrails/the payout provider crashed on their end
      // (not a validation problem we can guide the user through). Don't leak the
      // raw provider message — show a neutral retry prompt instead.
      const message =
        upstream.status >= 500
          ? "The provider is temporarily unavailable to complete this request. Please try again in a few minutes."
          : data && typeof data === "object" && "message" in data
            ? String((data as Record<string, unknown>).message)
            : data && typeof data === "object" && "error" in data
              ? String((data as Record<string, unknown>).error)
              : `Chainrails order failed (${upstream.status}).`;
      return NextResponse.json({ error: message }, { status: upstream.status });
    }
    // Success: log the response SHAPE (top-level keys + any URL-looking values)
    // so we can confirm what the provider actually names the checkout link. The
    // URLs are hosted-checkout links, not PII, so they're safe to log.
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      const urls: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj))
        if (typeof v === "string" && /^https?:\/\//i.test(v)) urls[k] = v;
      console.log(
        `[chainrails ramp order] ${type} created — keys: ${JSON.stringify(
          Object.keys(obj)
        )}${Object.keys(urls).length ? ` urls: ${JSON.stringify(urls)}` : ""}`
      );
    }
    return NextResponse.json(data, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach Chainrails to create the order." },
      { status: 502 }
    );
  }
}

/**
 * Debug-only order list, token-gated. Chainrails' list endpoint is scoped to
 * our API key (account-wide — EVERY user's orders), so this must never be open.
 * It exists to map an intent address from the ChainRails dashboard back to a
 * numeric order id and inspect terminal statuses during deep debugging.
 *
 * Enable it by setting CHAINRAILS_DEBUG_TOKEN, then pass `?token=<that>`. When
 * the env var is unset the route is off. A bad/absent token returns 404 so the
 * route's existence isn't advertised. Query string (minus `token`) passes
 * through, e.g. `?status=completed`.
 */
export async function GET(req: NextRequest) {
  const expected = process.env.CHAINRAILS_DEBUG_TOKEN;
  const provided = req.nextUrl.searchParams.get("token");
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const apiKey = process.env.CHAINRAILS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "CHAINRAILS_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }
  // Don't forward our own gate token upstream.
  const params = new URLSearchParams(req.nextUrl.search);
  params.delete("token");
  const qs = params.toString();
  try {
    const upstream = await fetch(`${API_URL}${qs ? `?${qs}` : ""}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    const data: unknown = await upstream.json().catch(() => null);
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach Chainrails to list orders." },
      { status: 502 }
    );
  }
}
