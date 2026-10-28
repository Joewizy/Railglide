"use client";

/**
 * BuyFlow — guided fiat on-ramp (local currency → stablecoin).
 *
 * Paycrest is our #1 on-ramp: for the chains it serves the user gets the clean
 * pay-fiat → receive-USDC/USDT flow (rate line, refund account on Review).
 * Chains Paycrest can't reach (Optimism, Avalanche, Solana, Starknet, Monad,
 * HyperEVM, Lisk, Tron) route to ChainRails via <ChainrailsBuyPanel>, which
 * needs only a destination address — the provider checkout collects payment.
 */

import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import {
  DEFAULT_SETTLEMENT_CHAIN_ID,
  getChain,
  resolveChain,
  type ChainId,
} from "@/config/network";
import {
  PAYCREST_CHAIN_IDS,
  PAYCREST_FIAT,
  isPaycrestFiat,
} from "@/rails/paycrest";
import {
  CHAINRAILS_EXTRA_FIAT,
  CHAINRAILS_RAMP_DESTINATIONS,
  chainrailsDestinationFor,
  type RampCountry,
  type RampDestination,
} from "@/rails/chainrails";
import { usePaycrestNetwork } from "@/hooks/usePaycrestNetwork";
import { usePaycrestRate } from "@/hooks";
import { fetchPaycrestRate } from "@/lib/paycrestRate";
import {
  FIAT_HOME_COUNTRY,
  FIAT_NAMES,
  formatNumber,
  formatToken,
} from "@/utils";
import { useRampCountries } from "@/hooks/useRampCountries";
import { useTokenSupport } from "@/hooks/useTokenSupport";
import { ChainrailsBuyPanel } from "./ChainrailsBuyPanel";
import { BuyReview } from "./BuyReview";
import { ChainLogo, RampLogo, TokenLogo } from "../Web3Logo";
import {
  AmountField,
  ArrowRight,
  CurrencyPill,
  FlowHeader,
  FlowPage,
  Notice,
  PrimaryButton,
  RateLine,
  StepProgress,
  TokenChainPill,
} from "../ui/sendKit";
import {
  CurrencyPicker,
  TokenChainPicker,
  type CountryOption,
} from "../ui/sendPickers";
import {
  quoteFromIntent,
  type Intent,
  type IntentResponse,
  type PayoutDetails,
  type Quote,
} from "../SendScreen";
import {
  clearComposeDraft,
  clearFlowDraft,
  clearPendingLaunch,
  isDraftStale,
  loadComposeDraft,
  loadFlowDraft,
  loadPendingLaunch,
  storeComposeDraft,
  storeFlowDraft,
  type FlowDraft,
} from "../swapUrl";
import { useSwapFlowNav } from "../useSwapFlowNav";

const TOKENS = ["USDC", "USDT"] as const;

/** Quote lines (crypto received + rate) derived from a unit rate. */
function rateLines(
  amount: string,
  currency: string,
  token: string,
  unitRate: number
) {
  const received = (Number(amount) || 0) / unitRate;
  return {
    amount: `≈ ${formatToken(received, token, 2)}`,
    rate: `${formatNumber(unitRate)} ${currency}/${token}`,
  };
}

export function BuyFlow({
  onSubmit,
  onBack,
}: {
  onSubmit: (intent: Intent) => void;
  onBack: () => void;
}) {
  const { step, setStep, patchUrl } = useSwapFlowNav();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<string>("NGN");
  const [token, setToken] = useState<(typeof TOKENS)[number]>("USDC");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [payoutDraft, setPayoutDraft] = useState<PayoutDetails | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(step !== "review");
  // Non-Paycrest destination → ChainRails panel. Null while on a Paycrest chain.
  const [crDest, setCrDest] = useState<RampDestination | null>(null);
  // Country picked from "More countries" (e.g. "IN"). Those currencies go
  // through ChainRails on the chosen chain. "" = "Other country", not picked
  // yet. Null while paying with a Paycrest currency.
  const [payCountry, setPayCountry] = useState<string | null>(null);

  // Receiving USDC needs no wallet switch — it lands at your address on any
  // supported chain. So the destination is an explicit choice, pre-selected to
  // the chain you're already on (when supported) and overridable below.
  const { chain: smartDefault } = usePaycrestNetwork();
  const [network, setNetwork] = useState<ChainId>(smartDefault);
  const [networkTouched, setNetworkTouched] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  // Every country ChainRails can sell to, for the searchable currency picker.
  const { countries: buyCountries } = useRampCountries("on-ramp");
  const tokens = useTokenSupport();
  useEffect(() => {
    if (!networkTouched && !crDest) setNetwork(smartDefault);
  }, [smartDefault, networkTouched, crDest]);
  // Live unit rate, fetched once per (currency, token) pair — we divide the
  // typed fiat by it locally so the crypto estimate updates with no extra API
  // calls. The exact rate locks when the order is created.
  // Paycrest rate is irrelevant on a Chainrails chain (the panel fetches its
  // own), so don't request it then.
  const payDest =
    payCountry === null
      ? null
      : (chainrailsDestinationFor(network) ??
        chainrailsDestinationFor(DEFAULT_SETTLEMENT_CHAIN_ID));
  const panelDest = crDest ?? payDest;
  const { rate: unitRate } = usePaycrestRate(currency, token, !panelDest, "buy");
  const amountNum = Number(amount) || 0;
  const estimate = unitRate && amountNum > 0 ? amountNum / unitRate : null;

  const canContinue = Number(amount) > 0;
  const label = `Buy ${token} with ${amount} ${currency}`;

  // "Paying with" picker: Paycrest currencies use this form; "cr:IN" style
  // values (More countries) switch to the ChainRails panel.
  const choosePayCurrency = (value: string) => {
    if (!value.startsWith("cr:")) {
      setCurrency(value);
      setPayCountry(null);
      return;
    }
    const countryCode = value.slice(3);
    const extra = CHAINRAILS_EXTRA_FIAT.find(
      (f) => f.countryCode === countryCode
    );
    if (extra) setCurrency(extra.code);
    setPayCountry(countryCode);
    setToken("USDC"); // ChainRails only delivers USDC
  };

  // A row picked in the currency picker. Paycrest currencies keep this form;
  // any other country goes through ChainRails (USDC only).
  // A partner currency handed over from chat, picked once the list loads.
  const [pendingCurrency, setPendingCurrency] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingCurrency || !buyCountries.length) return;
    const c = buyCountries.find((x) => x.currency.code === pendingCurrency);
    if (c) {
      setCurrency(c.currency.code);
      setPayCountry(c.countryCode);
      setToken("USDC");
    }
    setPendingCurrency(null);
  }, [pendingCurrency, buyCountries]);

  const chooseCountry = (o: CountryOption) => {
    if (!o.value.startsWith("cr:")) {
      choosePayCurrency(o.value);
      return;
    }
    setCurrency(o.currencyCode);
    setPayCountry(o.countryCode);
    setToken("USDC");
  };

  // Country changed inside the ChainRails panel. A Paycrest currency goes
  // back to the normal form.
  const choosePanelCountry = (country: RampCountry) => {
    const code = country.currency.code;
    if (isPaycrestFiat(code) && !crDest) {
      setCurrency(code);
      setPayCountry(null);
      return;
    }
    setCurrency(code);
    setPayCountry(country.countryCode);
  };

  // Restore a saved currency, including the pinned ChainRails ones.
  const restoreCurrency = (code: string) => {
    const extra = CHAINRAILS_EXTRA_FIAT.find(
      (f) => f.code === code.toUpperCase()
    );
    if (extra) {
      setCurrency(extra.code);
      setPayCountry(extra.countryCode);
    } else if (isPaycrestFiat(code)) {
      setCurrency(code.toUpperCase());
    }
  };

  const selectNetwork = (id: ChainId) => {
    setNetworkTouched(true);
    setNetwork(id);
    setCrDest(null);
  };

  // Restore review step after refresh (?flow=buy&step=review).
  useEffect(() => {
    if (step !== "review") {
      setReady(true);
      return;
    }
    const draft = loadFlowDraft();
    if (draft?.flow === "buy") {
      setAmount(draft.amount);
      setCurrency(draft.currency);
      if (draft.token === "USDC" || draft.token === "USDT") {
        setToken(draft.token);
      }
      setQuote(draft.quote);
      setPayoutDraft(draft.payout);
      setReady(true);
      // A persisted quote is a cache — refresh the rate line if it's gone stale.
      if (isDraftStale(draft)) void refreshRate(draft);
      return;
    }
    setStep("compose");
    setReady(true);
  }, [step, setStep]);

  // Restore a half-filled compose form after a refresh or a trip back to Home,
  // so nothing has to be retyped. Runs before the chat-launch effect below, so a
  // launch from chat (which clears itself) still wins; the review step restores
  // from its own richer draft above.
  useEffect(() => {
    if (step === "review") return;
    if (loadPendingLaunch()?.flow === "buy") return;
    const d = loadComposeDraft("buy");
    if (!d) return;
    if (d.amount) setAmount(d.amount);
    if (d.currency) restoreCurrency(d.currency);
    if (d.payCountry !== undefined) setPayCountry(d.payCountry);
    if (d.token === "USDC" || d.token === "USDT") setToken(d.token);
    if (d.crChain) {
      const dest = CHAINRAILS_RAMP_DESTINATIONS.find(
        (c) => c.chainrailsChain === d.crChain
      );
      if (dest) setCrDest(dest);
    } else if (d.chain) {
      setNetwork(d.chain as ChainId);
      setNetworkTouched(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const launch = loadPendingLaunch();
    if (!launch || launch.flow !== "buy") return;
    if (launch.amount) setAmount(launch.amount);
    if (launch.currency) {
      const code = launch.currency.toUpperCase();
      // Main or pinned currencies restore straight away; any other partner
      // currency (e.g. GBP from chat) waits for the country list below.
      if (isPaycrestFiat(code) || CHAINRAILS_EXTRA_FIAT.some((f) => f.code === code))
        restoreCurrency(code);
      else setPendingCurrency(code);
    }
    if (launch.token === "USDC" || launch.token === "USDT") {
      setToken(launch.token);
    }
    // Chain: a ChainRails chain enum (e.g. "MONAD_MAINNET") or a chain name.
    if (launch.chain) {
      const dest = CHAINRAILS_RAMP_DESTINATIONS.find(
        (d) => d.chainrailsChain === launch.chain
      );
      const resolved = dest ? null : resolveChain(launch.chain);
      if (dest) setCrDest(dest);
      else if (resolved) selectNetwork(resolved);
    }
    clearPendingLaunch();
  }, []);

  // Save compose inputs as they change so a refresh / back doesn't lose them.
  // The review step owns its own draft, so we don't overwrite it here.
  useEffect(() => {
    if (step === "review") return;
    storeComposeDraft("buy", {
      amount,
      currency,
      token,
      chain: network,
      crChain: crDest?.chainrailsChain,
      payCountry: payCountry ?? undefined,
    });
  }, [amount, currency, token, network, crDest, payCountry, step]);

  const refreshRate = async (draft: FlowDraft) => {
    const draftToken = draft.token ?? "USDC";
    const ur = await fetchPaycrestRate(draft.currency, draftToken, "buy");
    if (!ur) return;
    const lines = rateLines(draft.amount, draft.currency, draftToken, ur);
    const next: Quote = {
      ...draft.quote,
      to: { ...draft.quote.to, amount: lines.amount },
      rate: lines.rate,
    };
    setQuote(next);
    storeFlowDraft({ ...draft, quote: next });
    toast.success("Rate updated");
  };

  const buildDraft = (q: Quote, payout?: PayoutDetails): FlowDraft => ({
    flow: "buy",
    amount,
    currency,
    token,
    quote: q,
    label,
    payout,
  });

  const persistDraft = (q: Quote, payout?: PayoutDetails) => {
    storeFlowDraft(buildDraft(q, payout));
    // Push so the back button returns to the form, not out of the app.
    setStep("review", { push: true });
  };

  const toReview = async () => {
    setLoading(true);
    setError(null);
    const intent: IntentResponse = {
      action: "onramp",
      fromChain: null,
      fromToken: currency,
      fromAmount: amount,
      toChain: network,
      toToken: token,
      fiatCurrency: currency,
      recipient: null,
      needsClarification: false,
      clarificationQuestion: null,
      confidence: 1,
    };
    const r = await quoteFromIntent(intent);
    if (!r) {
      setLoading(false);
      return setError("Couldn't build a quote — try again.");
    }
    if ("error" in r) {
      setLoading(false);
      return setError(r.reason);
    }

    // Reuse the cached live rate; only hit the API if it hasn't loaded yet.
    const ur = unitRate ?? (await fetchPaycrestRate(currency, token, "buy"));
    if (ur) {
      const lines = rateLines(amount, currency, token, ur);
      r.to.amount = lines.amount;
      r.rate = lines.rate;
    }

    setLoading(false);
    setQuote(r);
    persistDraft(r, payoutDraft);
  };

  const leaveReview = () => {
    clearFlowDraft();
    patchUrl({ step: null });
    setQuote(null);
    setPayoutDraft(undefined);
  };

  const handleBack = () => {
    clearFlowDraft();
    patchUrl({ step: null });
    onBack();
  };

  if (!ready) return null;

  // Paycrest review. (ChainRails quotes skip this and go straight to the
  // order page — see the panel's onQuote below.)
  if (quote) {
    return (
      <BuyReview
        quote={quote}
        initialPayout={payoutDraft}
        onPayoutChange={(p) => {
          setPayoutDraft(p);
          storeFlowDraft(buildDraft(quote, p));
        }}
        onBack={leaveReview}
        onConfirm={(payout, destination, buyer) => {
          clearFlowDraft();
          clearComposeDraft("buy");
          patchUrl({ step: null });
          const exec = { ...quote.exec, payout, recipient: destination, buyer };
          onSubmit({ text: label, quote: { ...quote, exec } });
        }}
      />
    );
  }

  const pageHeader = (
    <>
      <FlowHeader
        title="Buy crypto"
        subtitle="Pay with local currency, receive USDC in your wallet."
      />
      <StepProgress steps={["Amount", "Review", "Pay"]} current={0} />
    </>
  );

  // Currency picker rows: Paycrest corridors first, then every other country
  // ChainRails sells to (one row per country).
  const popularCountries: CountryOption[] = PAYCREST_FIAT.map((c) => ({
    value: c,
    countryCode: FIAT_HOME_COUNTRY[c]?.countryCode ?? "",
    countryName: FIAT_HOME_COUNTRY[c]?.countryName ?? c,
    currencyCode: c,
    currencyName: FIAT_NAMES[c] ?? c,
  }));
  const otherCountries: CountryOption[] = buyCountries
    .filter((c) => !isPaycrestFiat(c.currency.code))
    .map((c) => ({
      value: `cr:${c.countryCode}`,
      countryCode: c.countryCode,
      countryName: c.name,
      currencyCode: c.currency.code,
      currencyName: c.currency.name,
    }));
  const selectedCountry =
    popularCountries.find((o) => o.value === currency) ?? popularCountries[0];

  // Receive chains, from the live token lists (useTokenSupport). ChainRails
  // only ever delivers USDC, so its chains need USDC there (Tron has none).
  // ChainRails-only currencies (payCountry) deliver through ChainRails too.
  const canReceiveOn = (id: ChainId, t: string) => {
    if (payCountry === null) return tokens.paycrest(id, t);
    const dest = chainrailsDestinationFor(id);
    return t === "USDC" && !!dest && tokens.chainrails(dest.chainrailsChain, t);
  };
  const chainOptions = [
    ...PAYCREST_CHAIN_IDS.filter((id) => canReceiveOn(id, token)).map((id) => {
      const name = getChain(id)?.name ?? id;
      return { value: id, label: name, logo: <ChainLogo id={id} label={name} size={28} /> };
    }),
    ...(token === "USDC"
      ? CHAINRAILS_RAMP_DESTINATIONS.filter((d) =>
          tokens.chainrails(d.chainrailsChain, "USDC")
        ).map((d) => ({
          value: `cr:${d.chainrailsChain}`,
          label: d.label,
          logo: <RampLogo chainrailsChain={d.chainrailsChain} label={d.label} size={28} />,
        }))
      : []),
  ];
  const chainName = crDest?.label ?? getChain(network)?.name ?? network;
  const pickChain = (v: string) => {
    if (!v.startsWith("cr:")) return selectNetwork(v as ChainId);
    const dest = CHAINRAILS_RAMP_DESTINATIONS.find(
      (d) => d.chainrailsChain === v.slice(3)
    );
    if (dest) setCrDest(dest);
  };
  const pickToken = (t: string) => {
    setToken(t as (typeof TOKENS)[number]);
    // ChainRails only delivers USDC — leave its chain if picking USDT.
    if (t === "USDT") setCrDest(null);
    // Move off a chain that doesn't carry this token.
    if (!canReceiveOn(network, t)) {
      const next = PAYCREST_CHAIN_IDS.find((id) => canReceiveOn(id, t));
      if (next) selectNetwork(next);
    }
  };

  const tokenChainPicker = (
    <div className="relative">
      <TokenChainPill
        token={token}
        chainName={chainName}
        tokenLogo={<TokenLogo symbol={token} size={28} />}
        chainLogo={
          crDest ? (
            <RampLogo chainrailsChain={crDest.chainrailsChain} label={crDest.label} size={10} />
          ) : (
            <ChainLogo id={network} label={chainName} size={10} />
          )
        }
        onClick={() => setChainOpen((v) => !v)}
      />
      <TokenChainPicker
        open={chainOpen}
        onClose={() => setChainOpen(false)}
        title="Receive on"
        hint="The chain your stablecoin lands on. Base, Arbitrum and Polygon have near-zero fees; Ethereum costs more to use afterwards."
        token={token}
        tokens={TOKENS}
        onTokenChange={pickToken}
        tokenLogo={(t) => <TokenLogo symbol={t} size={18} />}
        chains={chainOptions}
        value={crDest ? `cr:${crDest.chainrailsChain}` : network}
        onSelect={pickChain}
      />
    </div>
  );

  // ChainRails chain or ChainRails-only currency → ChainRails panel.
  if (panelDest) {
    return (
      <FlowPage mode="buy" onBack={handleBack}>
        {pageHeader}
        <ChainrailsBuyPanel
          destination={panelDest}
          amount={amount}
          onAmountChange={setAmount}
          countryCode={payCountry ?? undefined}
          onCountryChange={payCountry === null ? undefined : choosePanelCountry}
          onQuote={(q) => {
            // The panel already showed the amounts and took the address, so
            // skip the review screen and go straight to the order page.
            clearFlowDraft();
            clearComposeDraft("buy");
            patchUrl({ step: null });
            onSubmit({ text: `Buy ${q.to.amount} on ${q.to.label}`, quote: q });
          }}
          chainPicker={tokenChainPicker}
        />
      </FlowPage>
    );
  }

  // ----- Amount screen (same layout as Sell) ----------------------------
  return (
    <FlowPage mode="buy" onBack={handleBack}>
      {pageHeader}

      <AmountField
        id="buy-amount"
        label="You pay"
        value={amount}
        onChange={setAmount}
        pill={
          <div className="relative">
            <CurrencyPill
              countryCode={selectedCountry.countryCode}
              currencyCode={selectedCountry.currencyCode}
              countryName={selectedCountry.countryName}
              currencyName={selectedCountry.currencyName}
              onClick={() => setCurrencyOpen((v) => !v)}
            />
            <CurrencyPicker
              open={currencyOpen}
              onClose={() => setCurrencyOpen(false)}
              title="Pay with"
              value={selectedCountry.value}
              popular={popularCountries}
              all={otherCountries}
              storageKey="buy"
              onSelect={chooseCountry}
            />
          </div>
        }
      />

      <RateLine
        rate={
          unitRate
            ? { from: `1 ${token}`, to: `${formatNumber(unitRate)} ${currency}` }
            : null
        }
      />

      <AmountField
        id="buy-receive"
        label="You receive"
        readOnly
        prefix="≈"
        value={estimate !== null ? formatNumber(estimate) : ""}
        pill={tokenChainPicker}
      />

      {unitRate && estimate !== null && (
        <p className="mt-2 px-1 text-xs text-muted">
          Estimate · final rate locks when you create the order
        </p>
      )}

      {error && (
        <div className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <PrimaryButton
        disabled={!canContinue}
        loading={loading}
        onClick={toReview}
      >
        {loading ? (
          "Getting quote…"
        ) : canContinue ? (
          <>
            Continue <ArrowRight />
          </>
        ) : (
          "Enter an amount"
        )}
      </PrimaryButton>
    </FlowPage>
  );
}
