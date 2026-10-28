// ChainRails ramp endpoint wrappers → backend routes (server holds the API key).
// Mirrors the fetch calls the web ChainRails panels make; mobile hits the same
// Next.js routes via apiFetch.
import { apiFetch } from "./client";

export interface RampCurrency {
  code: string;
  name: string;
  symbol: string;
  minAmount: number;
}

export interface RampCountry {
  countryCode: string;
  name: string;
  currency: RampCurrency;
}

export interface RampFieldOption {
  label: string;
  value: string;
  iconUrl?: string | null;
  featured?: boolean | null;
}

export interface RampFieldSpec {
  key: string;
  label: string;
  type: string; // "phone" | "string" | "enum" | ...
  required?: boolean;
  options?: RampFieldOption[];
}

interface PaymentChannel {
  id?: string;
  name?: string;
  channel?: string;
  transferType?: string;
  directTransferDetails?: { fieldsRequired?: RampFieldSpec[] };
}

/** On-ramp quote (fiat → crypto). Rate lives under either key by response shape. */
export interface RampQuote {
  provider: string;
  quoteId?: string;
  fiatCurrency: string;
  fiatAmount: number;
  cryptoCurrency: string;
  cryptoAmount: number;
  exchangeRate?: number;
  exchangeRatePerUSD?: number;
  totalFeesFiat?: number;
  paymentChannels?: PaymentChannel[];
  rampChain: string;
  requiresBridge: boolean;
}

/** Off-ramp quote (crypto → fiat). */
export interface OffRampQuote {
  provider: string;
  quoteId: string;
  fiatCurrency: string;
  fiatAmount: number;
  exchangeRatePerUSD: number;
  cryptoCurrency: string;
  cryptoAmount: number;
  grossDepositAmount: number;
  depositChain: string;
  requiresBridge: boolean;
  paymentChannels: PaymentChannel[];
  totalFeesFiat: number;
}

/** The live order fields read back from the orders routes. */
export interface RampOrder {
  id: number | string;
  status: string;
  provider?: string;
  fiatCurrency?: string;
  fiatAmount?: number;
  cryptoCurrency?: string;
  cryptoAmount?: number;
  destinationChain?: string;
  recipientAddress?: string;
  widgetUrl?: string;
  expiresAt?: string;
  createdAt?: string;
  providerTxHash?: string | null;
  intentAddress?: string;
  grossDepositAmount?: number;
  depositChain?: string;
  /** Bank-transfer providers (e.g. PAYCREST) return the account to pay into here
   *  instead of a hosted checkout URL. */
  transferInstructions?: TransferInstructions;
}

/** The bank account the buyer transfers fiat to, straight from the provider. */
export interface TransferInstructions {
  currency?: string;
  accountName?: string;
  institution?: string;
  amountToTransfer?: string;
  accountIdentifier?: string;
}

interface QuoteResponse<T> {
  recommended?: T | null;
  quotes?: T[];
  providersQueried?: number;
}

/** Fiat/currency catalogue for the ramp forms. */
export async function getRampCountries(): Promise<RampCountry[]> {
  const res = await apiFetch<{ countries: RampCountry[] }>(
    "/api/chainrails/ramp/countries"
  );
  return res.countries ?? [];
}

/** Pick the recommended quote, else the first one, else null. */
function selectQuote<T>(res: QuoteResponse<T>): T | null {
  return res.recommended ?? res.quotes?.[0] ?? null;
}

export interface OnrampQuoteBody {
  fiatCurrency: string;
  cryptoAmount: number;
  destinationChain: string;
  countryCode: string;
}

/** On-ramp quote — returns the selected quote (or null if none can fill it). */
export async function getRampQuote(
  body: OnrampQuoteBody
): Promise<RampQuote | null> {
  const res = await apiFetch<QuoteResponse<RampQuote>>(
    "/api/chainrails/ramp/quote",
    { method: "POST", body: JSON.stringify(body) }
  );
  return selectQuote(res);
}

export interface OfframpQuoteBody {
  fiatCurrency: string;
  cryptoAmount: number;
  sourceChain: string;
  countryCode: string;
}

/** Off-ramp quote — gated server-side behind Fiat KYB (503 while paused). */
export async function getOfframpQuote(
  body: OfframpQuoteBody
): Promise<OffRampQuote | null> {
  const res = await apiFetch<QuoteResponse<OffRampQuote>>(
    "/api/chainrails/ramp/offramp-quote",
    { method: "POST", body: JSON.stringify(body) }
  );
  return selectQuote(res);
}

export interface CreateRampOrderBody {
  type: "on-ramp" | "off-ramp";
  provider: string;
  fiatCurrency: string;
  cryptoAmount: number;
  countryCode: string;
  // On-ramp:
  destinationChain?: string;
  recipientAddress?: string;
  // Off-ramp:
  sourceChain?: string;
  senderAddress?: string;
  // KYB email is a TOP-LEVEL field (the provider 403s if nested in `fields`).
  userEmail?: string;
  // Channel-specific values (phone, bankCode, account) from the quote's fields.
  fields?: Record<string, string>;
}

export function createRampOrder(
  body: CreateRampOrderBody
): Promise<RampOrder> {
  return apiFetch<RampOrder>("/api/chainrails/ramp/orders", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getRampOrder(id: string | number): Promise<RampOrder> {
  return apiFetch<RampOrder>(`/api/chainrails/ramp/orders/${id}`);
}
