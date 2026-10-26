import { createHash } from "node:crypto";
import { amountBeforeFee } from "@/config/fees";
import { NextRequest, NextResponse } from "next/server";
import {
  PAYCREST_BASE_URL,
  PAYCREST_REFERENCE_MAX_LENGTH,
  fitPaycrestReference,
  isPaycrestConfigured,
  isPaycrestFiat,
  normalizePaycrestOrder,
  walletFromPaycrestPayload,
  type PaycrestOrder,
} from "@/rails/paycrest";
import {
  checkBuyerDetails,
  toPaycrestKyc,
  type BuyerDetails,
} from "@railglide/shared/kyc";
import { redis } from "@/lib/redis";
import { upsertStoredOrder } from "@/lib/orderStore";

/**
 * Deterministic fingerprint of an order's economic content within a 10-minute
 * window. Excludes the per-call `reference` (which carries a timestamp) so a
 * double-click / retry of the *same* intent hashes identically and can be
 * de-duplicated, while a deliberate re-order later still goes through.
 */
function idempotencyDigest(
  direction: string,
  body: Record<string, unknown>
): string {
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  const recipient = (body.recipient ?? {}) as Record<string, unknown>;
  const refundAccount = (body.refundAccount ?? {}) as Record<string, unknown>;
  const parts =
    direction === "onramp"
      ? {
          d: "onramp",
          amount: body.amount,
          token: body.token,
          network: body.network,
          recipientAddress: body.recipientAddress,
          fiatCurrency: body.fiatCurrency,
          acct: refundAccount.accountIdentifier,
          inst: refundAccount.institution,
          bucket,
        }
      : {
          d: "offramp",
          amount: body.amount,
          token: body.token,
          network: body.network,
          refundAddress: body.refundAddress,
          currency: body.currency,
          acct: recipient.accountIdentifier,
          inst: recipient.institution,
          bucket,
        };
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Starknet addresses are felts: 0x + up to 64 hex, usually zero-padded to 64.
const STARKNET_ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;

/**
 * Validate an on-ramp recipient against the destination network. Paycrest
 * on-ramps to EVM chains and Starknet; the two use different address formats,
 * so a single EVM regex wrongly rejects a Starknet felt.
 */
function isValidRecipientForNetwork(address: string, network: string): boolean {
  return network === "starknet"
    ? STARKNET_ADDRESS.test(address)
    : EVM_ADDRESS.test(address);
}

/**
 * Turns a Paycrest error into user-facing copy. Paycrest's raw messages are
 * technical and leak internals (chain slug, exact micro-amount), so map the
 * cases we recognise to clean copy — the raw body is already logged for us.
 */
function friendlyPaycrestError(text: string): string | null {
  const t = text.toLowerCase();
  // No liquidity provider for this corridor/amount. This fires most often when
  // the amount is outside every provider's min/max, so steer to a new amount
  // rather than assuming "smaller".
  if (t.includes("no provider")) {
    return "No provider can fill an order this size right now. Try a different amount, or check back shortly.";
  }
  // Buy orders: the refund account's holder isn't the person in the KYC.
  if (t.includes("refund account name does not match")) {
    return "The refund bank account must be in your own name — the same person as the NIN. Use your own account and try again.";
  }
  // Buy orders: Paycrest rejected the buyer details (NIN, date of birth…).
  // Paycrest lists each bad field by path, so name the ones we recognise.
  if (t.includes("kyc")) {
    const fields = [
      t.includes("birthdate") && "date of birth",
      t.includes("iddocument") && "NIN / ID number",
      t.includes("phone") && "phone number",
    ].filter(Boolean);
    return fields.length > 0
      ? `Please check your ${fields.join(", ")} and try again.`
      : "We couldn't verify your details. Check your date of birth and ID numbers, then try again.";
  }
  return null;
}

function paycrestErrorResponse(raw: unknown, res: Response) {
  let rawMessage = `Couldn't create this order (${res.status}).`;
  let detailField = "";
  let detailMessage = "";
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    rawMessage = String(r.message ?? r.error ?? rawMessage);
    const detail = r.data as { field?: unknown; message?: unknown } | undefined;
    if (detail && typeof detail.message === "string") {
      detailMessage = detail.message;
      if (detail.field) detailField = String(detail.field);
    }
  }
  const message =
    friendlyPaycrestError(`${rawMessage} ${detailMessage}`) ??
    (detailMessage
      ? `${rawMessage} ${detailField ? `[${detailField}] ` : ""}${detailMessage}`
      : rawMessage);
  return NextResponse.json(
    { error: message },
    { status: res.status === 401 ? 401 : 502 }
  );
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // A reference over Paycrest's 70-char cap is repaired per-direction in
  // buildOnrampBody / buildOfframpBody (rebuilt from the known address so the
  // wallet-matching key survives). We never fail a payment over it.
  if (
    typeof body.reference === "string" &&
    body.reference.length > PAYCREST_REFERENCE_MAX_LENGTH
  ) {
    console.warn("[paycrest] reference over limit — will rebuild", {
      length: body.reference.length,
    });
  }

  const direction =
    body.direction === "onramp"
      ? "onramp"
      : body.direction === "offramp"
        ? "offramp"
        : body.refundAccount
          ? "onramp"
          : "offramp";

  const apiKey = process.env.PAYCREST_API_KEY;
  if (!isPaycrestConfigured() || !apiKey) {
    return NextResponse.json(
      {
        error: "Fiat payouts aren't available right now. Try again later.",
      },
      { status: 501 }
    );
  }

  let paycrestBody: Record<string, unknown>;
  let fallbackCurrency: string;

  if (direction === "onramp") {
    const built = buildOnrampBody(body);
    if ("error" in built) {
      return NextResponse.json({ error: built.error }, { status: 400 });
    }
    paycrestBody = built.body;
    fallbackCurrency = built.fiatCurrency;
  } else {
    const built = buildOfframpBody(body);
    if ("error" in built) {
      return NextResponse.json({ error: built.error }, { status: 400 });
    }
    paycrestBody = built.body;
    fallbackCurrency = built.currency;
  }

  // Idempotency: claim this intent so a double-submit (double-click, client
  // retry, back-and-confirm) can't create two real payout orders. The first
  // request claims the key; a concurrent duplicate gets 409, and a later
  // replay gets the already-created order back instead of a new one.
  const idemKey = `paycrest:order:${idempotencyDigest(direction, body)}`;
  let claimed = false;
  if (redis) {
    try {
      const claim = await redis.set(
        idemKey,
        { pending: true },
        { nx: true, ex: 900 }
      );
      if (!claim) {
        const existing = await redis.get<Record<string, unknown>>(idemKey);
        if (existing && typeof existing.id === "string") {
          return NextResponse.json(existing);
        }
        return NextResponse.json(
          {
            error:
              "An identical order is already being created — check your history in a moment.",
          },
          { status: 409 }
        );
      }
      claimed = true;
    } catch (err) {
      // Redis down — skip idempotency rather than block a real payout.
      console.error("[paycrest] idempotency unavailable, proceeding", err);
    }
  }
  const releaseClaim = async () => {
    if (!claimed || !redis) return;
    try {
      await redis.del(idemKey);
    } catch {
      /* best effort — the key expires in 900s regardless */
    }
  };

  let res: Response;
  try {
    res = await fetch(`${PAYCREST_BASE_URL}/v2/sender/orders`, {
      method: "POST",
      headers: {
        "API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paycrestBody),
    });
  } catch (error) {
    await releaseClaim();
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Request failed",
      },
      { status: 502 }
    );
  }

  const raw: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    await releaseClaim();
    console.error(
      `[paycrest] order create failed (${direction}, ${res.status})`,
      raw
    );
    return paycrestErrorResponse(raw, res);
  }

  const payload =
    raw && typeof raw === "object" && "data" in raw
      ? ((raw as Record<string, unknown>).data as Record<string, unknown>)
      : (raw as Record<string, unknown> | null);

  if (!payload || typeof payload.id !== "string") {
    await releaseClaim();
    console.error("[paycrest] unexpected order-create shape", raw);
    return NextResponse.json(
      { error: "Unexpected response from payout service" },
      { status: 502 }
    );
  }

  if (!payload.currency && fallbackCurrency) {
    payload.currency = fallbackCurrency;
  }

  const order: PaycrestOrder = normalizePaycrestOrder(payload, raw);
  // Store the created order under the idempotency key so an immediate replay
  // of the same intent returns this order instead of creating another.
  if (claimed && redis) {
    try {
      await redis.set(idemKey, order, { ex: 900 });
    } catch (err) {
      console.error("[paycrest] failed to persist idempotency result", err);
    }
  }
  // Seed the store so polling reads from Redis without waiting for a webhook.
  await upsertStoredOrder(order, {
    walletAddress: walletFromPaycrestPayload(payload),
    event: "created",
  });
  return NextResponse.json(order);
}

function buildOfframpBody(
  body: Record<string, unknown>
): { body: Record<string, unknown>; currency: string } | { error: string } {
  const { amount, token, network, refundAddress, currency, reference } = body;
  const recipient = body.recipient as
    | {
        institution?: unknown;
        accountIdentifier?: unknown;
        accountName?: unknown;
        memo?: unknown;
      }
    | undefined;

  if (typeof amount !== "string" || !(Number(amount) > 0)) {
    return { error: "amount must be a positive decimal string" };
  }
  if (token !== "USDC" && token !== "USDT") {
    return { error: 'token must be "USDC" or "USDT"' };
  }
  if (typeof network !== "string" || !network) {
    return {
      error: 'network is required (e.g. "base")',
    };
  }
  if (typeof refundAddress !== "string" || !EVM_ADDRESS.test(refundAddress)) {
    return { error: "refundAddress must be a 0x-prefixed EVM address" };
  }
  if (typeof currency !== "string" || !isPaycrestFiat(currency)) {
    return {
      error: `Unsupported payout currency "${String(currency)}"`,
    };
  }
  if (
    !recipient ||
    typeof recipient.institution !== "string" ||
    typeof recipient.accountIdentifier !== "string" ||
    typeof recipient.accountName !== "string"
  ) {
    return {
      error:
        "recipient.institution, accountIdentifier and accountName are required",
    };
  }

  // Off-ramp encodes the refund wallet in the reference; rebuild from it if the
  // client sent an over-length form so the wallet key stays matchable.
  const fittedReference = fitPaycrestReference(
    reference,
    "offramp",
    typeof refundAddress === "string" ? refundAddress : undefined
  );

  return {
    currency: currency.toUpperCase(),
    body: {
      // The user's typed amount includes our fee; Paycrest adds the fee on
      // top of `amount`, so order the amount before fee (800 → 796.02).
      amount: String(amountBeforeFee(Number(amount))),
      source: {
        type: "crypto",
        currency: token,
        network,
        refundAddress,
      },
      destination: {
        type: "fiat",
        currency: currency.toUpperCase(),
        recipient: {
          institution: recipient.institution,
          accountIdentifier: recipient.accountIdentifier,
          accountName: recipient.accountName,
          ...(typeof recipient.memo === "string" && recipient.memo
            ? { memo: recipient.memo }
            : {}),
        },
      },
      ...(fittedReference ? { reference: fittedReference } : {}),
    },
  };
}

function buildOnrampBody(
  body: Record<string, unknown>
): { body: Record<string, unknown>; fiatCurrency: string } | { error: string } {
  const {
    amount,
    token,
    network,
    recipientAddress,
    reference,
    fiatCurrency,
    amountIn,
  } = body;
  const refundAccount = body.refundAccount as
    | {
        institution?: unknown;
        accountIdentifier?: unknown;
        accountName?: unknown;
      }
    | undefined;

  if (typeof amount !== "string" || !(Number(amount) > 0)) {
    return { error: "amount must be a positive decimal string" };
  }
  if (token !== "USDC" && token !== "USDT") {
    return { error: 'token must be "USDC" or "USDT"' };
  }
  if (typeof network !== "string" || !network) {
    return {
      error: 'network is required (e.g. "base")',
    };
  }
  if (
    typeof recipientAddress !== "string" ||
    typeof network !== "string" ||
    !isValidRecipientForNetwork(recipientAddress, network)
  ) {
    return {
      error: `recipientAddress is not a valid address for "${String(network)}"`,
    };
  }
  const fiat =
    typeof fiatCurrency === "string"
      ? fiatCurrency
      : typeof body.currency === "string"
        ? body.currency
        : null;
  if (!fiat || !isPaycrestFiat(fiat)) {
    return {
      error: `Unsupported fiat currency "${String(fiat ?? "(none)")}"`,
    };
  }
  if (
    !refundAccount ||
    typeof refundAccount.institution !== "string" ||
    typeof refundAccount.accountIdentifier !== "string" ||
    typeof refundAccount.accountName !== "string"
  ) {
    return {
      error:
        "refundAccount.institution, accountIdentifier and accountName are required",
    };
  }

  // Paycrest needs to know who is paying in on every Buy order. The name comes
  // from the verified refund account, so the two always match.
  const buyer = body.buyer as BuyerDetails | undefined;
  const buyerProblems = checkBuyerDetails(fiat, buyer);
  if (buyerProblems.length > 0) {
    return { error: buyerProblems.join(" ") };
  }

  const resolvedAmountIn =
    amountIn === "crypto" || amountIn === "fiat" ? amountIn : "fiat";

  // On-ramp encodes the recipient wallet in the reference; rebuild from it if
  // the client sent an over-length form (e.g. a stale bundle with an un-reduced
  // Starknet felt) so the wallet key stays matchable in History.
  const fittedReference = fitPaycrestReference(
    reference,
    "onramp",
    recipientAddress
  );

  return {
    fiatCurrency: fiat.toUpperCase(),
    body: {
      amount,
      amountIn: resolvedAmountIn,
      source: {
        type: "fiat",
        currency: fiat.toUpperCase(),
        refundAccount: {
          institution: refundAccount.institution,
          accountIdentifier: refundAccount.accountIdentifier,
          accountName: refundAccount.accountName,
        },
        kyc: toPaycrestKyc(fiat, refundAccount.accountName, buyer!),
      },
      destination: {
        type: "crypto",
        currency: token,
        recipient: {
          address: recipientAddress,
          network,
        },
      },
      ...(fittedReference ? { reference: fittedReference } : {}),
    },
  };
}
