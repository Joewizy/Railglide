/**
 * Buyer details for Paycrest Buy (on-ramp) orders.
 *
 * Since October 2026 Paycrest rejects a Buy order unless it says who is paying
 * in (`source.kyc`). It's needed on EVERY Buy order — Paycrest doesn't keep a
 * customer profile — so the apps save these details on the device and refill
 * them next time. Sell (off-ramp) orders don't need any of this.
 *
 * The buyer's name is NOT asked for: we use the verified name on the refund
 * bank account. Paycrest requires those two names to match, so reusing the
 * bank's own name means they always do.
 *
 * Docs: https://docs.paycrest.io/implementation-guides/sender-api-integration#on-ramp-customer-kyc
 */

export type BuyerIdType = "passport" | "nationalID" | "driverLicense";

/** What the buyer types in on the Buy review step. */
export interface BuyerDetails {
  /** Date of birth, YYYY-MM-DD. Must be 18 or older. */
  birthDate: string;
  /** Nigeria (NGN) only — National Identification Number, 11 digits. */
  nin?: string;
  /** Kenya (KES) only — the M-Pesa number the payment prompt is sent to. */
  phone?: string;
  /** Everywhere except Nigeria — which ID the buyer is using. */
  idType?: BuyerIdType;
  /** Everywhere except Nigeria — the number on that ID. */
  idNumber?: string;
  /** Everywhere except Nigeria — the country that issued the ID (e.g. "GH"). */
  idCountry?: string;
}

export const BUYER_ID_TYPES: { value: BuyerIdType; label: string }[] = [
  { value: "nationalID", label: "National ID" },
  { value: "passport", label: "Passport" },
  { value: "driverLicense", label: "Driver's licence" },
];

/** The country each currency's ID is usually issued in. XOF has no single one. */
const CURRENCY_COUNTRY: Record<string, string> = {
  NGN: "NG",
  KES: "KE",
  GHS: "GH",
  UGX: "UG",
  ZMW: "ZM",
  TZS: "TZ",
  ZAR: "ZA",
};

/** West African CFA (XOF) countries, for the ID country picker. */
export const XOF_COUNTRIES: { code: string; name: string }[] = [
  { code: "SN", name: "Senegal" },
  { code: "CI", name: "Côte d'Ivoire" },
  { code: "BJ", name: "Benin" },
  { code: "TG", name: "Togo" },
  { code: "ML", name: "Mali" },
  { code: "BF", name: "Burkina Faso" },
  { code: "NE", name: "Niger" },
  { code: "GW", name: "Guinea-Bissau" },
];

export function defaultIdCountry(currency: string): string {
  return CURRENCY_COUNTRY[currency.toUpperCase()] ?? "";
}

/** The ID's issuing country: fixed by the currency, except XOF where the buyer picks. */
function idCountryFor(currency: string, details: BuyerDetails): string {
  return (defaultIdCountry(currency) || details.idCountry || "").toUpperCase();
}

/**
 * Nigeria asks for the NIN; every other currency asks for an ID document.
 * Paycrest's docs also list the BVN, but the live API (checked 2026-10-10)
 * accepts the NIN on its own, so we don't ask for it.
 */
export function asksForNin(currency: string): boolean {
  return currency.toUpperCase() === "NGN";
}

/** Kenya also needs the buyer's phone number. */
export function needsKenyanPhone(currency: string): boolean {
  return currency.toUpperCase() === "KES";
}

/** Strip spaces and dashes so "222 1234 5678" checks as 11 digits. */
function digitsOnly(value: string | undefined): string {
  return (value ?? "").replace(/[\s-]/g, "");
}

/**
 * Turn a Kenyan number typed any common way (0712…, 712…, 254712…, +254712…)
 * into +254712…. Returns "" if it isn't a Kenyan mobile number.
 */
export function toKenyanPhone(value: string | undefined): string {
  let n = digitsOnly(value).replace(/^\+/, "");
  if (n.startsWith("254")) n = n.slice(3);
  else if (n.startsWith("0")) n = n.slice(1);
  return /^[17]\d{8}$/.test(n) ? `+254${n}` : "";
}

/** Age in whole years on today's date, or null if the date isn't real. */
function ageFrom(birthDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
  const [y, m, d] = birthDate.split("-").map(Number);
  const born = new Date(Date.UTC(y, m - 1, d));
  if (born.getUTCMonth() !== m - 1 || born.getUTCDate() !== d) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  const hadBirthday =
    now.getUTCMonth() > m - 1 ||
    (now.getUTCMonth() === m - 1 && now.getUTCDate() >= d);
  if (!hadBirthday) age -= 1;
  return age;
}

/**
 * Check the buyer's details for a currency. Returns a list of plain-English
 * problems; an empty list means the details are good to send.
 */
export function checkBuyerDetails(
  currency: string,
  details: BuyerDetails | null | undefined
): string[] {
  const d = details ?? { birthDate: "" };
  const problems: string[] = [];

  const age = ageFrom(d.birthDate ?? "");
  if (age === null) problems.push("Enter your date of birth.");
  else if (age < 18) problems.push("You must be 18 or older to buy.");
  else if (age > 120) problems.push("Check your date of birth.");

  if (asksForNin(currency)) {
    if (!/^\d{11}$/.test(digitsOnly(d.nin))) {
      problems.push("Your NIN must be 11 digits.");
    }
  } else {
    if (!d.idType) problems.push("Choose an ID type.");
    if (!(d.idNumber ?? "").trim()) problems.push("Enter your ID number.");
    if (!/^[A-Z]{2}$/.test(idCountryFor(currency, d))) {
      problems.push("Choose the country that issued your ID.");
    }
  }

  if (needsKenyanPhone(currency) && !toKenyanPhone(d.phone)) {
    problems.push("Enter your Kenyan M-Pesa number, e.g. 0712 345 678.");
  }

  return problems;
}

/**
 * Build the `source.kyc` object Paycrest expects. Call only after
 * checkBuyerDetails() returned no problems. `fullName` is the verified name on
 * the refund account.
 */
export function toPaycrestKyc(
  currency: string,
  fullName: string,
  details: BuyerDetails
): Record<string, unknown> {
  const idDocument = asksForNin(currency)
    ? { type: "nationalID", number: digitsOnly(details.nin), issuerCountry: "NG" }
    : {
        type: details.idType,
        number: (details.idNumber ?? "").trim(),
        issuerCountry: idCountryFor(currency, details),
      };

  return {
    entityType: "person",
    personDetails: {
      fullName: fullName.trim(),
      birthDate: details.birthDate,
      idDocument,
      ...(needsKenyanPhone(currency)
        ? { contact: { phoneE164: toKenyanPhone(details.phone) } }
        : {}),
    },
  };
}

/** Only the fields that matter for this currency — what we send and save. */
export function trimBuyerDetails(
  currency: string,
  details: BuyerDetails
): BuyerDetails {
  return {
    birthDate: details.birthDate,
    ...(asksForNin(currency)
      ? { nin: digitsOnly(details.nin) }
      : {
          idType: details.idType,
          idNumber: (details.idNumber ?? "").trim(),
          idCountry: idCountryFor(currency, details),
        }),
    ...(needsKenyanPhone(currency) ? { phone: toKenyanPhone(details.phone) } : {}),
  };
}

/** Copy shown next to the form on both apps. */
export function buyerDetailsNote(currency: string): string {
  return asksForNin(currency)
    ? "Use the NIN that matches the name on your bank account, so your order isn't rejected or delayed."
    : "Use an ID that matches the name on your account, so your order isn't rejected or delayed.";
}

/** Show only the last 4 characters, e.g. "•••• 8901". */
function lastFour(value: string | undefined): string {
  const v = (value ?? "").replace(/[\s-]/g, "");
  return v ? `•••• ${v.slice(-4)}` : "";
}

/** Masked one-liner for the collapsed view, e.g. "NIN •••• 8901". */
export function buyerDetailsSummary(
  currency: string,
  details: BuyerDetails
): string {
  return asksForNin(currency)
    ? `NIN ${lastFour(details.nin)}`
    : `${BUYER_ID_TYPES.find((t) => t.value === details.idType)?.label ?? "ID"} ${lastFour(details.idNumber)}`;
}
