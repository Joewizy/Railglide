"use client";

/**
 * ChainrailsBuyPanel — the Buy body for chains Paycrest can't reach.
 *
 * Paycrest is our #1 on-ramp; this panel only renders for the ChainRails-only
 * destinations (Optimism, Avalanche, Solana, Monad, HyperEVM, Tron). It builds
 * the same `Quote` shape the Paycrest flow does and hands it up so the shared
 * <ReviewScreen> renders the confirm step — one consistent order-details card,
 * and it collects the delivery address there (validated per chain format).
 *
 * UX matches the Paycrest flow: the user types a FIAT amount and sees the ≈USDC
 * they'll receive below. Chainrails quotes are crypto-amount-driven and it has
 * no rate endpoint, so we probe one small quote per country to learn the rate,
 * then convert locally as they type (like usePaycrestRate does for Paycrest).
 */

import React, { useEffect, useState } from "react";
import { countryFlag, formatNumber, formatToken } from "@/utils";
import {
  isBelowRampMinimum,
  rampMinimum,
  type RampCountry,
  type RampDestination,
} from "@/rails/chainrails";
import { useRampCountries } from "@/hooks/useRampCountries";
import { type PaycrestInstitution } from "@/rails/paycrest";
import type { TokenSymbol } from "@/config/network";
import { PrefixedAmountInput } from "./PrefixedAmountInput";
import { type Quote, AccountNameStatus } from "../SendScreen";
import { Icon } from "../icons";
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
  networkSelect,
  amount,
  onAmountChange,
  countryCode: chosenCountry,
  onCountryChange,
}: {
  destination: RampDestination;
  /** Hand the built quote up so the shared ReviewScreen renders the confirm. */
  onQuote: (quote: Quote) => void;
  /** The shared "Receive on" network picker, rendered inside this card. */
  networkSelect: React.ReactNode;
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
    if (countries.length && !countries.some((c) => c.countryCode === ownCountry))
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
    fetch(`/api/paycrest/institutions?currency=${encodeURIComponent(refundCurrency)}`)
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
          setFieldValues((p) => ({ ...p, refundAccountName: data.accountName }));
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
    fetch("/api/chainrails/ramp/quote", {
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
    emailValid;

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
      recipient: null,
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

  return (
    <div className="card col gap-5" style={{ padding: 20 }}>
      <label className="col gap-2">
        <span style={LABEL}>
          You pay
        </span>
        <PrefixedAmountInput
          amount={amount}
          onAmountChange={onAmountChange}
          prefix={country?.currency.symbol ?? "₦"}
        />
        {unitRate && estimateUsdc !== null && (
          <div
            className="row center gap-2"
            style={{ fontSize: 12.5, padding: "0 2px" }}
          >
            <span style={{ color: "var(--accent)", fontWeight: 500 }}>
              You receive ≈ {formatToken(estimateUsdc, "USDC", 2)}
            </span>
            <span className="muted font-mono tabular">
              (1 USDC = {formatNumber(unitRate)} {country?.currency.code})
            </span>
          </div>
        )}
        {unitRate && estimateUsdc !== null && (
          <span
            className="muted"
            style={{ fontSize: 11, padding: "0 2px", opacity: 0.85 }}
          >
            Estimate · final rate locks when you create the order
          </span>
        )}
        {!rateLoading && country && !unitRate && (
          <span style={{ fontSize: 12, color: "var(--pend)" }}>
            Couldn&apos;t load a live rate for {destination.label} in{" "}
            {country.currency.code} right now.
          </span>
        )}
      </label>

      <label className="col gap-2">
        <span style={LABEL}>
          Paying with
        </span>
        <select
          value={countryCode}
          onChange={(e) => setCountryCode(e.target.value)}
          disabled={loading}
          style={INPUT}
        >
          {!country && (
            <option value="" disabled>
              Choose your country…
            </option>
          )}
          {countries.map((c) => (
            <option key={c.countryCode} value={c.countryCode}>
              {countryFlag(c.countryCode)} {c.name} · {c.currency.code}
            </option>
          ))}
        </select>
      </label>

      <label className="col gap-2">
        <span style={LABEL}>
          Receive
        </span>
        {networkSelect}
        <span className="muted" style={{ fontSize: 12 }}>
          Your USDC is delivered straight to your {destination.label} address.
        </span>
      </label>

      {/* Provider fields the order requires (bank dropdown, phone, account). */}
      {fields.map((f) => {
        // The refund institution is a bank code — show a name dropdown and send
        // the code for the user, so they never have to know or type it.
        const isRefundBank = f.key === "refundInstitution";

        // The refund account name is resolved from the bank + number. If the
        // lookup can't confirm it, we fall back to a plain text box so a miss
        // never blocks the order.
        if (f.key === "refundAccountName") {
          const ready =
            !!fieldValues.refundInstitution &&
            (fieldValues.refundAccountIdentifier?.trim().length ?? 0) >= 6;
          // Until there's an account to look up, show nothing — the name is a
          // result we resolve, not another box to fill.
          if (!ready) return null;
          const needsManual = ready && !verifying && !!verifyError;
          return (
            <div key={f.key} className="col gap-2">
              <span style={LABEL}>
                Refund account name
              </span>
              {needsManual ? (
                <>
                  <input
                    value={fieldValues.refundAccountName ?? ""}
                    onChange={(e) =>
                      setFieldValues((p) => ({
                        ...p,
                        refundAccountName: e.target.value,
                      }))
                    }
                    placeholder="Enter the account name"
                    style={INPUT}
                  />
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    We couldn&apos;t confirm this account automatically — type the
                    name exactly as it appears at the bank.
                  </span>
                </>
              ) : (
                <AccountNameStatus
                  verifying={verifying}
                  error={verifyError}
                  name={fieldValues.refundAccountName ?? ""}
                />
              )}
            </div>
          );
        }

        return (
          <label key={f.key} className="col gap-2">
            <span style={LABEL}>
              {isRefundBank ? "Refund bank" : f.label}
            </span>
            {isRefundBank && refundBanks.length > 0 ? (
              <select
                value={fieldValues[f.key] ?? ""}
                onChange={(e) =>
                  setFieldValues((p) => ({ ...p, [f.key]: e.target.value }))
                }
                style={INPUT}
              >
                <option value="" disabled>
                  Select your bank
                </option>
                {refundBanks.map((b) => (
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
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={fieldValues[f.key] ?? ""}
                onChange={(e) =>
                  setFieldValues((p) => ({ ...p, [f.key]: e.target.value }))
                }
                inputMode={f.type === "phone" ? "tel" : undefined}
                placeholder={f.label}
                style={INPUT}
              />
            )}
          </label>
        );
      })}

      {/* Asked once; afterwards it's remembered on-device and this is hidden. */}
      {askEmail && (
        <label className="col gap-2">
          <span style={LABEL}>
            Email (for KYC &amp; receipts)
          </span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            inputMode="email"
            placeholder="you@example.com"
            style={INPUT}
          />
        </label>
      )}

      {belowMin && country && minimum && (
        <span style={{ fontSize: 12, color: "var(--pend)" }}>
          Minimum is
          {minimum.fiat !== null &&
            ` about ${country.currency.symbol}${formatNumber(minimum.fiat)}`}{" "}
          ({minimum.usdc} USDC).
        </span>
      )}
      {(error ?? countriesError) && (
        <div
          style={{
            padding: "12px 14px",
            background: "var(--err-soft)",
            border: "1px solid var(--err)",
            borderRadius: 10,
            fontSize: 13,
          }}
        >
          {error ?? countriesError}
        </div>
      )}

      <button
        className="btn btn-fat"
        disabled={loading || quoting || !canQuote}
        onClick={getQuote}
        style={{
          background: canQuote ? "var(--btn-bg)" : "var(--bg-sunk)",
          color: canQuote ? "var(--btn-fg)" : "var(--fg-faint)",
          cursor: canQuote && !quoting && !rateLoading ? "pointer" : "default",
        }}
      >
        {quoting ? (
          <>
            <Icon.Spinner size={14} /> Getting live quote…
          </>
        ) : rateLoading ? (
          <>
            <Icon.Spinner size={14} /> Loading rate…
          </>
        ) : (
          <>
            Continue <Icon.ArrowRight />
          </>
        )}
      </button>
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

// Matches the Paycrest buy card's field labels.
const LABEL: React.CSSProperties = {
  fontSize: 13,
  color: "var(--fg-mute)",
};
