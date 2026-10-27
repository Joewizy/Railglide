/**
 * Number & money formatting helpers.
 *
 * Pure display formatting — thousands separators, token amounts, and
 * local-currency symbols. No chain or network access.
 */

/** Local-currency symbols for the supported payout corridors. */
export const FIAT_SYMBOLS: Record<string, string> = {
  NGN: "₦",
  KES: "KSh",
  GHS: "₵",
  UGX: "USh",
  XOF: "CFA",
  ZMW: "ZK",
  TZS: "TSh",
  ZAR: "R",
  INR: "₹",
  MWK: "MK",
};

/** Full names for the supported payout currencies. */
export const FIAT_NAMES: Record<string, string> = {
  NGN: "Nigerian Naira",
  KES: "Kenyan Shilling",
  GHS: "Ghanaian Cedi",
  UGX: "Ugandan Shilling",
  XOF: "West African CFA Franc",
  ZMW: "Zambian Kwacha",
  TZS: "Tanzanian Shilling",
  ZAR: "South African Rand",
  INR: "Indian Rupee",
  MWK: "Malawian Kwacha",
};

/** Flag emoji per supported payout currency (multi-country regions omitted). */
const FIAT_FLAGS: Record<string, string> = {
  NGN: "🇳🇬",
  KES: "🇰🇪",
  GHS: "🇬🇭",
  UGX: "🇺🇬",
  ZMW: "🇿🇲",
  TZS: "🇹🇿",
  ZAR: "🇿🇦",
  INR: "🇮🇳",
  MWK: "🇲🇼",
};

/** Home country of each single-country currency, for flags and picker rows. */
export const FIAT_HOME_COUNTRY: Record<
  string,
  { countryCode: string; countryName: string }
> = {
  NGN: { countryCode: "NG", countryName: "Nigeria" },
  KES: { countryCode: "KE", countryName: "Kenya" },
  UGX: { countryCode: "UG", countryName: "Uganda" },
  TZS: { countryCode: "TZ", countryName: "Tanzania" },
  GHS: { countryCode: "GH", countryName: "Ghana" },
  ZMW: { countryCode: "ZM", countryName: "Zambia" },
  ZAR: { countryCode: "ZA", countryName: "South Africa" },
  INR: { countryCode: "IN", countryName: "India" },
  MWK: { countryCode: "MW", countryName: "Malawi" },
};

/** Flag emoji for a two-letter country code, e.g. "IN" → "🇮🇳". */
export function countryFlag(countryCode: string): string {
  return [...countryCode.toUpperCase()]
    .map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
    .join("");
}

/** Dropdown label for a currency, e.g. "🇳🇬  NGN — Nigerian Naira". */
export function fiatOptionLabel(code: string): string {
  const c = code.toUpperCase();
  const name = FIAT_NAMES[c];
  const label = name ? `${c} — ${name}` : c;
  const flag = FIAT_FLAGS[c];
  return flag ? `${flag}  ${label}` : label;
}

/** Short, friendly currency names for inline prose. */
export const FIAT_SHORT_NAMES: Record<string, string> = {
  NGN: "Naira",
  KES: "Kenyan Shilling",
  GHS: "Cedi",
  UGX: "Ugandan Shilling",
  XOF: "CFA Franc",
  ZMW: "Kwacha",
  TZS: "Tanzanian Shilling",
  ZAR: "Rand",
  INR: "Rupee",
  MWK: "Malawian Kwacha",
};

/** Inline currency label, e.g. "Naira (NGN)" (falls back to the code). */
export function currencyLabel(code: string): string {
  const name = FIAT_SHORT_NAMES[code.toUpperCase()];
  return name ? `${name} (${code.toUpperCase()})` : code;
}

/** Symbol shown before fiat amounts in inputs, e.g. NGN → "₦". */
export function fiatSymbol(code: string): string {
  return FIAT_SYMBOLS[code.toUpperCase()] ?? "";
}

/** ISO timestamp → "Mon, Jun 11, 8:41 PM" (empty for invalid input). */
export function formatDeadline(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Title-cases ALL-CAPS or lowercase names: "JOSEPH SHUNOM GIMBA" → "Joseph Shunom Gimba". */
export function titleCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Milliseconds left → "48:32" (or "1:02:30" past an hour). Clamps at 0. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Masks an account number to its last 4: "0123454020" → "····4020". */
export function maskAccount(id: string): string {
  const last4 = id.replace(/\s+/g, "").slice(-4);
  return last4 ? `····${last4}` : id;
}

/** "10000" → "10,000". Accepts a number or numeric string. */
export function formatNumber(
  value: number | string,
  maxFractionDigits = 2
): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits });
}

/** "10000", "USDC" → "10,000 USDC". */
export function formatToken(
  value: number | string,
  symbol: string,
  maxFractionDigits = 4
): string {
  return `${formatNumber(value, maxFractionDigits)} ${symbol}`;
}

/** "NGN", 136490 → "₦136,490.00" (falls back to "NGN 136,490.00"). */
export function formatFiat(code: string, amount: number | string): string {
  const sym = FIAT_SYMBOLS[code.toUpperCase()];
  const n = formatNumber(amount, 2);
  return sym ? `${sym}${n}` : `${code} ${n}`;
}

/** The dollar-pegged stablecoins we show a leading "$" for. */
export function isStableToken(symbol: string): boolean {
  return symbol === "USDC" || symbol === "USDT";
}

/** Stablecoin amount with a leading $, e.g. (2, "USDC") → "$2 USDC". */
export function formatStable(
  value: number | string,
  symbol: string,
  maxFractionDigits = 4
): string {
  return `$${formatToken(value, symbol, maxFractionDigits)}`;
}

/**
 * Amount + symbol with the right currency sign in front: "$" for stablecoins,
 * the local sign for supported fiat (₦, KSh…), nothing otherwise.
 * e.g. "$2 USDC", "₦5,000 NGN", "0.04 ETH".
 */
export function formatMoney(
  value: number | string,
  symbol: string,
  maxFractionDigits = 4
): string {
  if (isStableToken(symbol)) return formatStable(value, symbol, maxFractionDigits);
  const sym = FIAT_SYMBOLS[symbol.toUpperCase()];
  const body = formatToken(value, symbol, maxFractionDigits);
  return sym ? `${sym}${body}` : body;
}

/**
 * Formats a raw numeric input string for display, grouping the integer part
 * with commas while keeping the fractional part exactly as typed so a
 * controlled input stays editable: "5000" → "5,000", "5000.5" → "5,000.5",
 * "5000." → "5,000.". Expects the stored value to hold digits + at most one
 * dot (no commas).
 */
export function formatAmountInput(raw: string): string {
  if (!raw) return "";
  const [intPart, ...rest] = raw.split(".");
  const intFmt = intPart ? Number(intPart).toLocaleString("en-US") : "";
  return raw.includes(".") ? `${intFmt || "0"}.${rest.join("")}` : intFmt;
}

/** A quote's rate string "1,379.15 NGN/USDC" → "1 USDC ≈ 1,379.15 NGN". */
export function formatQuoteRate(rate: string | null): string | null {
  if (!rate) return null;
  const m = rate.match(/^([\d,.]+)\s+(\w+)\/(\w+)$/);
  return m ? `1 ${m[3]} ≈ ${m[1]} ${m[2]}` : rate;
}
