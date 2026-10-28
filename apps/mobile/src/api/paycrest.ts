// Paycrest endpoint wrappers → backend routes (server holds the API key).
import type { BuyerDetails } from "@railglide/shared/kyc";
import { apiFetch } from "./client";
import type {
  PaycrestFiat,
  PaycrestInstitution,
  PaycrestOrder,
  PaycrestRecipient,
  PaycrestToken,
} from "@/rails/paycrest";

export interface RateResponse {
  rate: number;
  fiat: string;
  token: string;
}

/**
 * Live unit rate (fiat per 1 token). The exact rate locks at order creation.
 * Buy and Sell have different rates (buy is higher), so pass the side.
 */
export function getRate(
  fiat: PaycrestFiat,
  token: PaycrestToken,
  side: "buy" | "sell" = "sell"
): Promise<RateResponse> {
  return apiFetch<RateResponse>(
    `/api/paycrest/rate?fiat=${fiat}&token=${token}&side=${side}`
  );
}

/** Payout institutions (banks + mobile money) for a currency. */
export async function getInstitutions(
  currency: PaycrestFiat
): Promise<PaycrestInstitution[]> {
  const res = await apiFetch<{ institutions: PaycrestInstitution[] }>(
    `/api/paycrest/institutions?currency=${currency}`
  );
  return res.institutions;
}

/** Resolve the real account holder's name for an institution + account number. */
export async function verifyAccount(
  institution: string,
  accountIdentifier: string
): Promise<string> {
  const res = await apiFetch<{ accountName: string }>(
    "/api/paycrest/verify-account",
    {
      method: "POST",
      body: JSON.stringify({ institution, accountIdentifier }),
    }
  );
  return res.accountName;
}

export interface CreateOfframpBody {
  direction: "offramp";
  amount: string;
  token: PaycrestToken;
  /** Paycrest network slug, e.g. "base". */
  network: string;
  refundAddress: `0x${string}`;
  currency: PaycrestFiat;
  recipient: PaycrestRecipient;
  reference?: string;
}

export function createOfframpOrder(
  body: CreateOfframpBody
): Promise<PaycrestOrder> {
  return apiFetch<PaycrestOrder>("/api/paycrest/order", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface CreateOnrampBody {
  direction: "onramp";
  amount: string;
  amountIn?: "fiat" | "crypto";
  fiatCurrency: PaycrestFiat;
  refundAccount: PaycrestRecipient;
  /** Date of birth + NIN (or ID) — required on every Buy order. */
  buyer: BuyerDetails;
  token: PaycrestToken;
  network: string;
  recipientAddress: `0x${string}`;
  reference?: string;
}

export function createOnrampOrder(
  body: CreateOnrampBody
): Promise<PaycrestOrder> {
  return apiFetch<PaycrestOrder>("/api/paycrest/order", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getOrder(id: string): Promise<PaycrestOrder> {
  return apiFetch<PaycrestOrder>(`/api/paycrest/order/${id}`);
}
