"use client";

/**
 * CashoutFlow — guided fiat off-ramp (stablecoin → bank / mobile money).
 *
 * The plain-language version of an off-ramp: how much, paid out in which
 * currency. No tokens-vs-chains mental model up front — the source defaults
 * to the settlement chain. Produces the same Quote the NL path does and
 * hands off to SellReview (which collects the bank / mobile money details)
 * and then the shared StatusScreen.
 */

import React, { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  DEFAULT_SETTLEMENT_CHAIN_ID,
  getChain,
  getTokenAddress,
  resolveChain,
  type ChainId,
} from "@/config/network";
import {
  PAYCREST_SELL_CHAIN_IDS,
  PAYCREST_FIAT,
  isPaycrestFiat,
  paycrestNetworkSlug,
} from "@/rails/paycrest";
import {
  CHAINRAILS_OFFRAMP_ENABLED,
  CHAINRAILS_RAMP_DESTINATIONS,
  chainrailsDestinationFor,
  type RampCountry,
  type RampDestination,
} from "@/rails/chainrails";
import { useRampCountries } from "@/hooks/useRampCountries";
import { useTokenSupport } from "@/hooks/useTokenSupport";
import { ChainrailsSellPanel } from "./ChainrailsSellPanel";
import { SellReview } from "./SellReview";
import { PAYCREST_SENDER_FEE_PERCENT, amountBeforeFee } from "@/config/fees";
import {
  getTrackedRampOrder,
  type TrackedRampOrder,
} from "../chainrailsOrders";
import { usePaycrestNetwork } from "@/hooks/usePaycrestNetwork";
import { usePaycrestRate, useTokenBalance } from "@/hooks";
import { fetchPaycrestRate } from "@/lib/paycrestRate";
import {
  FIAT_HOME_COUNTRY,
  FIAT_NAMES,
  formatFiat,
  formatNumber,
  formatToken,
} from "@/utils";
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
import {
  clearPendingRecipient,
  loadPendingRecipient,
  recipientToPayout,
} from "../recipients";
import { useSwapFlowNav } from "../useSwapFlowNav";
import { useSearchParams } from "next/navigation";
import { ChainLogo, RampLogo, TokenLogo } from "../Web3Logo";
import {
  AmountField,
  ArrowRight,
  BalanceAside,
  CurrencyPill,
  FlowHeader,
  FlowPage,
  Notice,
  PrimaryButton,
  RateLine,
  StepProgress,
  SummaryRows,
  TokenChainPill,
} from "../ui/sendKit";
import {
  CurrencyPicker,
  TokenChainPicker,
  type CountryOption,
} from "../ui/sendPickers";

const TOKENS = ["USDC", "USDT"] as const;

/** Quote lines (recipient amount + rate) derived from a unit rate. */
function rateLines(
  amount: string,
  currency: string,
  token: string,
  unitRate: number
) {
  return {
    amount: `≈ ${formatFiat(currency, amountBeforeFee(Number(amount) || 0) * unitRate)}`,
    rate: `${formatNumber(unitRate)} ${currency}/${token}`,
  };
}

export function CashoutFlow({
  onSubmit,
  onBack,
}: {
  onSubmit: (intent: Intent) => void;
  onBack: () => void;
}) {
  const { step, setStep, patchUrl } = useSwapFlowNav();
  const crOrderId = useSearchParams().get("crOrder");
  // Read once and shared below — two live loadPendingLaunch() calls race under
  // Strict Mode's double-invoke and can fall through to a stale saved draft.
  const pendingLaunchRef = useRef(loadPendingLaunch());
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<(typeof TOKENS)[number]>("USDC");
  const [currency, setCurrency] = useState<string>("NGN");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [payoutDraft, setPayoutDraft] = useState<PayoutDetails | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(step !== "review");
  // A chain the user named in chat ("on Polygon"), once resolved + supported.
  const [seedChain, setSeedChain] = useState<ChainId | undefined>();

  // Source chain: where the user's USDC is. An explicit pick (like Buy),
  // pre-selected to a chain named in chat, else the connected wallet's chain
  // when supported, else the default — and overridable. No wallet needed.
  const { chain: defaultSource } = usePaycrestNetwork(seedChain);
  const [sourceChain, setSourceChain] = useState<ChainId>(defaultSource);
  const [sourceTouched, setSourceTouched] = useState(false);
  // Non-Paycrest source → ChainRails off-ramp panel. Null on a Paycrest chain.
  const [crDest, setCrDest] = useState<RampDestination | null>(null);
  // Payout country picked from "More countries" (e.g. "MW"). Those currencies
  // go through ChainRails from the chosen chain. Null for Paycrest currencies.
  const [payCountry, setPayCountry] = useState<string | null>(null);
  // Countries ChainRails can pay out to whose currency Paycrest doesn't cover.
  const { countries: sellCountries } = useRampCountries("off-ramp");
  const moreCountries = CHAINRAILS_OFFRAMP_ENABLED
    ? sellCountries.filter((c) => !isPaycrestFiat(c.currency.code))
    : [];
  const payDest =
    payCountry === null
      ? null
      : (chainrailsDestinationFor(sourceChain) ??
        chainrailsDestinationFor(DEFAULT_SETTLEMENT_CHAIN_ID));
  const panelDest = crDest ?? payDest;

  // "Recipient gets paid in": Paycrest currencies use this form; "cr:MW"
  // style values (More countries) switch to the ChainRails panel.
  // A partner currency handed over from chat, picked once the list loads.
  const [pendingCurrency, setPendingCurrency] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingCurrency || !sellCountries.length) return;
    const c = sellCountries.find((x) => x.currency.code === pendingCurrency);
    if (c && CHAINRAILS_OFFRAMP_ENABLED) {
      setCurrency(c.currency.code);
      setPayCountry(c.countryCode);
    }
    setPendingCurrency(null);
  }, [pendingCurrency, sellCountries]);

  const choosePayCurrency = (value: string) => {
    if (!value.startsWith("cr:")) {
      setCurrency(value);
      setPayCountry(null);
      return;
    }
    const country = sellCountries.find((c) => c.countryCode === value.slice(3));
    if (!country) return;
    setCurrency(country.currency.code);
    setPayCountry(country.countryCode);
  };

  // Country changed inside the ChainRails panel. A Paycrest currency goes
  // back to the normal form.
  const choosePanelCountry = (country: RampCountry) => {
    setCurrency(country.currency.code);
    setPayCountry(
      isPaycrestFiat(country.currency.code) && !crDest
        ? null
        : country.countryCode
    );
  };
  useEffect(() => {
    if (!sourceTouched && !crDest) setSourceChain(defaultSource);
  }, [defaultSource, sourceTouched, crDest]);

  // Reopening a Sell order (crOrder in the URL, so refresh stays here): adopt its
  // chain and hand the id to the panel so it lands on the deposit screen instead
  // of a fresh quote form. Details come from tracked History, keyed by that id.
  const [resume, setResume] = useState<TrackedRampOrder | null>(null);
  // True once the panel is showing the order/deposit screen — we drop the "Sell"
  // page title then and let the status headline stand alone (like the Buy flow).
  // Seeded from the URL so a resumed order doesn't flash the full header first.
  const [orderActive, setOrderActive] = useState(!!crOrderId);
  useEffect(() => {
    if (!CHAINRAILS_OFFRAMP_ENABLED || !crOrderId) return;
    const tracked = getTrackedRampOrder(crOrderId);
    if (!tracked || tracked.direction !== "offramp") return;
    const dest = CHAINRAILS_RAMP_DESTINATIONS.find(
      (d) => d.label === tracked.chainLabel
    );
    if (!dest) return;
    setCrDest(dest);
    setSourceTouched(true);
    setResume(tracked);
  }, [crOrderId]);
  // Connected wallet's balance of the selected token on the chosen chain, so
  // the user can see what they have before getting a quote. Undefined until a
  // wallet is connected and the read resolves.
  const balance = useTokenBalance(token, sourceChain);
  // A chain is offered only when the provider that will run the sell supports
  // the token there (live list, see useTokenSupport) AND we have its address.
  // ChainRails-only currencies (payCountry) sell through ChainRails.
  const tokens = useTokenSupport();
  const canSellOn = (id: ChainId) => {
    if (!getTokenAddress(token, id)) return false;
    if (payCountry === null) return tokens.paycrest(id, token);
    const dest = chainrailsDestinationFor(id);
    return !!dest && tokens.chainrails(dest.chainrailsChain, token);
  };
  // Switching USDC ↔ USDT: if the current chain doesn't carry that token,
  // move to one that does (the picker only lists those).
  const sourceOk = crDest
    ? tokens.chainrails(crDest.chainrailsChain, token)
    : canSellOn(sourceChain);
  const firstOkChain = PAYCREST_SELL_CHAIN_IDS.find(canSellOn);
  useEffect(() => {
    if (sourceOk) return;
    if (crDest) setCrDest(null);
    else if (firstOkChain) setSourceChain(firstOkChain);
  }, [sourceOk, crDest, firstOkChain]);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);

  // Live unit rate, fetched once per (currency, token) pair — we multiply it
  // locally as the user types so the Naira estimate updates with no extra API
  // calls. The exact rate locks when the order is created. Skipped on a
  // Chainrails source (that panel fetches its own rate).
  const { rate: unitRate } = usePaycrestRate(currency, token, !panelDest);

  const amountNum = Number(amount) || 0;
  // The recipient gets the amount after our fee × rate (800 → 796.02 × rate).
  const estimate =
    unitRate && amountNum > 0 ? amountBeforeFee(amountNum) * unitRate : null;

  // Balance is informational, not a gate: orders can be funded from any wallet,
  // so an amount above the connected balance still proceeds (with a heads-up).
  // Floor to 2dp so the shown balance and the Max fill match exactly.
  const balanceNum =
    balance.formatted !== undefined ? Number(balance.formatted) : undefined;
  const balanceFloored =
    balanceNum !== undefined ? Math.floor(balanceNum * 100) / 100 : undefined;
  const overBalance = balanceNum !== undefined && amountNum > balanceNum;

  const canContinue = Number(amount) > 0;
  const label = `Sell ${amount} ${token} for ${currency}`;

  useEffect(() => {
    if (step !== "review") {
      setReady(true);
      return;
    }
    const draft = loadFlowDraft();
    if (draft?.flow === "cashout") {
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

  // Restore a half-filled Sell form after a refresh or a trip back to Home, so
  // nothing has to be retyped. Runs before the recipient / chat-launch effects
  // below (both of which clear themselves), so a deliberate "Send to X" or a
  // launch from chat still wins. Skipped while resuming a ChainRails order (that
  // path seeds its own chain) and on the review step (its draft owns that).
  useEffect(() => {
    if (step === "review" || crOrderId) return;
    if (pendingLaunchRef.current?.flow === "cashout" || loadPendingRecipient())
      return;
    const d = loadComposeDraft("cashout");
    if (!d) return;
    if (d.amount) setAmount(d.amount);
    // Skip currencies Paycrest has since dropped, unless saved with a
    // ChainRails country.
    if (d.currency && (isPaycrestFiat(d.currency) || d.payCountry)) {
      setCurrency(d.currency);
      if (d.payCountry !== undefined) setPayCountry(d.payCountry);
    }
    if (d.token === "USDC" || d.token === "USDT") setToken(d.token);
    // Only ever restore a Paycrest chain — Sell always opens on the default
    // settlement chain (Base) unless the user explicitly picked another Paycrest
    // one. A ChainRails chain is entered by choosing it in-session, never on open.
    if (d.chain) {
      setSourceChain(d.chain as ChainId);
      setSourceTouched(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save compose inputs as they change so a refresh / back doesn't lose them.
  // The review step owns its own draft, and a resumed order manages its own
  // chain, so we skip persisting in both cases.
  useEffect(() => {
    if (step === "review" || crOrderId) return;
    storeComposeDraft("cashout", {
      amount,
      currency,
      token,
      chain: sourceChain,
      crChain: crDest?.chainrailsChain,
      payCountry: payCountry ?? undefined,
    });
  }, [amount, currency, token, sourceChain, crDest, payCountry, step, crOrderId]);

  // Prefill from a recipient picked on the Recipients screen ("Send").
  useEffect(() => {
    const pending = loadPendingRecipient();
    if (!pending) return;
    setCurrency(pending.currency);
    setPayoutDraft(recipientToPayout(pending));
    clearPendingRecipient();
  }, []);

  // Seed fields from chat → cashout launch payload.
  useEffect(() => {
    const launch = pendingLaunchRef.current;
    if (!launch || launch.flow !== "cashout") return;
    if (launch.amount) setAmount(launch.amount);
    if (launch.currency) {
      const code = launch.currency.toUpperCase();
      // A partner currency (e.g. GHS from chat) waits for the country list.
      if (isPaycrestFiat(code)) setCurrency(code);
      else setPendingCurrency(code);
    }
    if (launch.token === "USDC" || launch.token === "USDT") {
      setToken(launch.token);
    }
    if (launch.chain) {
      const resolved = resolveChain(launch.chain);
      if (resolved && paycrestNetworkSlug(resolved)) setSeedChain(resolved);
    }
    if (launch.institution || launch.institutionName) {
      setPayoutDraft((prev) => ({
        institution: launch.institution ?? prev?.institution ?? "",
        institutionName: launch.institutionName ?? prev?.institutionName ?? "",
        accountIdentifier: prev?.accountIdentifier ?? "",
        accountName: prev?.accountName ?? "",
      }));
    }
    clearPendingLaunch();
  }, []);

  const refreshRate = async (draft: FlowDraft) => {
    const draftToken = draft.token ?? "USDC";
    const ur = await fetchPaycrestRate(draft.currency, draftToken);
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
    flow: "cashout",
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
      action: "offramp",
      fromChain: sourceChain,
      fromToken: token,
      fromAmount: amount,
      toChain: null,
      toToken: null,
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
    const ur = unitRate ?? (await fetchPaycrestRate(currency, token));
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

  // The ChainRails panel can step back through its own stages (KYC → payout →
  // amount). Give it first refusal on "Back" so a filled form isn't lost; only
  // leave the whole Sell flow when the panel has nothing left to undo.
  const panelBack = useRef<(() => boolean) | null>(null);
  const onHeaderBack = () => {
    if (panelBack.current?.()) return;
    handleBack();
  };

  const handleSourceSelect = (v: string) => {
    if (v.startsWith("cr:")) {
      const dest = CHAINRAILS_RAMP_DESTINATIONS.find(
        (d) => d.chainrailsChain === v.slice(3)
      );
      if (dest) setCrDest(dest);
      return;
    }
    setSourceTouched(true);
    setSourceChain(v as ChainId);
    setCrDest(null);
  };

  const sendSteps = ["Amount", "Recipient", "Send"];
  const pageHeader = (
    <>
      <FlowHeader
        title="Send money"
        subtitle="Pay a bank or mobile money account with your stablecoins."
      />
      <StepProgress steps={sendSteps} current={0} />
    </>
  );

  // Currency picker rows: Paycrest corridors first, then every country
  // ChainRails pays out to (one row per country, so XAF/XOF repeat).
  const popularCountries: CountryOption[] = PAYCREST_FIAT.map((c) => ({
    value: c,
    countryCode: FIAT_HOME_COUNTRY[c]?.countryCode ?? "",
    countryName: FIAT_HOME_COUNTRY[c]?.countryName ?? c,
    currencyCode: c,
    currencyName: FIAT_NAMES[c] ?? c,
  }));
  const otherCountries: CountryOption[] = moreCountries.map((c) => ({
    value: `cr:${c.countryCode}`,
    countryCode: c.countryCode,
    countryName: c.name,
    currencyCode: c.currency.code,
    currencyName: c.currency.name,
  }));
  const selectedCountry =
    popularCountries.find((o) => o.value === currency) ?? popularCountries[0];

  // Chains for the token/chain picker: Paycrest chains, then ChainRails-only
  // ones (hidden until off-ramp KYB clears).
  const chainOptions = [
    ...PAYCREST_SELL_CHAIN_IDS.filter(canSellOn).map((id) => {
      const name = getChain(id)?.name ?? id;
      return { value: id, label: name, logo: <ChainLogo id={id} label={name} size={28} /> };
    }),
    ...(CHAINRAILS_OFFRAMP_ENABLED
      ? CHAINRAILS_RAMP_DESTINATIONS.filter((d) =>
          tokens.chainrails(d.chainrailsChain, token)
        ).map((d) => ({
          value: `cr:${d.chainrailsChain}`,
          label: d.label,
          logo: <RampLogo chainrailsChain={d.chainrailsChain} label={d.label} size={28} />,
        }))
      : []),
  ];
  const chainValue = crDest ? `cr:${crDest.chainrailsChain}` : sourceChain;
  const chainName = crDest?.label ?? getChain(sourceChain)?.name ?? sourceChain;

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
            <ChainLogo id={sourceChain} label={chainName} size={10} />
          )
        }
        onClick={() => setChainOpen((v) => !v)}
      />
      <TokenChainPicker
        open={chainOpen}
        onClose={() => setChainOpen(false)}
        title="Send from"
        hint="Select the chain where you have the USDC/USDT you're going to use."
        token={token}
        tokens={TOKENS}
        onTokenChange={(t) => setToken(t as (typeof TOKENS)[number])}
        tokenLogo={(t) => <TokenLogo symbol={t} size={18} />}
        chains={chainOptions}
        value={chainValue}
        onSelect={handleSourceSelect}
      />
    </div>
  );

  if (!ready) return null;

  // Non-Paycrest source → ChainRails off-ramp (manual deposit, dynamic banks).
  // The chain picker lives inside the panel so it stays one unified card.
  if (panelDest) {
    return (
      <FlowPage mode="sell" onBack={onHeaderBack}>
        {!orderActive && pageHeader}
        <ChainrailsSellPanel
          source={panelDest}
          amount={amount}
          onAmountChange={setAmount}
          countryCode={payCountry ?? undefined}
          onCountryChange={payCountry === null ? undefined : choosePanelCountry}
          token={token}
          backRef={panelBack}
          resumeOrderId={resume?.id}
          resumeFiatLabel={resume?.fiatLabel}
          resumeDepositLabel={resume?.depositLabel}
          resumeCryptoLabel={resume?.cryptoLabel}
          onOrderActive={setOrderActive}
          onOrderCreated={(id) => patchUrl({ crOrder: id })}
          onStartNew={() => {
            setResume(null);
            setOrderActive(false);
            if (crOrderId) patchUrl({ crOrder: null });
          }}
          chainPicker={tokenChainPicker}
        />
      </FlowPage>
    );
  }

  if (quote) {
    return (
      <SellReview
        quote={quote}
        initialPayout={payoutDraft}
        onPayoutChange={(p) => {
          setPayoutDraft(p);
          storeFlowDraft(buildDraft(quote, p));
        }}
        onBack={leaveReview}
        onConfirm={(payout, refundAddress) => {
          clearFlowDraft();
          clearComposeDraft("cashout");
          patchUrl({ step: null });
          const exec = { ...quote.exec, payout, refundAddress };
          onSubmit({ text: label, quote: { ...quote, exec } });
        }}
      />
    );
  }

  // ----- Amount screen (design: Main, Mobile-Send, Mobile-Empty) ---------
  const amountConverted = amountNum > 0 ? amountBeforeFee(amountNum) : 0;
  const feeAmount = amountNum > 0 ? amountNum - amountConverted : 0;

  return (
    <FlowPage mode="sell" onBack={onHeaderBack}>
      {pageHeader}

      <AmountField
        id="sell-amount"
        label="You send"
        value={amount}
        onChange={setAmount}
        aside={
          balanceFloored !== undefined && (
            <BalanceAside
              balanceLabel={formatToken(balanceFloored, token, 2)}
              showMax={balanceFloored > 0}
              onMax={() => setAmount(String(balanceFloored))}
            />
          )
        }
        pill={tokenChainPicker}
      >
        {overBalance && (
          <p className="text-[13px] leading-snug text-warn-ink">
            More than this wallet holds. You can still continue and pay from
            another wallet.
          </p>
        )}
      </AmountField>

      <RateLine
        rate={
          unitRate
            ? { from: `1 ${token}`, to: `${formatNumber(unitRate)} ${currency}` }
            : null
        }
      />

      <AmountField
        id="sell-receive"
        label="They receive"
        readOnly
        prefix="≈"
        value={estimate !== null ? formatNumber(estimate) : ""}
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
              title="Recipient gets paid in"
              value={selectedCountry.value}
              popular={popularCountries}
              all={otherCountries}
              storageKey="sell"
              onSelect={(o) => choosePayCurrency(o.value)}
            />
          </div>
        }
      />

      {amountNum > 0 && (
        <>
          <SummaryRows
            className="mt-4"
            rows={[
              {
                label: `Fee (${PAYCREST_SENDER_FEE_PERCENT}%)`,
                value: formatToken(feeAmount, token, 2),
              },
              {
                label: "Amount converted",
                value: formatToken(amountConverted, token, 2),
              },
              {
                label: "Total from your wallet",
                value: formatToken(amountNum, token, 2),
                total: true,
              },
            ]}
          />
          {unitRate && (
            <p className="mt-2 px-1 text-xs text-muted">
              Estimate · final rate locks when you create the order
            </p>
          )}
        </>
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
            Continue to recipient <ArrowRight />
          </>
        ) : (
          "Enter an amount"
        )}
      </PrimaryButton>
    </FlowPage>
  );
}

