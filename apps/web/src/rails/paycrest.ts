/**
 * Paycrest rail — fiat off-ramp and on-ramp via the v2 Sender API.
 *
 * Pure module: no I/O, safe to import from client or server. Holds the
 * single source of truth the intent parser, the API route and the UI
 * all share — supported fiat currencies, network slugs, the env gate
 * and the order request/response types.
 *
 * Both directions use the same endpoint (POST /v2/sender/orders) and the
 * same server-only API key; the actual fetch lives in /api/paycrest/order.
 *
 * Docs: https://docs.paycrest.io/implementation-guides/sender-api-integration
 * Note: Paycrest runs on mainnet only — no sandbox; test with small amounts.
 *
 * See ARCHITECTURE.md §"Phase 1 — Local payout MVP".
 */

import type { ChainId } from "@/config/network";
import type { BuyerDetails } from "@railglide/shared/kyc";

/** Paycrest Sender API host. Auth is the `API-Key` request header. */
export const PAYCREST_BASE_URL = "https://api.paycrest.io";

/** Fiat currencies Paycrest supports for payout and on-ramp. */
// Paycrest dropped GHS, XOF, ZMW and ZAR (Oct 2026) — those now go through
// ChainRails. Check GET https://api.paycrest.io/v1/currencies when in doubt.
export const PAYCREST_FIAT = ["NGN", "KES", "UGX", "TZS"] as const;

export type PaycrestFiat = (typeof PAYCREST_FIAT)[number];

/** Case-insensitive check + type guard for a supported fiat currency. */
export function isPaycrestFiat(code: string): code is PaycrestFiat {
  return (PAYCREST_FIAT as readonly string[]).includes(code.toUpperCase());
}

/**
 * Server-side fetch of the live unit rate (fiat per 1 token) straight from
 * Paycrest's public rates endpoint. Used by the chat assistant to quote a
 * real rate. Returns null on any failure — a rate is a nicety, never a gate.
 */
export async function fetchPaycrestUnitRate(
  fiat: string,
  token: string
): Promise<number | null> {
  const t = token.toUpperCase();
  if (!isPaycrestFiat(fiat) || (t !== "USDC" && t !== "USDT")) return null;
  try {
    const res = await fetch(
      `${PAYCREST_BASE_URL}/v1/rates/${t.toLowerCase()}/1/${fiat.toLowerCase()}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const raw: unknown = await res.json().catch(() => null);
    const data =
      raw && typeof raw === "object"
        ? (raw as Record<string, unknown>).data
        : null;
    const rate = Number(data);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

/**
 * Turns a raw Paycrest error into something a non-technical user can act on.
 * Falls back to the original message (minus the noisy validation prefix).
 */
export function humanizePaycrestError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("no provider available")) {
    return "No provider can fill an order this size right now. Try a smaller amount, or check back shortly.";
  }
  if (m.includes("rate validation") || m.includes("no rate")) {
    return "We couldn't lock a rate for that amount — try a different amount.";
  }
  if (m.includes("insufficient") || m.includes("minimum")) {
    return "That amount is outside the supported range for this payout — try a different amount.";
  }
  if (m.includes("failed to initiate payment order")) {
    return "We couldn't start this payout — please try again in a moment.";
  }
  // Strip the noisy "Failed to validate payload [X]" prefix if present.
  let cleaned = message
    .replace(/^failed to validate payload\s*\[[^\]]*\]\s*/i, "")
    .trim();
  // Never surface vendor names in user-facing copy.
  cleaned = cleaned
    .replace(/\bpaycrest\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();
  return cleaned || "Something went wrong — try again.";
}

/** Stablecoins Paycrest accepts. */
export type PaycrestToken = "USDC" | "USDT";

export type PaycrestDirection = "offramp" | "onramp";

// ---------------------------------------------------------------------------
// Networks — map our app ChainId to Paycrest's network slug.
// ---------------------------------------------------------------------------

export const PAYCREST_NETWORK_SLUGS: Partial<Record<ChainId, string>> = {
  base: "base",
  ethereum: "ethereum",
  arbitrum: "arbitrum-one",
  polygon: "polygon",
  bnb: "bnb-smart-chain",
  celo: "celo",
  starknet: "starknet",
};

/** Paycrest network slug for a chain, or null when unsupported. */
export function paycrestNetworkSlug(chainId: ChainId): string | null {
  return PAYCREST_NETWORK_SLUGS[chainId] ?? null;
}

/** ChainIds Paycrest can on/off-ramp, in slug-map order — for network pickers. */
export const PAYCREST_CHAIN_IDS = Object.keys(
  PAYCREST_NETWORK_SLUGS
) as ChainId[];

/**
 * ChainIds we can currently SELL from via Paycrest. Off-ramp signs a real
 * USDC transfer, so it needs wallet signing + a token address — i.e. the EVM
 * subset. Starknet is a buy-only corridor until Starknet signing lands; Solana
 * and Tron off-ramp are not wired yet either.
 */
export const PAYCREST_SELL_CHAIN_IDS: ChainId[] = [
  "ethereum",
  "base",
  "arbitrum",
  "polygon",
  "bnb",
  "celo",
];

/** Reverse of paycrestNetworkSlug: "base" → "base", "arbitrum-one" → "arbitrum". */
export function chainIdFromPaycrestSlug(slug: string): ChainId | null {
  const entry = Object.entries(PAYCREST_NETWORK_SLUGS).find(
    ([, s]) => s === slug
  );
  return entry ? (entry[0] as ChainId) : null;
}

/** A payout institution (bank or mobile-money) from Paycrest's catalogue. */
export interface PaycrestInstitution {
  name: string;
  /** Code passed as recipient.institution, e.g. "GTBINGLA", "OPAYNGPC". */
  code: string;
  type: "bank" | "mobile_money";
}

/**
 * True when the Paycrest API key is present in the server env. Returns
 * false on the client (the key is server-only) — call this inside the
 * API route, not in the hook.
 */
export function isPaycrestConfigured(): boolean {
  return Boolean(process.env.PAYCREST_API_KEY);
}

// ---------------------------------------------------------------------------
// Order types — request/response shapes the hooks and routes agree on.
// ---------------------------------------------------------------------------

/** Bank or mobile-money account (payout destination or fiat refund account). */
export interface PaycrestRecipient {
  institution: string;
  accountIdentifier: string;
  accountName: string;
  memo?: string;
}

/** Fiat account Paycrest refunds to if an on-ramp order fails. */
export type PaycrestRefundAccount = PaycrestRecipient;

/** Off-ramp: stablecoin → fiat. */
export interface PaycrestOfframpRequest {
  direction?: "offramp";
  amount: string;
  token: PaycrestToken;
  /** Paycrest network slug, e.g. "base". */
  network: string;
  refundAddress: `0x${string}`;
  currency: PaycrestFiat;
  recipient: PaycrestRecipient;
  reference?: string;
}

/** On-ramp: fiat → stablecoin. */
export interface PaycrestOnrampRequest {
  direction: "onramp";
  amount: string;
  /** Defaults to "fiat" when omitted. */
  amountIn?: "fiat" | "crypto";
  fiatCurrency: PaycrestFiat;
  refundAccount: PaycrestRefundAccount;
  /** Who is paying in — Paycrest requires it on every on-ramp order. */
  buyer: BuyerDetails;
  token: PaycrestToken;
  network: string;
  recipientAddress: `0x${string}`;
  reference?: string;
}

/** Flat order body the app posts to /api/paycrest/order. */
export type PaycrestOrderRequest =
  PaycrestOfframpRequest | PaycrestOnrampRequest;

/**
 * Paycrest order lifecycle. Mirrors the status field Paycrest returns:
 * initiated → deposited → pending → validated → settling → settled, with
 * refunding → refunded and expired as off-paths. `processing`/`fulfilled`
 * aren't in the documented list but the API has returned them, so we
 * tolerate them rather than mislabel an order.
 */
export type PaycrestOrderStatus =
  | "initiated"
  // Off-ramp: the stablecoin deposit has been detected on-chain.
  | "deposited"
  | "pending"
  | "processing"
  | "validated"
  | "settling"
  // Terminal success: provider has paid the recipient (and settled on-chain).
  | "fulfilled"
  | "settled"
  // Refund in progress (funds not yet back with the sender).
  | "refunding"
  | "refunded"
  | "expired";

/** A created order, normalised from the Paycrest response. */
export interface PaycrestOrder {
  id: string;
  status: PaycrestOrderStatus;
  direction: PaycrestDirection;
  /** Crypto amount (off-ramp: sent; on-ramp: received). */
  amount: string;
  /** Display currency — fiat code for off-ramp, token symbol for on-ramp. */
  currency: string;
  /** Locked exchange rate when returned by Paycrest. */
  rate?: string;
  /** Off-ramp: on-chain address the user funds with stablecoin. */
  receiveAddress?: string;
  /** On-ramp: virtual account / mobile number to deposit fiat into. */
  depositInstitution?: string;
  depositAccountIdentifier?: string;
  depositAccountName?: string;
  /** Off-ramp: bank/mobile-money recipient the fiat payout lands with. */
  recipientName?: string;
  recipientInstitution?: string;
  recipientAccountIdentifier?: string;
  /** Exact amount the user must send: fiat (on-ramp) or crypto (off-ramp).
   *  Order amount + senderFee + transactionFee. */
  amountToTransfer?: string;
  depositCurrency?: string;
  /** Deadline for funding (off-ramp crypto or on-ramp fiat). */
  validUntil?: string;
  /** Amount of the deposit received so far (for partial-deposit progress). */
  amountPaid?: string;
  /** Amount returned to the refund address (refunds / overpayment). */
  amountReturned?: string;
  /** Settlement progress, 0–100. */
  percentSettled?: string;
  /** Sender (app) fee, if any. */
  senderFee?: string;
  /** Network / processing fee, if any. */
  transactionFee?: string;
  /** Settlement / on-chain tx hash, once available. */
  txHash?: string;
  /** On-ramp: wallet that receives stablecoin. */
  recipientAddress?: string;
  /** On-ramp: destination network slug, e.g. "base". */
  recipientNetwork?: string;
  createdAt: string;
  /** Last update — settlement time once fulfilled. */
  updatedAt?: string;
  raw?: unknown;
}

/**
 * What the user must send for an off-ramp order: Paycrest's amountToTransfer,
 * else amount + senderFee + transactionFee. Never the bare `amount` — that
 * leaves the order short by the fees.
 */
export function paycrestAmountDue(
  order: Pick<
    PaycrestOrder,
    "amount" | "amountToTransfer" | "senderFee" | "transactionFee"
  >
): string {
  if (Number(order.amountToTransfer) > 0) return order.amountToTransfer!;
  const total =
    Number(order.amount ?? 0) +
    Number(order.senderFee ?? 0) +
    Number(order.transactionFee ?? 0);
  // Round up at 6 decimals so we never send a hair short.
  return String(Math.ceil(total * 1e6) / 1e6);
}

/**
 * Normalises a Paycrest v2 order payload into our PaycrestOrder shape.
 * Used by POST and GET /api/paycrest/order routes.
 */
export function normalizePaycrestOrder(
  payload: Record<string, unknown>,
  raw?: unknown
): PaycrestOrder {
  const source = payload.source as { type?: string } | undefined;
  const destination = payload.destination as
    { type?: string; currency?: string; recipient?: unknown } | undefined;
  const direction: PaycrestDirection =
    source?.type === "fiat" ? "onramp" : "offramp";

  const providerAccount = payload.providerAccount as
    Record<string, unknown> | undefined;

  // Off-ramp fiat recipient (bank / mobile-money the payout lands with). Pulled
  // fresh from the payload for display; not persisted to the device tracker.
  const fiatRecipient =
    direction === "offramp" && destination?.type === "fiat"
      ? (destination.recipient as Record<string, unknown> | undefined)
      : undefined;

  const fiatCurrency =
    direction === "onramp"
      ? typeof source?.type === "string"
        ? String(
            (source as { currency?: string }).currency ??
              destination?.currency ??
              ""
          ).toUpperCase()
        : ""
      : String(
          destination?.currency ??
            (payload.currency as string | undefined) ??
            ""
        ).toUpperCase();

  const cryptoCurrency =
    direction === "onramp"
      ? String(
          (destination as { currency?: string } | undefined)?.currency ?? ""
        )
      : String((source as { currency?: string } | undefined)?.currency ?? "");

  return {
    id: String(payload.id),
    status: (payload.status as PaycrestOrderStatus) ?? "initiated",
    direction,
    amount:
      typeof payload.amount === "string"
        ? payload.amount
        : String(payload.amount ?? ""),
    currency: direction === "onramp" ? cryptoCurrency : fiatCurrency,
    rate: typeof payload.rate === "string" ? payload.rate : undefined,
    receiveAddress:
      direction === "offramp" &&
      typeof providerAccount?.receiveAddress === "string"
        ? providerAccount.receiveAddress
        : undefined,
    depositInstitution:
      direction === "onramp" && typeof providerAccount?.institution === "string"
        ? providerAccount.institution
        : undefined,
    depositAccountIdentifier:
      direction === "onramp" &&
      typeof providerAccount?.accountIdentifier === "string"
        ? providerAccount.accountIdentifier
        : undefined,
    depositAccountName:
      direction === "onramp" && typeof providerAccount?.accountName === "string"
        ? providerAccount.accountName
        : undefined,
    recipientName:
      typeof fiatRecipient?.accountName === "string"
        ? fiatRecipient.accountName
        : undefined,
    recipientInstitution:
      typeof fiatRecipient?.institutionName === "string"
        ? fiatRecipient.institutionName
        : typeof fiatRecipient?.institution === "string"
          ? fiatRecipient.institution
          : undefined,
    recipientAccountIdentifier:
      typeof fiatRecipient?.accountIdentifier === "string"
        ? fiatRecipient.accountIdentifier
        : undefined,
    amountToTransfer:
      typeof providerAccount?.amountToTransfer === "string"
        ? providerAccount.amountToTransfer
        : undefined,
    depositCurrency:
      direction === "onramp" && typeof providerAccount?.currency === "string"
        ? providerAccount.currency
        : undefined,
    validUntil:
      typeof providerAccount?.validUntil === "string"
        ? providerAccount.validUntil
        : undefined,
    amountPaid: asString(payload.amountPaid),
    amountReturned: asString(payload.amountReturned),
    percentSettled: asString(payload.percentSettled),
    senderFee: asString(payload.senderFee),
    transactionFee: asString(payload.transactionFee),
    txHash: extractSettlementTxHash(payload),
    recipientAddress:
      direction === "onramp"
        ? extractCryptoRecipientAddress(destination)
        : undefined,
    recipientNetwork:
      direction === "onramp"
        ? extractCryptoRecipientNetwork(destination)
        : undefined,
    createdAt:
      typeof payload.createdAt === "string"
        ? payload.createdAt
        : typeof payload.timestamp === "string"
          ? payload.timestamp
          : new Date().toISOString(),
    updatedAt:
      typeof payload.updatedAt === "string" ? payload.updatedAt : undefined,
    raw: sanitizePaycrestRaw(raw ?? payload),
  };
}

/**
 * Strips a Paycrest payload down to the only part the client legitimately
 * needs from `raw` — the transactionLogs lifecycle. Everything else (recipient
 * bank name/number, refund account, provider internals) is dropped so an order
 * response can never leak banking PII, even via an IDOR on the order-detail
 * route. Both extractLifecycle and hasPaycrestTransactionLog read these logs
 * at the root, which is where we put them.
 */
export function sanitizePaycrestRaw(
  raw: unknown
):
  | { transactionLogs: Array<{ status: string; created_at?: string }> }
  | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const root = raw as Record<string, unknown>;
  const data =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : root;
  const logs = data.transactionLogs;
  if (!Array.isArray(logs)) return undefined;
  return {
    transactionLogs: logs.map((entry) => {
      const o = (entry ?? {}) as Record<string, unknown>;
      return {
        status: typeof o.status === "string" ? o.status : "",
        created_at: typeof o.created_at === "string" ? o.created_at : undefined,
      };
    }),
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function extractCryptoRecipientAddress(
  destination: { type?: string; recipient?: unknown } | undefined
): string | undefined {
  if (!destination || destination.type !== "crypto") return undefined;
  const recipient = destination.recipient as { address?: string } | undefined;
  return typeof recipient?.address === "string" ? recipient.address : undefined;
}

function extractCryptoRecipientNetwork(
  destination: { type?: string; recipient?: unknown } | undefined
): string | undefined {
  if (!destination || destination.type !== "crypto") return undefined;
  const recipient = destination.recipient as { network?: string } | undefined;
  return typeof recipient?.network === "string" ? recipient.network : undefined;
}

const PAYCREST_CREDITED_STATUSES = new Set<PaycrestOrderStatus>([
  "deposited",
  "pending",
  "processing",
  "validated",
  "settling",
  "fulfilled",
  "settled",
]);

function hasPaycrestTransactionLog(
  order: PaycrestOrder,
  statuses: string[]
): boolean {
  const raw = order.raw;
  if (!raw || typeof raw !== "object") return false;
  const root = raw as Record<string, unknown>;
  const data =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : root;
  const logs = data.transactionLogs;
  if (!Array.isArray(logs)) return false;
  const want = new Set(statuses);
  return logs.some((entry) => {
    const o = (entry ?? {}) as Record<string, unknown>;
    const status = typeof o.status === "string" ? o.status : "";
    return want.has(status);
  });
}

/** Paycrest has seen and credited the crypto deposit (source of truth). */
export function paycrestDepositCredited(order: PaycrestOrder): boolean {
  if (Number(order.amountPaid ?? 0) > 0) return true;
  if (PAYCREST_CREDITED_STATUSES.has(order.status)) return true;
  return hasPaycrestTransactionLog(order, ["crypto_deposited"]);
}

/** Provider is disbursing fiat — past the "waiting for deposit" stage. */
export function paycrestPayoutInFlight(order: PaycrestOrder): boolean {
  if (Number(order.amountPaid ?? 0) > 0) return true;
  return (
    order.status === "pending" ||
    order.status === "processing" ||
    order.status === "validated" ||
    order.status === "settling"
  );
}

/** Funding window closed with no credited deposit. */
export function paycrestFundingWindowClosed(order: PaycrestOrder): boolean {
  if (order.status === "expired" || order.status === "refunded") return true;
  if (paycrestDepositCredited(order)) return false;
  if (!order.validUntil) return false;
  return Date.now() > new Date(order.validUntil).getTime();
}

/** What the client poller should do with an order on each tick. */
export type PaycrestOutcome = "success" | "failed" | "expired" | "pending";

/**
 * Direction-aware terminal check for the client poller.
 *
 * On-ramp is only "done" once USDC has settled on-chain (`settled`); off-ramp
 * also accepts `fulfilled`, the point at which the provider has paid the
 * recipient. Anything else is a failure, an expiry, or still in flight
 * ("pending" — keep polling).
 */
export function classifyPaycrestOrder(
  order: PaycrestOrder,
  direction: PaycrestDirection
): PaycrestOutcome {
  if (order.status === "settled") return "success";
  if (direction === "offramp" && order.status === "fulfilled") return "success";
  if (order.status === "refunded") return "failed";
  if (order.status === "expired") return "expired";
  if (paycrestFundingWindowClosed(order) && !paycrestDepositCredited(order)) {
    return "expired";
  }
  return "pending";
}

/**
 * Monotonic rank of a status along the order lifecycle. The webhook/store layer
 * uses this so a late, out-of-order webhook (Paycrest retries, and delivery is
 * not ordered) can never overwrite a more-advanced status — a stray `pending`
 * must not clobber a `settled`. Off-path states share a tier with the in-flight
 * state they branch from; the terminal states sit at the top.
 */
const PAYCREST_STATUS_RANK: Record<PaycrestOrderStatus, number> = {
  initiated: 0,
  deposited: 1,
  pending: 2,
  processing: 3,
  validated: 4,
  settling: 5,
  refunding: 5,
  fulfilled: 6,
  settled: 7,
  refunded: 7,
  expired: 7,
};

export function paycrestStatusRank(status: PaycrestOrderStatus): number {
  return PAYCREST_STATUS_RANK[status] ?? 0;
}

const PAYCREST_TERMINAL_STATUSES = new Set<PaycrestOrderStatus>([
  "fulfilled",
  "settled",
  "refunded",
  "expired",
]);

/** True once an order has reached a final state and won't progress further. */
export function isPaycrestTerminalStatus(status: PaycrestOrderStatus): boolean {
  return PAYCREST_TERMINAL_STATUSES.has(status);
}

/**
 * Best-effort extraction of the connected wallet from a raw Paycrest order
 * payload, used to attribute store records to a user. The wallet we encode in
 * the order `reference` (`sw-off-<wallet>-<ts>`) is the most reliable signal —
 * Paycrest overrides the off-ramp `refundAddress` to its account default, so on
 * off-ramp orders the reference is the *only* link back to the real wallet.
 * Falls back to the on-ramp crypto recipient and then the off-ramp refund
 * address. Returns a lowercased address or null.
 */
export function walletFromPaycrestPayload(
  payload: Record<string, unknown>
): string | null {
  const reference = payload.reference;
  if (typeof reference === "string") {
    const match = reference.match(/0x[0-9a-fA-F]{40}/);
    if (match) return match[0].toLowerCase();
  }

  const destination = payload.destination as
    Record<string, unknown> | undefined;
  if (destination?.type === "crypto") {
    const recipient = destination.recipient as { address?: string } | undefined;
    if (typeof recipient?.address === "string") {
      return recipient.address.toLowerCase();
    }
  }

  const source = payload.source as Record<string, unknown> | undefined;
  if (source?.type === "crypto" && typeof source.refundAddress === "string") {
    return (source.refundAddress as string).toLowerCase();
  }

  return null;
}

/** Compact row for History — derived from a v2 list/detail order payload. */
export interface PaycrestHistoryOrder {
  id: string;
  direction: PaycrestDirection;
  status: string;
  /** Crypto amount (off-ramp: sent; on-ramp: received). */
  amount: string;
  token: string;
  network: string;
  rate: string | null;
  /** Fiat currency code (NGN, etc.). */
  currency: string | null;
  /** Fiat the recipient gets (off-ramp) or the user deposited (on-ramp). */
  fiatAmount: number | null;
  recipientName: string | null;
  institution: string | null;
  accountIdentifier: string | null;
  /** On-ramp: wallet that receives stablecoin. */
  recipientAddress: string | null;
  /** Off-ramp: on-chain deposit address. */
  receiveAddress: string | null;
  /** On-ramp: virtual account to fund while order is open. */
  depositAccountIdentifier: string | null;
  refundInstitution: string | null;
  refundInstitutionName: string | null;
  refundAccountIdentifier: string | null;
  refundAccountName: string | null;
  txHash: string | null;
  createdAt: string | null;
}

/**
 * Paycrest rejects an order with HTTP 500 "Failed to initiate payment order"
 * if the reference runs long (empirically anything past ~70 chars). Keep our
 * references comfortably under this so the encoded wallet always fits.
 */
export const PAYCREST_REFERENCE_MAX_LENGTH = 70;

/**
 * Builds the `reference` we attach to a Paycrest order so History can tie it
 * back to the connected wallet. Paycrest overrides the off-ramp refundAddress
 * to our account default, so the wallet isn't otherwise recoverable from the
 * order — we encode it here and match on it in orderMatchesWallet.
 *
 * Kept short on purpose. EVM addresses are 42 chars, but Starknet addresses
 * can be 66; embedding the latter plus a timestamp exceeds Paycrest's 70-char
 * limit. Long addresses use a stable, human-inspectable prefix/suffix key.
 */
export function buildPaycrestReference(
  direction: PaycrestDirection,
  address: string | undefined
): string {
  const wallet = paycrestReferenceWalletKey(address);
  const tag = direction === "offramp" ? "off" : "on";
  return `sw-${tag}-${wallet}-${Date.now()}`;
}

/**
 * Server-side guard: keep a reference within Paycrest's 70-char limit WITHOUT
 * losing its wallet-matching use. A correct client already sends a short,
 * reduced reference; but a stale bundle can send the old un-reduced form
 * (`sw-on-<full-starknet-felt>-<ts>`), which is 86 chars. Truncating that would
 * corrupt the wallet key `orderMatchesWallet` searches for, so instead we
 * rebuild from the known address — same reduced key, guaranteed under the cap.
 */
export function fitPaycrestReference(
  reference: unknown,
  direction: PaycrestDirection,
  address: string | undefined
): string | undefined {
  if (typeof reference !== "string" || !reference) return undefined;
  if (reference.length <= PAYCREST_REFERENCE_MAX_LENGTH) return reference;
  return buildPaycrestReference(direction, address);
}

/** Key encoded in a Paycrest reference; always leaves room for its timestamp. */
function paycrestReferenceWalletKey(address: string | undefined): string {
  const wallet = address?.toLowerCase() ?? "anon";
  // Preserve full EVM addresses for existing History matching. A Starknet
  // address is 66 characters, so retain enough of both ends to identify it
  // without exceeding the provider's strict reference limit.
  return wallet.length <= 42
    ? wallet
    : `${wallet.slice(0, 12)}-${wallet.slice(-12)}`;
}

/** True when the connected wallet is the refund (off-ramp) or recipient (on-ramp) address. */
export function orderMatchesWallet(
  payload: Record<string, unknown>,
  address: string
): boolean {
  const want = address.toLowerCase();

  // Primary signal: the wallet we encoded in the order reference at creation.
  // Survives Paycrest overriding the off-ramp refundAddress to our account.
  const reference = payload.reference;
  if (
    typeof reference === "string" &&
    reference.toLowerCase().includes(paycrestReferenceWalletKey(want))
  ) {
    return true;
  }

  const source = payload.source as Record<string, unknown> | undefined;
  const destination = payload.destination as
    Record<string, unknown> | undefined;

  if (source?.type === "crypto") {
    const refund = source.refundAddress;
    if (typeof refund === "string" && refund.toLowerCase() === want) {
      return true;
    }
  }
  if (destination?.type === "crypto") {
    const recipient = destination.recipient as { address?: string } | undefined;
    if (
      typeof recipient?.address === "string" &&
      recipient.address.toLowerCase() === want
    ) {
      return true;
    }
  }

  // Legacy v1 list shape (kept for safety).
  const recipient = (payload.recipient as Record<string, unknown>) ?? {};
  const legacy = [
    payload.refundAddress,
    payload.returnAddress,
    payload.fromAddress,
    recipient.address,
  ];
  return legacy.some((c) => typeof c === "string" && c.toLowerCase() === want);
}

/** Normalises a v2 order payload into the History list shape. */
export function summarizePaycrestOrderForHistory(
  payload: Record<string, unknown>
): PaycrestHistoryOrder {
  const order = normalizePaycrestOrder(payload);
  const source = payload.source as Record<string, unknown> | undefined;
  const destination = payload.destination as
    Record<string, unknown> | undefined;
  const providerAccount = payload.providerAccount as
    Record<string, unknown> | undefined;
  const fiatRecipient =
    destination?.type === "fiat"
      ? (destination.recipient as Record<string, unknown> | undefined)
      : undefined;
  const refundAccount =
    source?.type === "fiat"
      ? (source.refundAccount as Record<string, unknown> | undefined)
      : undefined;

  const network =
    order.direction === "onramp"
      ? (extractCryptoRecipientNetwork(
          destination as { type?: string; recipient?: unknown }
        ) ?? "")
      : String(
          (source as { network?: string } | undefined)?.network ??
            providerAccount?.network ??
            payload.network ??
            ""
        );

  const token =
    order.direction === "onramp"
      ? order.currency || "USDC"
      : String(
          (source as { currency?: string } | undefined)?.currency ?? "USDC"
        );

  const fiatCurrency =
    order.direction === "onramp"
      ? (order.depositCurrency ??
        String((source as { currency?: string } | undefined)?.currency ?? ""))
      : String(
          (destination as { currency?: string } | undefined)?.currency ?? ""
        );

  const fiatAmount =
    order.direction === "onramp" && order.amountToTransfer
      ? Number(order.amountToTransfer)
      : order.rate && order.amount
        ? Number(order.amount) * Number(order.rate)
        : null;

  return {
    id: order.id,
    direction: order.direction,
    status: order.status,
    amount: order.amount,
    token,
    network,
    rate: order.rate ?? null,
    currency: fiatCurrency || null,
    fiatAmount: Number.isFinite(fiatAmount as number) ? fiatAmount : null,
    recipientName:
      typeof fiatRecipient?.accountName === "string"
        ? fiatRecipient.accountName
        : null,
    institution:
      typeof fiatRecipient?.institutionName === "string"
        ? fiatRecipient.institutionName
        : typeof fiatRecipient?.institution === "string"
          ? fiatRecipient.institution
          : null,
    accountIdentifier:
      typeof fiatRecipient?.accountIdentifier === "string"
        ? fiatRecipient.accountIdentifier
        : null,
    recipientAddress: order.recipientAddress ?? null,
    receiveAddress: order.receiveAddress ?? null,
    depositAccountIdentifier: order.depositAccountIdentifier ?? null,
    refundInstitution:
      typeof refundAccount?.institution === "string"
        ? refundAccount.institution
        : null,
    refundInstitutionName:
      typeof refundAccount?.institutionName === "string"
        ? refundAccount.institutionName
        : null,
    refundAccountIdentifier:
      typeof refundAccount?.accountIdentifier === "string"
        ? refundAccount.accountIdentifier
        : null,
    refundAccountName:
      typeof refundAccount?.accountName === "string"
        ? refundAccount.accountName
        : null,
    txHash: order.txHash ?? null,
    createdAt: order.createdAt ?? null,
  };
}

/** Top-level txHash, or the latest non-empty hash from transactionLogs. */
function extractSettlementTxHash(
  payload: Record<string, unknown>
): string | undefined {
  if (typeof payload.txHash === "string" && payload.txHash) {
    return payload.txHash;
  }
  const logs = payload.transactionLogs;
  if (!Array.isArray(logs)) return undefined;
  for (let i = logs.length - 1; i >= 0; i--) {
    const tx = (logs[i] as { tx_hash?: string })?.tx_hash;
    if (typeof tx === "string" && tx) return tx;
  }
  return undefined;
}
