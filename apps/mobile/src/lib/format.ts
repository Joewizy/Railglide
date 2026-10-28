/**
 * Fiat / money display helpers — mirrors web `utils/format.ts` for the corridors
 * Paycrest supports. Keep symbols in sync when adding a currency.
 */

const FIAT_SYMBOLS: Record<string, string> = {
  NGN: "₦",
  KES: "KSh",
  GHS: "₵",
  UGX: "USh",
  XOF: "CFA",
  ZMW: "ZK",
  TZS: "TSh",
  ZAR: "R",
};

/** Symbol shown before fiat amounts, e.g. NGN → "₦". */
export function fiatSymbol(code: string): string {
  return FIAT_SYMBOLS[code.toUpperCase()] ?? "";
}

/** "NGN", 136490 → "₦136,490" (falls back to "NGN 136,490"). */
export function formatFiat(code: string, amount: number | string): string {
  const num = typeof amount === "string" ? Number(amount) : amount;
  const n =
    typeof amount === "string" && !Number.isFinite(num)
      ? amount
      : num.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const sym = fiatSymbol(code);
  return sym ? `${sym}${n}` : `${code} ${n}`;
}

/** Flag, country and currency name per payout currency, for the pickers. */
export const FIAT_INFO: Record<
  string,
  { flag: string; country: string; name: string }
> = {
  NGN: { flag: "🇳🇬", country: "Nigeria", name: "Nigerian Naira" },
  KES: { flag: "🇰🇪", country: "Kenya", name: "Kenyan Shilling" },
  UGX: { flag: "🇺🇬", country: "Uganda", name: "Ugandan Shilling" },
  TZS: { flag: "🇹🇿", country: "Tanzania", name: "Tanzanian Shilling" },
  GHS: { flag: "🇬🇭", country: "Ghana", name: "Ghanaian Cedi" },
  ZMW: { flag: "🇿🇲", country: "Zambia", name: "Zambian Kwacha" },
  ZAR: { flag: "🇿🇦", country: "South Africa", name: "South African Rand" },
  INR: { flag: "🇮🇳", country: "India", name: "Indian Rupee" },
  MWK: { flag: "🇲🇼", country: "Malawi", name: "Malawian Kwacha" },
};

/** "NG" → "🇳🇬" (any ISO country code). */
export function flagEmoji(countryCode: string): string {
  return countryCode
    .toUpperCase()
    .replace(/[A-Z]/g, (ch) => String.fromCodePoint(127397 + ch.charCodeAt(0)));
}

/** 1240.5, "USDC" → "1,240.50 USDC". */
export function formatToken(amount: number | string, token: string, decimals = 2): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${token}`;
  return `${n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} ${token}`;
}
