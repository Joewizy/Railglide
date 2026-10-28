"use client";

/**
 * ChainrailsSellPanel — off-ramp (crypto → fiat) for chains Paycrest can't
 * reach (Solana, Tron, Optimism, Avalanche, Monad, HyperEVM).
 *
 * The payout bank list is DYNAMIC: the quote returns each provider's
 * `paymentChannels[].directTransferDetails.fieldsRequired`, where the
 * `bankCode` field is an enum whose options are the banks. We render those
 * fields straight from the quote, then send the chosen values in the order's
 * `fields`. Delivery is manual: the order returns a deposit address the user
 * sends their crypto to (no in-app signing on these chains).
 *
 * NOTE: this whole panel is currently unreachable — off-ramp is paused behind
 * `CHAINRAILS_OFFRAMP_ENABLED` (false) until RailGlide completes Fiat KYB with
 * the provider. The order payload is correct (`userEmail` top-level, no
 * `quoteId`); it's the account-level KYB, not the request, that's outstanding.
 */

import React, { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { cachedFetch, ONE_HOUR } from "@/lib/cachedFetch";
import {
  formatNumber,
  formatToken,
  fiatSymbol,
  currencyLabel,
} from "@/utils";
import {
  classifyRampStatus,
  isBelowRampMinimum,
  isValidRampAddress,
  toE164,
  type RampCountry,
  type RampDestination,
  type RampOrderPhase,
} from "@/rails/chainrails";
import { useRampCountries } from "@/hooks/useRampCountries";
import { pollRampOrder } from "@/lib/chainrailsPoll";
import { getChainIcon, getTokenIcon } from "@/utils/icons";
import { InfoHint, AccountNameStatus } from "../SendScreen";
import { isPaycrestFiat, type PaycrestInstitution } from "@/rails/paycrest";
import {
  AmountField,
  ArrowRight,
  CurrencyPill,
  Notice,
  PrimaryButton,
  RateLine,
} from "../ui/sendKit";
import { CurrencyPicker, type CountryOption } from "../ui/sendPickers";
import { ExpiredOrder } from "../ui/ExpiredOrder";
import { Icon } from "../icons";
import { linkRampOrder, trackRampOrder } from "../chainrailsOrders";
import { EMAIL_RE, loadSavedEmail, saveEmail } from "../rampEmail";
import { fetchKycState, type KycCorridor, type KycState } from "../rampKyc";
import { KycVerification } from "./KycVerification";

/** Colored Iconify name for a token, or null when there's no real logo. */
function tokenLogo(symbol: string): string | null {
  const name = getTokenIcon(symbol);
  if (name.startsWith("material-symbols:")) return null;
  return name.startsWith("cryptocurrency:")
    ? name.replace("cryptocurrency:", "cryptocurrency-color:")
    : name;
}

/**
 * The exact amount to deposit. ChainRails' live order has moved this between
 * field names across versions, so we scan the likely candidates and take the
 * first positive number rather than trusting one key.
 */
function pickDepositAmount(order: Record<string, unknown>): number | undefined {
  const keys = [
    "grossDepositAmount",
    "intentAmount",
    "depositAmount",
    "sourceAmount",
    "cryptoAmount",
    "amount",
  ];
  for (const k of keys) {
    const n = Number(order[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** Strips the trailing bank code from a label ("OPay (100004)" -> "OPay"). */
function cleanOptionLabel(label: string): string {
  return label.replace(/\s*\(\s*\d[\d\s-]*\)\s*$/, "").trim() || label;
}

/** Fiat payout for a quote; ChainRails omits it, so we derive amount × rate. */
function pickFiatAmount(quote: OffQuote): number | undefined {
  if (Number.isFinite(quote.fiatAmount) && quote.fiatAmount > 0)
    return quote.fiatAmount;
  const rate = Number(quote.exchangeRatePerUSD);
  const crypto = Number(quote.cryptoAmount);
  if (rate > 0 && crypto > 0) {
    const fees = Number(quote.totalFeesFiat);
    const gross = crypto * rate;
    return fees > 0 ? Math.max(gross - fees, 0) : gross;
  }
  return undefined;
}

/** Colored Iconify name for a chain (e.g. "Solana"), or null when unavailable. */
function chainLogo(label: string): string | null {
  const name = getChainIcon(label);
  if (name.startsWith("material-symbols:")) return null;
  return name.startsWith("cryptocurrency:")
    ? name.replace("cryptocurrency:", "cryptocurrency-color:")
    : name;
}

/** Real token logo via the Iconify SVG API; hides itself if it 404s. */
function AssetLogo({ name, size }: { name: string | null; size: number }) {
  if (!name) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://api.iconify.design/${name}.svg`}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      style={{ display: "block", borderRadius: 999, flex: "0 0 auto" }}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

/** Warm, desaturated confetti in the brand palette — never candy-bright. */
const CONFETTI_COLORS = [
  "var(--accent)",
  "var(--ok)",
  "var(--pend)",
  "#c9a23f",
];

/**
 * A subtle one-shot confetti burst behind the payout hero. Pieces are randomized
 * once (so polling re-renders don't re-scatter them) and the CSS respects
 * `prefers-reduced-motion`.
 */
function Confetti({ count = 16 }: { count?: number }) {
  const [pieces] = useState(() =>
    Array.from({ length: count }, (_, i) => ({
      left: Math.round(6 + Math.random() * 88),
      dx: Math.round(-70 + Math.random() * 140),
      rot: Math.round(200 + Math.random() * 340),
      delay: Math.round(Math.random() * 260),
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      w: 5 + Math.round(Math.random() * 4),
      h: 9 + Math.round(Math.random() * 5),
    }))
  );
  return (
    <div className="confetti-layer" aria-hidden>
      {pieces.map((p, i) => (
        <span
          key={i}
          className="confetti-piece"
          style={{
            left: `${p.left}%`,
            width: p.w,
            height: p.h,
            background: p.color,
            animationDelay: `${p.delay}ms`,
            ["--dx" as string]: `${p.dx}px`,
            ["--rot" as string]: `${p.rot}deg`,
          }}
        />
      ))}
    </div>
  );
}

type FieldOption = {
  label: string;
  value: string;
  iconUrl?: string | null;
  featured?: boolean | null;
};

type FieldSpec = {
  key: string;
  label: string;
  type: string; // "phone" | "string" | "enum" | ...
  required?: boolean;
  options?: FieldOption[];
};

type PaymentChannel = {
  channel: string;
  transferType: string;
  directTransferDetails?: { fieldsRequired?: FieldSpec[] };
};

/**
 * True when a quote's amount matches its own rate. Some providers return
 * broken figures (Yellow Card USDT on BNB came back as ₦13,560,746,678,835,888
 * for 10 USDT), so we never show or use those.
 */
function isSaneQuote(q: {
  fiatAmount: number;
  cryptoAmount: number;
  exchangeRatePerUSD: number;
}): boolean {
  const rate = Number(q.exchangeRatePerUSD);
  const implied = Number(q.fiatAmount) / Number(q.cryptoAmount);
  return rate > 0 && implied > 0 && Math.abs(implied - rate) / rate < 0.5;
}

type OffQuote = {
  provider: string;
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
};

type RampOrder = {
  id: number | string;
  status: string;
  intentAddress?: string;
  cryptoCurrency?: string;
  depositChain?: string;
};

export function ChainrailsSellPanel({
  source,
  chainPicker,
  resumeOrderId,
  resumeFiatLabel,
  resumeDepositLabel,
  resumeCryptoLabel,
  onOrderActive,
  onStartNew,
  onOrderCreated,
  backRef,
  amount,
  onAmountChange,
  countryCode: chosenCountry,
  onCountryChange,
  token,
}: {
  source: RampDestination;
  /** The parent's token + chain pill, shown in the "You send" field. */
  chainPicker?: React.ReactNode;
  /** Re-open an existing order (from History) instead of creating one. */
  resumeOrderId?: string;
  /** Pre-formatted payout amount (e.g. "6,722 NGN") shown while resuming, since
   *  a resumed order arrives without the original quote. */
  resumeFiatLabel?: string;
  /** Pre-formatted deposit amount (e.g. "5.0275 USDC") for the same reason. */
  resumeDepositLabel?: string;
  /** Last-resort amount (the sell figure) for orders saved before we captured
   *  the exact deposit amount. */
  resumeCryptoLabel?: string;
  /** Tells the parent flow when the order screen is showing, so it can drop its
   *  own "Sell" title and leave the status headline to us (matches the Buy flow). */
  onOrderActive?: (active: boolean) => void;
  /** Clears the resumed order in the parent (URL + state) when starting over. */
  onStartNew?: () => void;
  /** Fires when a new order is created, so the parent can put its id in the URL
   *  (survives a refresh — otherwise a fresh order is lost on reload). */
  onOrderCreated?: (id: string) => void;
  /** Lets the parent's header "Back" step back through this panel (KYC → payout
   *  → amount) instead of exiting the whole flow. We populate `.current` with a
   *  step-back fn for the current stage, or null when there's nothing to undo. */
  backRef?: React.MutableRefObject<(() => boolean) | null>;
  /** The "You sell" USDC amount, owned by the parent so it survives switching
   *  between the Paycrest form and this panel. */
  amount: string;
  onAmountChange: (v: string) => void;
  /** Set when the parent's currency picker chose the payout country.
   *  "" means "Other country" — the user still has to pick one here. */
  countryCode?: string;
  onCountryChange?: (country: RampCountry) => void;
  /** Stablecoin being sold, owned by the parent so it carries across forms. */
  token: "USDC" | "USDT";
}) {
  // Only countries ChainRails can pay out to.
  const {
    countries,
    loading: countriesLoading,
    error: countriesError,
  } = useRampCountries("off-ramp");
  const [ownCountry, setOwnCountry] = useState("NG");
  const countryCode = chosenCountry ?? ownCountry;
  const setCountryCode = (code: string) => {
    const next = countries.find((c) => c.countryCode === code);
    if (onCountryChange && next) onCountryChange(next);
    else setOwnCountry(code);
  };
  const [senderAddress, setSenderAddress] = useState("");
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [quote, setQuote] = useState<OffQuote | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  // Banks for the payout currency, so a Paycrest-routed sell picks the recipient
  // bank by NAME (we send the institution code) and confirms the account name.
  const [payoutBanks, setPayoutBanks] = useState<PaycrestInstitution[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  // Headless-KYC gate: set when the profile can't yet proceed, which swaps the
  // payout form for the verification step until it clears.
  const [kycCorridor, setKycCorridor] = useState<KycCorridor | null>(null);
  const [kycInitial, setKycInitial] = useState<KycState | undefined>(undefined);
  // True from the moment KYC clears until the order is created, so we show a
  // clean "setting up" loader instead of flashing the payout form back.
  const [finalizing, setFinalizing] = useState(false);
  const [order, setOrder] = useState<RampOrder | null>(null);
  const [phase, setPhase] = useState<RampOrderPhase>("pending");

  const [resuming, setResuming] = useState(!!resumeOrderId);
  const loading = countriesLoading || resuming;
  const [quoting, setQuoting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill the remembered KYC email (runs client-side only, avoids SSR mismatch).
  useEffect(() => {
    const saved = loadSavedEmail();
    if (saved) setEmail(saved);
  }, []);

  // Resume mode: re-open an order from History. Fetch it once, then the poll
  // effect below keeps it live — the user lands straight on the deposit screen
  // exactly where they left off, instead of a dead end.
  useEffect(() => {
    if (!resumeOrderId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/chainrails/ramp/orders/${resumeOrderId}`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error();
        const data = (await res.json()) as RampOrder | null;
        if (cancelled) return;
        if (!data) throw new Error();
        setOrder(data);
        setPhase(classifyRampStatus(data.status));
      } catch {
        if (!cancelled)
          setError("We couldn't reopen this order. Try again from History.");
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resumeOrderId]);

  // Prefill the "sending from" address with the connected wallet — but only for
  // EVM sources, since that's the only address the wallet gives us (Solana/Tron
  // sources are pasted manually). Only fills an empty field, so we never stomp
  // an address the user typed.
  const { address: connectedAddress } = useAccount();
  useEffect(() => {
    if (source.addressKind === "evm" && connectedAddress && !senderAddress) {
      setSenderAddress(connectedAddress);
    }
  }, [source.addressKind, connectedAddress, senderAddress]);

  // Fall back to the first country if ours can't be paid out to.
  useEffect(() => {
    if (countries.length && !countries.some((c) => c.countryCode === ownCountry))
      setOwnCountry(countries[0].countryCode);
  }, [countries, ownCountry]);

  const country = countries.find((c) => c.countryCode === countryCode);
  const cryptoAmount = Number(amount);
  const senderValid = isValidRampAddress(source.addressKind, senderAddress);
  const belowMin = isBelowRampMinimum(country, cryptoAmount);

  // Live rate preview (fiat per 1 USDC), so users can check the rate without
  // creating a quote. One quote per country/chain, at the corridor minimum.
  const [unitRate, setUnitRate] = useState<number | null>(null);
  const [noRate, setNoRate] = useState(false);
  useEffect(() => {
    setUnitRate(null);
    setNoRate(false);
    if (!country) return;
    let cancelled = false;
    // Cached for a minute: flipping between chains/tokens reuses it.
    cachedFetch("/api/chainrails/ramp/offramp-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fiatCurrency: country.currency.code,
        cryptoAmount: Math.max(10, country.currency.minAmount),
        sourceChain: source.chainrailsChain,
        countryCode: country.countryCode,
        token,
        preview: true,
      }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        const all = res.ok ? [data.recommended, ...(data.quotes ?? [])] : [];
        const best = all.find((q) => q && isSaneQuote(q));
        if (best) setUnitRate(Number(best.exchangeRatePerUSD));
        else setNoRate(true);
      })
      .catch(() => !cancelled && setNoRate(true));
    return () => {
      cancelled = true;
    };
  }, [country, source.chainrailsChain, token]);
  const estimate =
    unitRate && cryptoAmount > 0 ? cryptoAmount * unitRate : null;
  const canQuote = !!country && cryptoAmount > 0 && !belowMin && senderValid;

  // Load the bank list for the payout currency so a Paycrest-routed sell shows a
  // bank name dropdown (value = institution code) instead of a raw code box.
  const payoutCurrency = country?.currency.code;
  useEffect(() => {
    if (!payoutCurrency) return;
    let cancelled = false;
    cachedFetch(
      `/api/paycrest/institutions?currency=${encodeURIComponent(payoutCurrency)}`,
      {},
      ONE_HOUR
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok || cancelled) return;
        setPayoutBanks(data.institutions ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [payoutCurrency]);

  // Resolve the recipient's name from the bank + number (Paycrest verify) so the
  // user confirms it instead of typing. Only the Paycrest route has these keys.
  const recipInst = fieldValues.recipientInstitution;
  const recipAcct = (fieldValues.recipientAccountIdentifier ?? "").trim();
  useEffect(() => {
    if (!recipInst || recipAcct.length < 6) {
      setVerifying(false);
      setVerifyError(null);
      setFieldValues((p) =>
        p.recipientAccountName ? { ...p, recipientAccountName: "" } : p
      );
      return;
    }
    let cancelled = false;
    setVerifying(true);
    setVerifyError(null);
    const id = setTimeout(async () => {
      try {
        const res = await fetch("/api/paycrest/verify-account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            institution: recipInst,
            accountIdentifier: recipAcct,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data?.accountName) {
          setVerifyError(data?.error || "Couldn't verify this account.");
          setFieldValues((p) => ({ ...p, recipientAccountName: "" }));
        } else {
          setFieldValues((p) => ({
            ...p,
            recipientAccountName: data.accountName,
          }));
        }
      } catch {
        if (!cancelled) {
          setVerifyError("Couldn't reach the verification service.");
          setFieldValues((p) => ({ ...p, recipientAccountName: "" }));
        }
      } finally {
        if (!cancelled) setVerifying(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [recipInst, recipAcct]);

  const requiredFields: FieldSpec[] =
    quote?.paymentChannels[0]?.directTransferDetails?.fieldsRequired ?? [];

  // Field roles by key/label, so both the Paycrest route (recipient* keys) and
  // generic providers (Bank / account number / holder name) get the same clean
  // layout: bank first, then the account number, then the name — which we hold
  // back until there's a number to resolve or type against.
  const isBankField = (f: FieldSpec) =>
    f.key === "recipientInstitution" || f.type === "enum";
  const isNumberField = (f: FieldSpec) =>
    f.key === "recipientAccountIdentifier" ||
    /number/i.test(f.label) ||
    /number|identifier/i.test(f.key);
  const isNameField = (f: FieldSpec) =>
    f.key === "recipientAccountName" ||
    /holder/i.test(f.label) ||
    (/name/i.test(f.label) && !/number/i.test(f.label)) ||
    (/name/i.test(f.key) && !/number/i.test(f.key));
  const bankField = requiredFields.find(isBankField);
  const numberField = requiredFields.find(
    (f) => isNumberField(f) && !isBankField(f)
  );
  const nameField = requiredFields.find(
    (f) => isNameField(f) && !isBankField(f) && !isNumberField(f)
  );
  // Bank → account number → name → anything else.
  const orderedFields: FieldSpec[] = [
    ...(bankField ? [bankField] : []),
    ...(numberField ? [numberField] : []),
    ...(nameField ? [nameField] : []),
    ...requiredFields.filter(
      (f) => f !== bankField && f !== numberField && f !== nameField
    ),
  ];

  const getQuote = async () => {
    if (!country || !canQuote) return;
    setQuoting(true);
    setError(null);
    // One quote for a given amount to convert. Prefer Paycrest when the
    // corridor offers it — our main rail, cheaper here, lighter KYC than
    // Yellow Card — else ChainRails' own pick. Never a hard pin.
    const quoteFor = async (amountToConvert: number): Promise<OffQuote> => {
      const res = await fetch("/api/chainrails/ramp/offramp-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fiatCurrency: country.currency.code,
          cryptoAmount: amountToConvert,
          sourceChain: source.chainrailsChain,
          countryCode,
          token,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Couldn't get a quote.");
      const offered: OffQuote[] = (
        data.quotes ?? (data.recommended ? [data.recommended] : [])
      ).filter(isSaneQuote);
      const pick =
        offered.find((q) => q.provider === "PAYCREST") ??
        offered.find((q) => q.provider === data.recommended?.provider) ??
        offered[0];
      if (!pick)
        throw new Error(
          "No provider can fill that amount right now — try a different amount."
        );
      return pick;
    };

    try {
      // Like Paycrest, the user sends exactly what they typed and the fee comes
      // out of it. ChainRails prices the amount converted and adds its fee on
      // top (0.5%, capped at 1.5 USDC, seen 2026-10-27), so one quote tells us
      // the fee and we convert (typed − fee). No second quote: orders don't
      // take a quote id (ChainRails re-prices at creation) and the order
      // response carries the exact deposit amount, which the next screen shows.
      const quoted = await quoteFor(cryptoAmount);
      const fee =
        Number(quoted.grossDepositAmount) - Number(quoted.cryptoAmount);
      const rate = Number(quoted.exchangeRatePerUSD);
      const toConvert =
        fee > 0 ? Math.floor((cryptoAmount - fee) * 1e6) / 1e6 : cryptoAmount;
      const selected: OffQuote =
        fee > 0
          ? {
              ...quoted,
              cryptoAmount: toConvert,
              grossDepositAmount: cryptoAmount,
              fiatAmount: rate > 0 ? toConvert * rate : quoted.fiatAmount,
            }
          : quoted;
      // Seed enum fields with their first option so a valid value is preselected.
      const fields =
        selected.paymentChannels[0]?.directTransferDetails?.fieldsRequired ??
        [];
      const seeded: Record<string, string> = {};
      for (const f of fields) {
        if (f.type === "enum" && f.options?.[0])
          seeded[f.key] = f.options[0].value;
      }
      setFieldValues(seeded);
      setQuote(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't get a quote.");
    } finally {
      setQuoting(false);
    }
  };

  const fieldsComplete = requiredFields.every(
    (f) => !f.required || (fieldValues[f.key]?.trim()?.length ?? 0) > 0
  );
  const emailValid = EMAIL_RE.test(email.trim());

  // The real order POST. Assumes KYC has already cleared — split out from the
  // gate below so we can call it again the instant the user finishes verifying.
  const postOrder = async () => {
    if (!quote || !country) return;
    setCreating(true);
    setError(null);
    try {
      // Phone-type fields must go out in E.164 (+234…). A local 0817… format
      // makes FONBNK's backend throw and Chainrails returns an opaque 500.
      const phoneKeys = new Set(
        requiredFields.filter((f) => f.type === "phone").map((f) => f.key)
      );
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(fieldValues)) {
        fields[key] = phoneKeys.has(key) ? toE164(value, countryCode) : value;
      }
      const res = await fetch("/api/chainrails/ramp/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "off-ramp",
          provider: quote.provider,
          fiatCurrency: quote.fiatCurrency,
          cryptoAmount: quote.cryptoAmount,
          sourceChain: source.chainrailsChain,
          senderAddress: senderAddress.trim(),
          amountSymbol: token,
          countryCode,
          // userEmail is a TOP-LEVEL KYC field — the provider 403s if it's
          // nested inside `fields`. The orders endpoint also rejects `quoteId`.
          userEmail: email.trim(),
          fields,
        }),
      });
      const data = (await res.json()) as RampOrder & { error?: string };
      if (!res.ok)
        throw new Error(data?.error || "Couldn't create the sell order.");
      setOrder(data);
      setPhase(classifyRampStatus(data.status));
      trackRampOrder({
        id: String(data.id),
        direction: "offramp",
        chainLabel: source.label,
        cryptoLabel: `${quote.cryptoAmount} ${quote.cryptoCurrency}`,
        // The exact deposit figure (fee-inclusive) so a resumed order shows the
        // right amount to send even though the quote is long gone.
        depositLabel: `${quote.grossDepositAmount} ${quote.cryptoCurrency}`,
        fiatLabel: `${formatNumber(pickFiatAmount(quote) ?? NaN)} ${quote.fiatCurrency}`,
        address: senderAddress.trim(),
        createdAt: Date.now(),
      });
      // Put the id in the URL so a refresh reopens this order, not the form.
      onOrderCreated?.(String(data.id));
      // Tie it to the user's email for cross-device history.
      linkRampOrder(String(data.id), email.trim());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't create the sell order."
      );
    } finally {
      setCreating(false);
      setFinalizing(false);
    }
  };

  // Gate the order behind Chainrails' headless KYC. We check the profile can
  // proceed FIRST (docs: read state → collect missing → submit → create), so we
  // never fire an order that would 400 with KYC_REQUIRED. If the check itself
  // can't be reached we fall through and let the order attempt surface any gate.
  const createOrder = async () => {
    if (!quote || !country) return;
    saveEmail(email.trim()); // remember it for next time (passed emailValid gate)
    setCreating(true);
    setError(null);
    const corridor: KycCorridor = {
      provider: quote.provider,
      userEmail: email.trim(),
      countryCode,
      fiatCurrency: quote.fiatCurrency,
      cryptoAmount: quote.cryptoAmount,
    };
    try {
      const kyc = await fetchKycState(corridor);
      if (!kyc.canProceed) {
        setKycCorridor(corridor);
        setKycInitial(kyc);
        setCreating(false);
        return;
      }
    } catch {
      // Couldn't reach the KYC check — proceed and let the order attempt itself
      // report any verification gate rather than blocking on our pre-check.
    }
    await postOrder();
  };

  // Poll the order via the shared ramp poller (see chainrailsPoll for the
  // cadence). A brand-new order waits before its first check — the user has
  // to go send the crypto first. A reopened order checks straight away, since
  // it may already be paid. Keyed on the order id alone.
  const orderId = order?.id;
  useEffect(() => {
    if (orderId == null) return;
    const handle = pollRampOrder<RampOrder>(orderId, {
      waitFirst: !resumeOrderId,
      onUpdate: (data) => {
        setOrder(data);
        setPhase(classifyRampStatus(data.status));
      },
      onSettled: (data, settledPhase) => {
        if (data) setOrder(data);
        setPhase(settledPhase);
      },
    });
    return () => handle.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // Let the parent flow know the order screen owns the headline now.
  useEffect(() => {
    onOrderActive?.(!!order || !!resumeOrderId);
  }, [order, resumeOrderId, onOrderActive]);

  // Wire the header "Back" to undo ONE stage at a time (KYC → payout details →
  // amount) so a mid-flow back doesn't blow away a filled form. Returns true when
  // it handled the back; the parent exits the flow only when this is null.
  useEffect(() => {
    if (!backRef) return;
    backRef.current = order
      ? null
      : kycCorridor
        ? () => {
            setKycCorridor(null);
            return true;
          }
        : quote
          ? () => {
              setQuote(null);
              return true;
            }
          : null;
    return () => {
      if (backRef) backRef.current = null;
    };
  }, [backRef, order, kycCorridor, quote]);

  // Abandon a dead order and return to a blank sell form. Clears the parent's
  // resumed order too (via onStartNew) so the URL doesn't reopen it.
  const startNewOrder = () => {
    setOrder(null);
    setQuote(null);
    setPhase("pending");
    setError(null);
    onAmountChange("");
    setFieldValues({});
    setKycCorridor(null);
    setKycInitial(undefined);
    onStartNew?.();
  };

  // ----- Order created: two-panel deposit + live progress ------------------
  if (order) {
    // Friendly network name only — never the raw "SOLANA_MAINNET" enum.
    const networkLabel = source.label;
    const cryptoCurrency =
      order.cryptoCurrency ?? quote?.cryptoCurrency ?? "USDC";
    const paidOut = phase === "completed";
    const failed = phase === "expired" || phase === "failed";
    // Deposit amount: from the live order (field name varies, so scan several),
    // the quote, or the figures we stored in History. Falls back to the sell
    // amount for legacy orders saved before we captured the exact deposit.
    const depositAmount =
      pickDepositAmount(order as Record<string, unknown>) ??
      quote?.grossDepositAmount;
    const amountLabel =
      depositAmount != null
        ? `${depositAmount} ${cryptoCurrency}`
        : (resumeDepositLabel ?? resumeCryptoLabel ?? "—");
    const quoteFiat = quote ? pickFiatAmount(quote) : undefined;
    const fiatLine =
      quote && quoteFiat != null
        ? `${fiatSymbol(quote.fiatCurrency)}${formatNumber(quoteFiat)}`
        : (resumeFiatLabel ?? "—");

    const steps = [
      { l: "Order created", d: "Your quote is locked and the payout is set up." },
      {
        l: "Send your crypto",
        d: `Send exactly ${amountLabel} on ${networkLabel}.`,
      },
      {
        l: "Confirming",
        d: "We confirm the deposit on-chain, then release the payout.",
      },
      { l: "Paid out", d: `${fiatLine} lands in the recipient's account.` },
    ];
    // Timeline reflects the real phase: the order exists, so step 0 is always
    // done; pending waits on the deposit, processing is confirming.
    let activeIndex: number;
    let failedIndex = -1;
    if (failed) {
      failedIndex = 1;
      activeIndex = 1;
    } else if (paidOut) {
      activeIndex = steps.length;
    } else if (phase === "processing") {
      activeIndex = 2;
    } else {
      activeIndex = 1;
    }
    const failedPhase = failedIndex >= 0;
    // Big status headline, mirroring the Buy status screen so the two match.
    const statusTitle = paidOut
      ? "Paid out"
      : phase === "expired"
        ? "Deposit window expired"
        : phase === "failed"
          ? "Order couldn't complete"
          : phase === "processing"
            ? "Confirming your payment"
            : "Send your crypto";
    const statusSubtitle = paidOut
      ? `${fiatLine} was sent to the recipient's account.`
      : phase === "processing"
        ? "Your deposit is confirming on-chain — the payout releases shortly."
        : `Send exactly ${amountLabel} to the address below to complete the payout.`;

    // Expired with no deposit: the same calm page as every other expired
    // order. "Sell again" keeps the amount and country and gets a fresh quote.
    if (phase === "expired") {
      const amountNum = Number(amount);
      return (
        <ExpiredOrder
          twoColumns={false}
          steps={["Amount", "Recipient", "Send"]}
          deadline={null}
          createdAt={null}
          againTitle="Sell again at today's rate"
          againSub="Same amount and payout country. You'll get a fresh quote and deposit address."
          payLabel="You send"
          payAmount={amountNum > 0 ? formatToken(amountNum, token, 2) : amountLabel}
          receiveLabel="They receive about"
          receiveAmount={
            estimate !== null && country
              ? `${fiatSymbol(country.currency.code)}${formatNumber(estimate)}`
              : null
          }
          rateLine={
            unitRate && country
              ? `1 ${token} ≈ ${formatNumber(unitRate)} ${country.currency.code}`
              : null
          }
          primaryLabel="Sell again"
          onPrimary={() => {
            setOrder(null);
            setQuote(null);
            setPhase("pending");
            setError(null);
            onStartNew?.();
          }}
          quoteRows={[
            { label: "You were sending", value: amountLabel },
            { label: "They'd have received", value: fiatLine },
            { label: "From", value: networkLabel },
          ]}
          orderId={String(order.id)}
        />
      );
    }

    // Completed — the hero moment (mirrors the Paycrest success card).
    if (paidOut) {
      return (
        <div className="cr-status col">
          <section
            className="col center"
            style={{
              position: "relative",
              overflow: "hidden",
              maxWidth: 460,
              margin: "8px auto 0",
              padding: "44px 32px 32px",
              textAlign: "center",
              background: "var(--bg-elev)",
              border: "1px solid var(--line)",
              borderRadius: 24,
              boxShadow: "var(--shadow-2)",
              animation: "fade-up 0.4s var(--ease) both",
            }}
          >
            <Confetti />

            {/* Checkmark with a soft halo — the celebratory focal point. */}
            <span
              className="cr-payout-check"
              style={{
                position: "relative",
                width: 76,
                height: 76,
                borderRadius: "50%",
                background: "var(--ok-soft)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 20,
                animation: "check-pop 0.5s var(--ease) both",
              }}
            >
              <span
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: "50%",
                  background: "var(--ok)",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0 6px 18px rgba(47, 122, 79, 0.32)",
                }}
              >
                <Icon.Check size={27} />
              </span>
            </span>

            <span
              className="eyebrow"
              style={{ color: "var(--ok)", marginBottom: 12 }}
            >
              Payout complete
            </span>
            <span
              className="font-mono tabular"
              style={{
                fontSize: "clamp(34px, 8vw, 48px)",
                fontWeight: 600,
                letterSpacing: "-0.03em",
                lineHeight: 1,
              }}
            >
              {fiatLine}
            </span>
            <span
              style={{
                fontSize: 15,
                color: "var(--fg-soft)",
                marginTop: 10,
                maxWidth: 300,
                lineHeight: 1.45,
              }}
            >
              sent to the recipient&apos;s bank account
            </span>

            {/* Crypto detail — token and network logos, in a soft pill. */}
            <span
              className="row center gap-2"
              style={{
                marginTop: 22,
                padding: "8px 14px",
                background: "var(--bg-soft)",
                border: "1px solid var(--line)",
                borderRadius: 999,
                fontSize: 13,
              }}
            >
              <AssetLogo name={tokenLogo(cryptoCurrency)} size={17} />
              <span
                className="font-mono tabular"
                style={{ color: "var(--fg-soft)" }}
              >
                {amountLabel}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>
                on
              </span>
              <AssetLogo name={chainLogo(networkLabel)} size={16} />
              <span style={{ color: "var(--fg-soft)" }}>{networkLabel}</span>
            </span>

            {/* Order reference, set off by a hairline divider. */}
            <div
              style={{
                marginTop: 18,
                paddingTop: 18,
                width: "100%",
                borderTop: "1px solid var(--line)",
                display: "flex",
                justifyContent: "center",
              }}
            >
              <CopyableOrderId id={String(order.id)} />
            </div>

            <button
              className="btn btn-primary btn-big"
              onClick={startNewOrder}
              style={{ marginTop: 20, width: "100%", maxWidth: 280 }}
            >
              Start new order <Icon.ArrowRight />
            </button>
          </section>
        </div>
      );
    }

    return (
      <div className="cr-status col">
        <header className="cr-status-header col">
          <span className="row center gap-2">
            <span className="eyebrow">Status</span>
            {failed && (
              <span className="chip chip-err">Failed</span>
            )}
          </span>
          <h1
            style={{
              fontSize: "clamp(28px, 3.6vw, 42px)",
              lineHeight: 1.03,
              letterSpacing: "-0.03em",
              fontWeight: 500,
            }}
          >
            {statusTitle}
          </h1>
          {!failed && (
            <span className="muted" style={{ fontSize: 14, lineHeight: 1.4 }}>
              {statusSubtitle}
            </span>
          )}
        </header>

        <div className="cr-status-grid">
          {/* Left — summary + the deposit action */}
          <div className="cr-status-main">
            <div
              className="cr-status-amounts"
              style={failed ? { opacity: 0.5 } : undefined}
            >
              <div className="card cr-status-amount">
                <span className="eyebrow">You sell</span>
                <span
                  className="font-mono tabular row center gap-2 cr-status-amount-value"
                  style={{ whiteSpace: "nowrap" }}
                >
                  <AssetLogo name={tokenLogo(cryptoCurrency)} size={18} />
                  {amountLabel}
                </span>
                <span
                  className="muted font-mono row center gap-1"
                  style={{ fontSize: 12, minWidth: 0 }}
                >
                  <AssetLogo name={chainLogo(networkLabel)} size={12} />
                  {networkLabel}
                </span>
              </div>
              <div className="card cr-status-amount">
                <span className="eyebrow">You receive</span>
                <span
                  className="font-mono tabular cr-status-amount-value"
                  style={{ color: "var(--accent)", whiteSpace: "nowrap" }}
                >
                  {fiatLine}
                </span>
                <span className="muted" style={{ fontSize: 12 }}>
                  To the recipient&apos;s bank account
                </span>
              </div>
            </div>

            {order.intentAddress && phase === "pending" && (
              <DepositAddress
                address={order.intentAddress}
                amountLabel={amountLabel}
                network={networkLabel}
              />
            )}

            {/* Active reassurance — always answers "what now / what next". */}
            {phase === "pending" && (
              <div
                className="row center gap-2"
                style={{
                  justifyContent: "center",
                  fontSize: 12.5,
                  color: "var(--fg-soft)",
                }}
              >
                <Icon.Spinner size={13} />
                <span>
                  Waiting for your deposit — we&apos;ll send {fiatLine} to the
                  recipient once it arrives.
                </span>
              </div>
            )}

            {phase === "processing" && (
              <div
                className="card row center gap-2"
                style={{ padding: 16 }}
              >
                <Icon.Spinner size={15} />
                <span style={{ fontSize: 13.5 }}>
                  Deposit received — sending {fiatLine} to the recipient&apos;s
                  account.
                </span>
              </div>
            )}

            {failed && (
              <div className="card col gap-2" style={{ padding: 16 }}>
                <span style={{ fontSize: 14.5, fontWeight: 600 }}>
                  No payout was made.
                </span>
                <span
                  style={{
                    fontSize: 13,
                    color: "var(--fg-soft)",
                    lineHeight: 1.5,
                  }}
                >
                  The provider couldn&apos;t process this order. If you already
                  sent your crypto, it will be refunded to your wallet.
                </span>
              </div>
            )}

            {failed && (
              <button
                className="btn btn-primary cr-status-action"
                onClick={startNewOrder}
              >
                Start new order <Icon.ArrowRight />
              </button>
            )}

            <div className="cr-status-ref row between center">
              <CopyableOrderId id={String(order.id)} />
              <span
                className="row center gap-1 muted"
                style={{ fontSize: 11 }}
              >
                <Icon.Shield size={12} /> Released only after your deposit
                confirms
              </span>
            </div>
          </div>

          {/* Right — progress tracker */}
          <div className="card cr-status-card cr-status-progress">
            <span className="eyebrow">Progress</span>
            {steps.map((s, i) => {
              const isFailed = failedIndex === i;
              const isDone = failedPhase
                ? i < failedIndex
                : paidOut || i < activeIndex;
              const isActive = !failedPhase && !paidOut && i === activeIndex;
              const statusLabel = isFailed
                ? "failed"
                : isDone
                  ? "done"
                  : isActive
                    ? "now"
                    : "next";
              const dim = !isDone && !isActive && !isFailed ? 0.5 : 1;
              return (
                <div
                  key={i}
                  className="row"
                  style={{
                    gap: 12,
                    paddingBottom: i < steps.length - 1 ? 12 : 0,
                    alignItems: "flex-start",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      flex: "0 0 20px",
                    }}
                  >
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        background: isFailed
                          ? "var(--err)"
                          : isDone
                            ? "var(--ok)"
                            : isActive
                              ? "var(--accent)"
                              : "var(--bg-sunk)",
                        color:
                          isDone || isActive || isFailed
                            ? "#fff"
                            : "var(--fg-mute)",
                        border:
                          !isDone && !isActive && !isFailed
                            ? "1px solid var(--line-2)"
                            : "none",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        animation:
                          isActive && !isFailed
                            ? "pulse-ring 1.4s var(--ease) infinite"
                            : "none",
                      }}
                    >
                      {isFailed ? (
                        <span style={{ fontSize: 12 }}>!</span>
                      ) : isDone ? (
                        <Icon.Check size={11} />
                      ) : (
                        <span className="font-mono" style={{ fontSize: 10 }}>
                          {i + 1}
                        </span>
                      )}
                    </div>
                    {i < steps.length - 1 && (
                      <div
                        style={{
                          width: 1,
                          flex: 1,
                          minHeight: 16,
                          background: isDone ? "var(--ok)" : "var(--line)",
                          marginTop: 3,
                        }}
                      />
                    )}
                  </div>
                  <div className="col grow gap-1" style={{ opacity: dim }}>
                    <div className="row between" style={{ alignItems: "baseline" }}>
                      <h4
                        style={{
                          fontSize: 13.5,
                          lineHeight: 1.25,
                          fontWeight: 500,
                        }}
                      >
                        {s.l}
                      </h4>
                      <span
                        className="font-mono"
                        style={{
                          fontSize: 9,
                          color: "var(--fg-mute)",
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          lineHeight: 1,
                        }}
                      >
                        {statusLabel}
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 12,
                        lineHeight: 1.4,
                        color: "var(--fg-soft)",
                      }}
                    >
                      {s.d}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ----- Resuming from History: fetching the order before we can show it ----
  if (resumeOrderId && !order) {
    return (
      <div className="card col center gap-3" style={{ padding: "40px 24px" }}>
        {!error && <Icon.Spinner size={18} />}
        <span className="muted" style={{ fontSize: 13 }}>
          {error ?? "Reopening your order…"}
        </span>
      </div>
    );
  }

  // ----- Quote in hand: dynamic payout fields + confirm --------------------
  if (quote) {
    const canCreate = fieldsComplete && emailValid && !creating;
    return (
      <div className="col gap-5">
        {/* Headline summary — mirrors the Paycrest "Review & confirm" card. */}
        <div className="card-lg" style={{ padding: 24 }}>
          <div className="row between center wrap" style={{ gap: 18 }}>
            <div className="col">
              <span className="muted" style={{ fontSize: 12 }}>
                You send
              </span>
              <span
                className="font-mono tabular row center gap-2"
                style={{ fontSize: 30, fontWeight: 500, letterSpacing: "-0.015em" }}
              >
                <AssetLogo name={tokenLogo(quote.cryptoCurrency)} size={22} />
                {formatToken(
                  Number(quote.grossDepositAmount) || quote.cryptoAmount,
                  quote.cryptoCurrency,
                  2
                )}
              </span>
              <span
                className="muted font-mono"
                style={{ fontSize: 12, marginTop: 4 }}
              >
                {source.label}
              </span>
            </div>
            <Icon.ArrowRight size={22} />
            <div className="col" style={{ alignItems: "flex-end" }}>
              <span className="muted" style={{ fontSize: 12 }}>
                You receive
              </span>
              <span
                className="font-mono tabular"
                style={{
                  fontSize: 30,
                  fontWeight: 500,
                  color: "var(--accent)",
                  letterSpacing: "-0.015em",
                }}
              >
                ≈ {fiatSymbol(quote.fiatCurrency)}
                {(() => {
                  const amt = pickFiatAmount(quote);
                  return amt != null ? formatNumber(amt) : "—";
                })()}
              </span>
              <span
                className="muted font-mono"
                style={{ fontSize: 12, marginTop: 4 }}
              >
                1 USD = {formatNumber(quote.exchangeRatePerUSD)}{" "}
                {quote.fiatCurrency}
              </span>
            </div>
          </div>
          {/* Fees arrive with the quote, so they're shown here, not on the
              amount screen. */}
          <dl className="m-0 mt-5 flex flex-col gap-2 border-t border-edge-soft pt-4 text-sm">
            {/* The fee in the token: what you send − the amount converted.
                ChainRails only reports it in fiat (totalFeesFiat), which reads
                oddly on a sell, so that's the fallback. */}
            {(() => {
              const feeToken =
                Number(quote.grossDepositAmount) - Number(quote.cryptoAmount);
              const feeFiat = Number(quote.totalFeesFiat);
              if (feeToken > 0)
                return (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Fee</dt>
                    <dd className="m-0 font-medium">
                      {formatToken(feeToken, quote.cryptoCurrency, 2)}
                    </dd>
                  </div>
                );
              if (feeFiat > 0)
                return (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Fee</dt>
                    <dd className="m-0 font-medium">
                      {fiatSymbol(quote.fiatCurrency)}
                      {formatNumber(feeFiat)}
                    </dd>
                  </div>
                );
              return null;
            })()}
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Amount converted</dt>
              <dd className="m-0 font-medium">
                {formatToken(quote.cryptoAmount, quote.cryptoCurrency, 2)}
              </dd>
            </div>
          </dl>
        </div>

        {/* Verify once (per-profile KYC, reused across Buy + Sell), then the
            payout details once the profile can proceed. */}
        {kycCorridor ? (
          <KycVerification
            corridor={kycCorridor}
            initialState={kycInitial}
            onCleared={() => {
              setKycCorridor(null);
              setFinalizing(true);
              void postOrder();
            }}
            onCancel={() => setKycCorridor(null)}
          />
        ) : finalizing ? (
          <div className="card col center gap-3" style={{ padding: "36px 24px" }}>
            <Icon.Spinner size={18} />
            <span className="muted" style={{ fontSize: 13 }}>
              Setting up your payout…
            </span>
          </div>
        ) : (
          /* Payout details */
          <div className="card col gap-5" style={{ padding: 20 }}>
          <div className="col gap-3">
            <div className="row center gap-1">
              <span className="eyebrow">Payout account</span>
              <InfoHint
                text={`The bank or mobile-money account that receives the ${
                  quote.fiatCurrency
                    ? currencyLabel(quote.fiatCurrency)
                    : "cash"
                } payout.`}
              />
            </div>
            {orderedFields.map((f) => {
              // Paycrest-routed sell: the recipient bank is a code — show a name
              // dropdown and send the code, and resolve the account name instead
              // of asking the user to type either.
              const isRecipBank = f.key === "recipientInstitution";
              const isAcctNumber = f.key === "recipientAccountIdentifier";

              // The account name: held back until there's a bank + number to work
              // with, then resolved (Paycrest routes) or typed (everyone else).
              if (nameField && f.key === nameField.key) {
                const bankVal = bankField
                  ? fieldValues[bankField.key]
                  : undefined;
                const numVal = numberField
                  ? (fieldValues[numberField.key] ?? "").trim()
                  : "";
                // Reveal once the number's in (and a bank is chosen, when there
                // is a bank field to choose) — never leave it stuck hidden.
                const ready =
                  numVal.length >= 6 && (bankField ? !!bankVal : true);
                // Until there's an account to work with, show nothing: the name is
                // a result the system fills in, not another empty box up front.
                if (!ready) return null;
                // Only the Paycrest route can auto-confirm the name; other
                // providers' codes can't be looked up, so we ask for it.
                const isPaycrestName = f.key === "recipientAccountName";
                const needsManual =
                  !isPaycrestName || (!verifying && !!verifyError);
                return (
                  <div key={f.key} className="col gap-1">
                    <span className="muted" style={{ fontSize: 12 }}>
                      Account name
                    </span>
                    {needsManual ? (
                      <>
                        <input
                          value={fieldValues[f.key] ?? ""}
                          onChange={(e) =>
                            setFieldValues((p) => ({
                              ...p,
                              [f.key]: e.target.value,
                            }))
                          }
                          placeholder="Enter the account name"
                          style={INPUT}
                        />
                        {isPaycrestName && (
                          <span className="muted" style={{ fontSize: 11.5 }}>
                            We couldn&apos;t confirm this account automatically —
                            type the name exactly as it appears at the bank.
                          </span>
                        )}
                      </>
                    ) : (
                      <AccountNameStatus
                        verifying={verifying}
                        error={verifyError}
                        name={fieldValues[f.key] ?? ""}
                      />
                    )}
                  </div>
                );
              }

              const label = isRecipBank
                ? "Recipient's bank"
                : isAcctNumber
                  ? "Account number"
                  : f.label;

              return (
                <label key={f.key} className="col gap-1">
                  <span className="muted" style={{ fontSize: 12 }}>
                    {label}
                    {f.required ? "" : " (optional)"}
                  </span>
                  {isRecipBank && payoutBanks.length > 0 ? (
                    <select
                      value={fieldValues[f.key] ?? ""}
                      onChange={(e) =>
                        setFieldValues((p) => ({ ...p, [f.key]: e.target.value }))
                      }
                      style={INPUT}
                    >
                      <option value="" disabled>
                        Select the bank
                      </option>
                      {payoutBanks.map((b) => (
                        <option key={b.code} value={b.code}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  ) : f.type === "enum" ? (
                    <select
                      value={fieldValues[f.key] ?? ""}
                      onChange={(e) =>
                        setFieldValues((p) => ({ ...p, [f.key]: e.target.value }))
                      }
                      style={INPUT}
                    >
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {cleanOptionLabel(o.label)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={fieldValues[f.key] ?? ""}
                      onChange={(e) =>
                        setFieldValues((p) => ({ ...p, [f.key]: e.target.value }))
                      }
                      inputMode={
                        f.type === "phone"
                          ? "tel"
                          : isAcctNumber
                            ? "numeric"
                            : undefined
                      }
                      placeholder={
                        isAcctNumber ? "10-digit account number" : f.label
                      }
                      style={INPUT}
                    />
                  )}
                </label>
              );
            })}
          </div>

          <div style={{ height: 1, background: "var(--line)" }} />

          <label className="col gap-1">
            <span className="muted" style={{ fontSize: 12 }}>
              Your email
            </span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              inputMode="email"
              placeholder="you@example.com"
              style={INPUT}
            />
            <span
              className="row center gap-1 muted"
              style={{ fontSize: 11.5, justifyContent: "flex-start" }}
            >
              <Icon.Shield size={12} /> Your email is encrypted and used only for
              secure payout verification.
            </span>
          </label>

          {error && <ErrorBox message={error} />}

          <div className="col gap-2">
            <button
              className="btn btn-fat"
              disabled={!canCreate}
              onClick={createOrder}
              style={{
                background: canCreate ? "var(--btn-bg)" : "var(--bg-sunk)",
                color: canCreate ? "var(--btn-fg)" : "var(--fg-faint)",
                cursor: canCreate ? "pointer" : "default",
              }}
            >
              {creating ? (
                <>
                  <Icon.Spinner size={14} /> Creating order…
                </>
              ) : (
                <>
                  Continue to deposit details <Icon.ArrowRight />
                </>
              )}
            </button>
            <button className="btn btn-quiet" onClick={() => setQuote(null)}>
              Edit
            </button>
          </div>
        </div>
        )}
      </div>
    );
  }

  // ----- Form (same layout as the Paycrest amount screen) ------------------
  // Fees come back with the quote, so they show on the next step; this screen
  // shows the address ChainRails needs instead.
  const toOption = (c: RampCountry): CountryOption => ({
    value: c.countryCode,
    countryCode: c.countryCode,
    countryName: c.name,
    currencyCode: c.currency.code,
    currencyName: c.currency.name,
  });
  const popular = countries.filter((c) => isPaycrestFiat(c.currency.code));
  const others = countries.filter((c) => !isPaycrestFiat(c.currency.code));
  const blocker = !country
    ? "Choose a country"
    : !(cryptoAmount > 0)
      ? "Enter an amount"
      : belowMin
        ? `Minimum is ${country.currency.minAmount} ${token}`
        : !senderValid
          ? `Enter your ${source.label} address`
          : null;

  return (
    <div className="flex flex-col">
      <AmountField
        id="cr-sell-amount"
        label="You send"
        value={amount}
        onChange={onAmountChange}
        pill={chainPicker}
      >
        {noRate && token === "USDT" && (
          <p className="text-[13px] leading-snug text-warn-ink">
            USDT can&apos;t be sold from {source.label} here. Switch to USDC or
            pick another chain.
          </p>
        )}
      </AmountField>

      <RateLine
        approximate
        rate={
          unitRate && country
            ? {
                from: `1 ${token}`,
                to: `${formatNumber(unitRate)} ${country.currency.code}`,
              }
            : null
        }
      />

      <AmountField
        id="cr-sell-receive"
        label="They receive"
        readOnly
        prefix="≈"
        value={estimate !== null ? formatNumber(estimate) : ""}
        pill={
          <div className="relative">
            {country ? (
              <CurrencyPill
                countryCode={country.countryCode}
                currencyCode={country.currency.code}
                countryName={country.name}
                currencyName={country.currency.name}
                onClick={() => setCurrencyOpen((v) => !v)}
              />
            ) : (
              <button
                type="button"
                disabled={loading}
                onClick={() => setCurrencyOpen((v) => !v)}
                className="h-12 rounded-full border border-edge bg-pill px-4 text-sm font-semibold"
              >
                Choose country
              </button>
            )}
            <CurrencyPicker
              open={currencyOpen}
              onClose={() => setCurrencyOpen(false)}
              title="Recipient gets paid in"
              value={countryCode}
              popular={popular.map(toOption)}
              all={others.map(toOption)}
              storageKey="sell-cr"
              onSelect={(o) => setCountryCode(o.value)}
            />
          </div>
        }
      >
        {belowMin && country && (
          <p className="text-[13px] leading-snug text-warn-ink">
            Minimum to {country.name} is {country.currency.minAmount} {token}.
          </p>
        )}
      </AmountField>

      {/* ChainRails needs the sender address for a sell (refunds go there).
          Prefilled with the connected wallet, always editable. */}
      <div className="mt-4 flex flex-col gap-1.5 rounded-2xl border border-edge bg-subtle px-5 py-3 text-sm">
        <label htmlFor="cr-sender" className="text-muted">
          Sending from
        </label>
        <input
          id="cr-sender"
          value={senderAddress}
          onChange={(e) => setSenderAddress(e.target.value)}
          placeholder={`Your ${source.label} wallet address`}
          spellCheck={false}
          autoComplete="off"
          className="h-11 w-full rounded-xl border border-edge bg-card px-3 font-mono text-[13px] text-ink outline-none placeholder:text-muted focus:border-ink"
        />
        <span className="text-[13px] text-muted">
          {senderAddress.trim() && !senderValid
            ? `That doesn't look like a valid ${source.label} address.`
            : "This wallet address will be used for any refunds."}
        </span>
      </div>
      {estimate !== null && (
        <p className="mt-2 px-1 text-xs text-muted">
          Estimate · fees and the final rate show on the next step
        </p>
      )}

      {(error ?? countriesError) && (
        <div className="mt-3">
          <Notice tone="error">{(error ?? countriesError) as string}</Notice>
        </div>
      )}

      <PrimaryButton
        disabled={loading || !canQuote}
        loading={quoting}
        onClick={getQuote}
      >
        {quoting ? (
          "Getting quote…"
        ) : blocker ? (
          blocker
        ) : (
          <>
            Continue to recipient <ArrowRight />
          </>
        )}
      </PrimaryButton>
    </div>
  );
}

/** Order number that copies to the clipboard on tap — useful for support. */
function CopyableOrderId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard
          ?.writeText(id)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {})
      }
      className="font-mono muted transition-colors hover:text-[var(--fg)]"
      title="Copy order number"
      aria-label="Copy order number"
      style={{
        background: "transparent",
        border: 0,
        padding: 0,
        cursor: "pointer",
        fontSize: 12,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
      }}
    >
      Order #{id}
      {copied ? <Icon.Check size={11} /> : <Icon.Copy size={11} />}
    </button>
  );
}

/**
 * The deposit address the user sends their crypto to — the real action on
 * chains we can't sign in-app. Shown in full (the user needs every character)
 * with a one-tap copy that confirms, so nobody hand-types a wallet address.
 */
function DepositAddress({
  address,
  amountLabel,
  network,
}: {
  address: string;
  amountLabel: string;
  network: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard
      ?.writeText(address)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});

  return (
    <div className="card col gap-3" style={{ padding: 18 }}>
      <div className="col gap-1">
        <span className="eyebrow">Send to this address</span>
        <span className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
          Send exactly {amountLabel} on {network} from your own wallet. The
          amount must match for the payout to release.
        </span>
      </div>
      <code
        className="font-mono"
        style={{
          fontSize: 12.5,
          lineHeight: 1.5,
          wordBreak: "break-all",
          background: "var(--bg-soft)",
          border: "1px solid var(--line)",
          borderRadius: 12,
          padding: "12px 14px",
        }}
      >
        {address}
      </code>
      <button
        className="btn btn-primary"
        onClick={copy}
        style={{ height: 44, borderRadius: 12, fontWeight: 500 }}
      >
        {copied ? (
          <>
            <Icon.Check size={14} /> Copied
          </>
        ) : (
          <>
            <Icon.Copy size={14} /> Copy deposit address
          </>
        )}
      </button>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        background: "var(--err-soft)",
        border: "1px solid var(--err)",
        borderRadius: 10,
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}

const INPUT: React.CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  background: "var(--bg-soft)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  color: "var(--fg)",
  fontSize: 14,
  outline: "none",
};
