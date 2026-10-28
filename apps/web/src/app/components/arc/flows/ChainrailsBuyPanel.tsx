"use client";

/**
 * ChainrailsBuyPanel — the Buy body for chains Paycrest can't reach.
 *
 * Paycrest is our #1 on-ramp; this panel only renders for the ChainRails-only
 * destinations (Optimism, Avalanche, Solana, Monad, HyperEVM, Tron). It builds
 * the same `Quote` shape the Paycrest flow does, with the delivery address
 * already filled in, and hands it up — the parent goes straight to the order
 * page (no separate review screen; this screen already shows the amounts).
 *
 * UX matches the Paycrest flow: the user types a FIAT amount and sees the ≈USDC
 * they'll receive below. Chainrails quotes are crypto-amount-driven and it has
 * no rate endpoint, so we probe one small quote per country to learn the rate,
 * then convert locally as they type (like usePaycrestRate does for Paycrest).
 */

import React, { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { cachedFetch, ONE_HOUR } from "@/lib/cachedFetch";
import { formatNumber, formatToken, titleCase } from "@/utils";
import {
  isBelowRampMinimum,
  isValidRampAddress,
  rampMinimum,
  type RampCountry,
  type RampDestination,
} from "@/rails/chainrails";
import { useRampCountries } from "@/hooks/useRampCountries";
import { isPaycrestFiat, type PaycrestInstitution } from "@/rails/paycrest";
import type { TokenSymbol } from "@/config/network";
import { type Quote } from "../SendScreen";
import {
  AmountField,
  ArrowRight,
  CheckIcon,
  ChevronDown,
  CurrencyPill,
  Notice,
  PrimaryButton,
  RateLine,
} from "../ui/sendKit";
import { CurrencyPicker, type CountryOption } from "../ui/sendPickers";
import { PickerSheet } from "../ui/PickerSheet";
import { EMAIL_RE, loadSavedEmail, saveEmail } from "../rampEmail";
import {
  clearChainrailsRampDraft,
  loadChainrailsRampDraft,
  storeChainrailsRampDraft,
} from "../swapUrl";

type FieldOption = { label: string; value: string };
type FieldSpec = {
  key: string;
  label: string;
  type: string; // "phone" | "string" | "enum" | ...
  required?: boolean;
  options?: FieldOption[];
};

type RampQuote = {
  provider: string;
  quoteId?: string;
  fiatCurrency: string;
  fiatAmount: number;
  cryptoCurrency: string;
  cryptoAmount: number;
  // The SDK returned `exchangeRate`; the REST endpoint returns
  // `exchangeRatePerUSD`. Both are fiat per ~1 USDC.
  exchangeRate?: number;
  exchangeRatePerUSD?: number;
  totalFeesFiat?: number;
  paymentChannels?: {
    id?: string;
    name?: string;
    channel?: string;
    directTransferDetails?: { fieldsRequired?: FieldSpec[] };
  }[];
  rampChain: string;
  requiresBridge: boolean;
};

/** Fiat per 1 USDC, tolerant of both response shapes. */
function quoteRate(q: RampQuote): number {
  return q.exchangeRate ?? q.exchangeRatePerUSD ?? 0;
}

/**
 * The quote to use: the recommended one if it has a real price, otherwise the
 * first one that does. Some providers (e.g. PeerPay for INR) come back as
 * "recommended" with a 0 rate and 0 amount.
 */
function pickQuote(data: {
  recommended?: RampQuote | null;
  quotes?: RampQuote[];
}): RampQuote | undefined {
  const all = [data.recommended, ...(data.quotes ?? [])];
  return all.find((q): q is RampQuote => !!q && quoteRate(q) > 0);
}

/** FONBNK-style provider fields the order needs (bank dropdown, phone, account). */
function requiredFieldsOf(q: RampQuote | undefined): FieldSpec[] {
  return q?.paymentChannels?.[0]?.directTransferDetails?.fieldsRequired ?? [];
}

// A small crypto amount to probe the corridor's exchange rate with. The rate is
// amount-independent, so this only needs to clear the provider minimum.
const RATE_PROBE_CRYPTO = 10;

export function ChainrailsBuyPanel({
  destination,
  onQuote,
  chainPicker,
  amount,
  onAmountChange,
  countryCode: chosenCountry,
  onCountryChange,
}: {
  destination: RampDestination;
  /** Hand the built quote (address included) up to create the order. */
  onQuote: (quote: Quote) => void;
  /** The parent's token + chain pill, shown in the "You receive" field. */
  chainPicker: React.ReactNode;
  /** The FIAT amount the user pays, owned by the parent so it survives switching
   *  between the Paycrest form and this panel. */
  amount: string;
  onAmountChange: (v: string) => void;
  /** Set when the parent's currency picker chose the country (e.g. India).
   *  "" means "Other country" — the user still has to pick one here. */
  countryCode?: string;
  onCountryChange?: (country: RampCountry) => void;
}) {
  const {
    countries,
    loading,
    error: countriesError,
  } = useRampCountries("on-ramp");
  const [ownCountry, setOwnCountry] = useState("NG");
  const countryCode = chosenCountry ?? ownCountry;
  const setCountryCode = (code: string) => {
    const next = countries.find((c) => c.countryCode === code);
    if (onCountryChange && next) onCountryChange(next);
    else setOwnCountry(code);
  };
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  // Where the USDC is delivered. Prefilled with the connected wallet on EVM
  // chains (the only address the wallet gives us); pasted for Solana/Tron.
  const { address: connectedAddress } = useAccount();
  const [recipient, setRecipient] = useState("");
  useEffect(() => {
    if (destination.addressKind === "evm" && connectedAddress)
      setRecipient((cur) => cur || connectedAddress);
  }, [destination.addressKind, connectedAddress]);
  const recipientValid = isValidRampAddress(destination.addressKind, recipient);
  const [unitRate, setUnitRate] = useState<number | null>(null); // fiat per 1 USDC
  const [rateLoading, setRateLoading] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // FONBNK on-ramp requires phone/bank/account to create the order; the fields
  // (and the dynamic bank list) come from the quote's directTransferDetails.
  const [fields, setFields] = useState<FieldSpec[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  // Banks for the pay currency, so the refund account is picked by NAME and we
  // send the institution code for the user instead of asking them to type it.
  const [refundBanks, setRefundBanks] = useState<PaycrestInstitution[]>([]);
  // Refund account-name lookup — resolved from bank + number, never typed.
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  // Contact/KYC email — entered once, then remembered on-device and reused
  // (shared with Sell). We only prompt when nothing is saved yet.
  const [email, setEmail] = useState("");
  const [askEmail, setAskEmail] = useState(false);
  useEffect(() => {
    const saved = loadSavedEmail();
    if (saved) setEmail(saved);
    else setAskEmail(true);
  }, []);

  // Restore a half-filled panel (amount, country, provider fields) after a
  // refresh so nothing has to be retyped. Kept per corridor chain. The dynamic
  // field list is re-fetched by the rate probe below; it merges onto these.
  useEffect(() => {
    const d = loadChainrailsRampDraft(destination.chainrailsChain);
    if (!d) return;
    // Amount is owned by the parent (shared with the Paycrest form) so it carries
    // across a chain switch — the per-chain draft only restores country + fields.
    if (d.countryCode) setOwnCountry(d.countryCode);
    if (d.fields) setFieldValues(d.fields);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination.chainrailsChain]);

  // Save inputs as they change so a refresh / back doesn't lose them.
  useEffect(() => {
    storeChainrailsRampDraft(destination.chainrailsChain, {
      amount,
      countryCode,
      fields: fieldValues,
    });
  }, [destination.chainrailsChain, amount, countryCode, fieldValues]);

  // Fall back to the first country if ours isn't in the list.
  useEffect(() => {
    if (
      countries.length &&
      !countries.some((c) => c.countryCode === ownCountry)
    )
      setOwnCountry(countries[0].countryCode);
  }, [countries, ownCountry]);

  const country = countries.find((c) => c.countryCode === countryCode);

  // Load the bank list for the pay currency so the refund field is a name
  // dropdown (value = Paycrest institution code) rather than a raw code box.
  const refundCurrency = country?.currency.code;
  useEffect(() => {
    // Drop the previous country's banks so they can't linger if this fails.
    setRefundBanks([]);
    if (!refundCurrency) return;
    let cancelled = false;
    cachedFetch(
      `/api/paycrest/institutions?currency=${encodeURIComponent(refundCurrency)}`,
      {},
      ONE_HOUR
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok || cancelled) return;
        setRefundBanks(data.institutions ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refundCurrency]);

  // Resolve the refund account holder's name from the bank + number (Paycrest
  // verify), so the user confirms it instead of typing it. Debounced; only runs
  // when both are set. Clears the name if either changes or fails.
  const refundInst = fieldValues.refundInstitution;
  const refundAcct = (fieldValues.refundAccountIdentifier ?? "").trim();
  useEffect(() => {
    if (!refundInst || refundAcct.length < 6) {
      setVerifying(false);
      setVerifyError(null);
      setFieldValues((p) =>
        p.refundAccountName ? { ...p, refundAccountName: "" } : p
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
            institution: refundInst,
            accountIdentifier: refundAcct,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data?.accountName) {
          setVerifyError(data?.error || "Couldn't verify this account.");
          setFieldValues((p) => ({ ...p, refundAccountName: "" }));
        } else {
          setFieldValues((p) => ({
            ...p,
            refundAccountName: data.accountName,
          }));
        }
      } catch {
        if (!cancelled) {
          setVerifyError("Couldn't reach the verification service.");
          setFieldValues((p) => ({ ...p, refundAccountName: "" }));
        }
      } finally {
        if (!cancelled) setVerifying(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [refundInst, refundAcct]);

  // Probe one quote per country/chain to learn the exchange rate.
  useEffect(() => {
    if (!country) return;
    let cancelled = false;
    setUnitRate(null);
    // Each provider asks for different fields (INR asks for none) — don't
    // carry the last country's fields over while this one loads.
    setFields([]);
    setRateLoading(true);
    // Cached for a minute: flipping between chains/countries reuses it.
    cachedFetch("/api/chainrails/ramp/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fiatCurrency: country.currency.code,
        // Must clear the corridor minimum or the quote is rejected (INR: 13).
        cryptoAmount: Math.max(RATE_PROBE_CRYPTO, country.currency.minAmount),
        destinationChain: destination.chainrailsChain,
        countryCode,
      }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok || cancelled) return;
        const q = pickQuote(data);
        if (q) setUnitRate(quoteRate(q));
        // Learn which provider fields the order needs + seed enum defaults.
        const req = requiredFieldsOf(q);
        setFields(req);
        setFieldValues((prev) => {
          const next = { ...prev };
          for (const f of req) {
            if (f.type === "enum" && f.options?.[0] && !next[f.key])
              next[f.key] = f.options[0].value;
          }
          return next;
        });
      })
      .catch(() => {})
      .finally(() => !cancelled && setRateLoading(false));
    return () => {
      cancelled = true;
    };
  }, [countryCode, country, destination.chainrailsChain]);

  const fiatAmount = Number(amount);
  const estimateUsdc =
    unitRate && fiatAmount > 0 ? fiatAmount / unitRate : null;
  const belowMin = isBelowRampMinimum(country, estimateUsdc);
  const minimum = country ? rampMinimum(country, unitRate) : null;
  const fieldsComplete = fields.every(
    (f) => !f.required || (fieldValues[f.key]?.trim()?.length ?? 0) > 0
  );
  const emailValid = EMAIL_RE.test(email.trim());
  const canQuote =
    !!country &&
    fiatAmount > 0 &&
    !!unitRate &&
    !belowMin &&
    fieldsComplete &&
    emailValid &&
    recipientValid;

  const buildQuote = (r: RampQuote, c: RampCountry): Quote => ({
    from: { token: r.fiatCurrency, chain: c.name, amount: r.fiatAmount },
    to: {
      kind: "Wallet",
      currency: r.cryptoCurrency,
      amount: formatToken(r.cryptoAmount, r.cryptoCurrency, 4),
      label: destination.label,
      sub: "",
    },
    rate: `1 ${r.cryptoCurrency} = ${formatNumber(quoteRate(r))} ${r.fiatCurrency}`,
    fee: {
      network: r.requiresBridge
        ? "Included (cross-chain delivery)"
        : "Included",
      rail:
        r.totalFeesFiat != null
          ? `${formatNumber(r.totalFeesFiat)} ${r.fiatCurrency}`
          : "Included in provider quote",
      spread: "Included in provider quote",
      total:
        r.totalFeesFiat != null
          ? `${formatNumber(r.totalFeesFiat)} ${r.fiatCurrency}`
          : "Included in provider quote",
    },
    eta: r.requiresBridge ? "≈ 3–10 min" : "≈ 1–3 min",
    rail: ["Pay provider", r.requiresBridge ? "Bridge" : "Deliver", "Receive"],
    kind: "fiat",
    railName: "Fiat",
    railReason: `Delivered to your ${destination.label} address.`,
    exec: {
      rail: "chainrails",
      action: "onramp",
      fromChain: destination.chainId ?? "ethereum",
      fromToken: r.fiatCurrency as TokenSymbol,
      fromAmount: String(r.fiatAmount),
      toChain: destination.chainId,
      toToken: "USDC",
      fiatCurrency: r.fiatCurrency,
      recipient: recipient.trim(),
      chainrailsRamp: {
        provider: r.provider,
        countryCode,
        cryptoAmount: r.cryptoAmount,
        paymentChannelId:
          r.paymentChannels?.[0]?.id ?? r.paymentChannels?.[0]?.channel,
        destinationChain: destination.chainrailsChain,
        destinationLabel: destination.label,
        addressKind: destination.addressKind,
        userEmail: email.trim(),
        fields: { ...fieldValues },
      },
    },
  });

  const getQuote = async () => {
    if (!country || !canQuote || !unitRate) return;
    saveEmail(email.trim()); // remember it for next time (passed emailValid gate)
    // Convert the fiat the user typed into the crypto amount Chainrails quotes on.
    const cryptoAmount = Number((fiatAmount / unitRate).toFixed(4));
    setQuoting(true);
    setError(null);
    try {
      const res = await fetch("/api/chainrails/ramp/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fiatCurrency: country.currency.code,
          cryptoAmount,
          destinationChain: destination.chainrailsChain,
          countryCode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Couldn't get a quote.");
      const selected = pickQuote(data);
      if (!selected)
        throw new Error("No provider can quote this purchase right now.");
      clearChainrailsRampDraft(destination.chainrailsChain);
      onQuote(buildQuote(selected, country));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't get a quote.");
    } finally {
      setQuoting(false);
    }
  };

  // Picker rows: Paycrest corridors first, then the rest alphabetically.
  const toOption = (c: RampCountry): CountryOption => ({
    value: c.countryCode,
    countryCode: c.countryCode,
    countryName: c.name,
    currencyCode: c.currency.code,
    currencyName: c.currency.name,
  });
  const popular = countries.filter((c) => isPaycrestFiat(c.currency.code));
  const others = countries.filter((c) => !isPaycrestFiat(c.currency.code));

  // The button says what's missing, in order.
  const blocker = !country
    ? "Choose a country"
    : !(fiatAmount > 0)
      ? "Enter an amount"
      : !unitRate
        ? rateLoading
          ? "Loading rate…"
          : "No live rate right now"
        : belowMin
          ? "Below the minimum"
          : !recipientValid
            ? `Enter your ${destination.label} wallet address`
            : !fieldsComplete
              ? "Fill in the refund account"
              : !emailValid
                ? "Enter your email"
                : null;

  const inputClass =
    "h-12 w-full rounded-[14px] border border-edge bg-card px-3.5 text-[15px] text-ink outline-none placeholder:text-muted focus:border-ink focus:shadow-[0_0_0_3px_rgba(23,23,26,0.08)]";

  return (
    <div className="flex flex-col">
      <AmountField
        id="cr-buy-amount"
        label="You pay"
        value={amount}
        onChange={onAmountChange}
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
              title="Pay with"
              value={countryCode}
              popular={popular.map(toOption)}
              all={others.map(toOption)}
              storageKey="buy-cr"
              onSelect={(o) => setCountryCode(o.value)}
            />
          </div>
        }
      >
        {belowMin && country && minimum && (
          <p className="text-[13px] leading-snug text-warn-ink">
            Minimum is
            {minimum.fiat !== null &&
              ` about ${country.currency.symbol}${formatNumber(minimum.fiat)}`}{" "}
            ({minimum.usdc} USDC).
          </p>
        )}
      </AmountField>

      {!rateLoading && country && !unitRate ? (
        <p className="px-1 py-2.5 text-[13px] text-warn-ink">
          Couldn&apos;t load a live rate for {destination.label} in{" "}
          {country.currency.code} right now.
        </p>
      ) : (
        <RateLine
          approximate
          rate={
            unitRate && country
              ? {
                  from: "1 USDC",
                  to: `${formatNumber(unitRate)} ${country.currency.code}`,
                }
              : null
          }
        />
      )}

      <AmountField
        id="cr-buy-receive"
        label="You receive"
        readOnly
        prefix="≈"
        value={estimateUsdc !== null ? formatNumber(estimateUsdc) : ""}
        pill={chainPicker}
      />

      {/* Delivery address, refund account and anything else the provider
          needs, in one box. */}
      <div className="mt-4 flex flex-col gap-4 rounded-card border border-edge bg-card px-5 py-4">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="cr-recipient"
            className="text-[13px] font-medium text-muted"
          >
            Receive USDC to
          </label>
          <input
            id="cr-recipient"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={`Your ${destination.label} wallet address`}
            spellCheck={false}
            autoComplete="off"
            className={`${inputClass} font-mono text-[13px]`}
          />
          {recipient.trim() && !recipientValid && (
            <span className="text-[13px] text-danger">
              That doesn&apos;t look like a valid {destination.label} address.
            </span>
          )}
        </div>
        {fields.length > 0 && (
          <div className="flex flex-col gap-0.5 border-t border-edge-soft pt-4">
            <h2 className="text-[15px] font-semibold">Refund account</h2>
            <p className="text-[13px] text-muted">
              This account will be used for any refunds.
            </p>
          </div>
        )}
        {fields.map((f) => {
          const isRefundBank = f.key === "refundInstitution";

          // The account name is looked up from bank + number; typed only
          // when the lookup can't confirm it.
          if (f.key === "refundAccountName") {
            const ready =
              !!fieldValues.refundInstitution &&
              (fieldValues.refundAccountIdentifier?.trim().length ?? 0) >= 6;
            if (!ready) return null;
            if (verifying) {
              return (
                <p
                  key={f.key}
                  className="flex items-center gap-2 text-[13px] text-muted"
                >
                  <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Checking account…
                </p>
              );
            }
            if (verifyError) {
              return (
                <div key={f.key} className="flex flex-col gap-1.5">
                  <label
                    htmlFor={`cr-${f.key}`}
                    className="text-[13px] font-medium text-muted"
                  >
                    Account holder&apos;s name
                  </label>
                  <input
                    id={`cr-${f.key}`}
                    value={fieldValues.refundAccountName ?? ""}
                    onChange={(e) =>
                      setFieldValues((p) => ({
                        ...p,
                        refundAccountName: e.target.value,
                      }))
                    }
                    placeholder="Name on the account"
                    className={inputClass}
                  />
                  <span className="text-[13px] text-muted">
                    We couldn&apos;t confirm this account. Type the name as it
                    appears at the bank.
                  </span>
                </div>
              );
            }
            const name = fieldValues.refundAccountName ?? "";
            if (!name) return null;
            return (
              <div
                key={f.key}
                role="status"
                className="flex items-start gap-3 rounded-[14px] border border-[#bfdccb] bg-[#eef6f1] p-3.5"
              >
                <span className="grid size-6 flex-none place-items-center rounded-full bg-success text-white">
                  <CheckIcon size={13} />
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[15px] font-semibold text-[#134a30]">
                    {titleCase(name)}
                  </span>
                  <span className="text-[13px] text-[#2e5e45]">
                    Name confirmed. Check this is your account.
                  </span>
                </div>
              </div>
            );
          }

          if (isRefundBank && refundBanks.length > 0) {
            const bank = refundBanks.find((b) => b.code === fieldValues[f.key]);
            return (
              <div key={f.key} className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-muted">
                  Refund bank
                </span>
                <div className="relative">
                  <button
                    type="button"
                    aria-haspopup="listbox"
                    onClick={() => setBankOpen((v) => !v)}
                    className="flex h-12 w-full items-center gap-3 rounded-[14px] border border-edge bg-card px-3.5 text-left"
                  >
                    <span
                      className={`flex-1 truncate text-[15px] ${bank ? "font-medium" : "text-muted"}`}
                    >
                      {bank?.name ?? "Choose your bank"}
                    </span>
                    <ChevronDown />
                  </button>
                  <PickerSheet
                    open={bankOpen}
                    onClose={() => setBankOpen(false)}
                    title="Refund bank"
                    value={fieldValues[f.key] ?? ""}
                    searchPlaceholder="Search banks"
                    groups={[
                      {
                        label: "Banks",
                        items: refundBanks.map((b) => ({
                          value: b.code,
                          title: b.name,
                          logo: (
                            <span
                              aria-hidden
                              className="grid size-7 flex-none place-items-center rounded-lg bg-chip text-[13px] font-bold text-ink-soft"
                            >
                              {b.name.charAt(0).toUpperCase()}
                            </span>
                          ),
                        })),
                      },
                    ]}
                    onSelect={(code) =>
                      setFieldValues((p) => ({ ...p, [f.key]: code }))
                    }
                  />
                </div>
              </div>
            );
          }

          const label =
            f.key === "refundAccountIdentifier"
              ? "Refund account number"
              : isRefundBank
                ? "Refund bank"
                : f.label;
          return (
            <div key={f.key} className="flex flex-col gap-1.5">
              <label
                htmlFor={`cr-${f.key}`}
                className="text-[13px] font-medium text-muted"
              >
                {label}
              </label>
              {f.type === "enum" ? (
                <select
                  id={`cr-${f.key}`}
                  value={fieldValues[f.key] ?? ""}
                  onChange={(e) =>
                    setFieldValues((p) => ({ ...p, [f.key]: e.target.value }))
                  }
                  className={`${inputClass} cursor-pointer`}
                >
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`cr-${f.key}`}
                  value={fieldValues[f.key] ?? ""}
                  onChange={(e) =>
                    setFieldValues((p) => ({ ...p, [f.key]: e.target.value }))
                  }
                  inputMode={
                    f.type === "phone" || f.key === "refundAccountIdentifier"
                      ? "tel"
                      : undefined
                  }
                  autoComplete="off"
                  placeholder={label}
                  className={inputClass}
                />
              )}
            </div>
          );
        })}

        {/* Asked once; afterwards remembered on-device and hidden. */}
        {askEmail && (
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="cr-email"
              className="text-[13px] font-medium text-muted"
            >
              Email (for receipts)
            </label>
            <input
              id="cr-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              className={inputClass}
            />
          </div>
        )}
      </div>

      {unitRate && estimateUsdc !== null && (
        <p className="mt-2 px-1 text-xs text-muted">
          Estimate · final rate locks when you create the order
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
            Continue to payment <ArrowRight />
          </>
        )}
      </PrimaryButton>
    </div>
  );
}
