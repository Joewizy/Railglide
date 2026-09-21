"use client";

/**
 * CashoutFlow — guided fiat off-ramp (stablecoin → bank / mobile money).
 *
 * The plain-language version of an off-ramp: how much, paid out in which
 * currency. No tokens-vs-chains mental model up front — the source defaults
 * to the settlement chain. Produces the same Quote the NL path does and
 * hands off to the shared ReviewScreen (which collects the bank / mobile
 * money details and runs the connect → confirm → execute flow).
 */

import React, { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { getChain, resolveChain, type ChainId } from "@/config/network";
import {
  PAYCREST_SELL_CHAIN_IDS,
  PAYCREST_FIAT,
  paycrestNetworkSlug,
} from "@/rails/paycrest";
import {
  CHAINRAILS_OFFRAMP_ENABLED,
  CHAINRAILS_RAMP_DESTINATIONS,
  type RampDestination,
} from "@/rails/chainrails";
import { ChainrailsSellPanel } from "./ChainrailsSellPanel";
import {
  getTrackedRampOrder,
  type TrackedRampOrder,
} from "../chainrailsOrders";
import { usePaycrestNetwork } from "@/hooks/usePaycrestNetwork";
import { usePaycrestRate, useTokenBalance } from "@/hooks";
import { fetchPaycrestRate } from "@/lib/paycrestRate";
import {
  fiatOptionLabel,
  formatFiat,
  formatNumber,
  formatToken,
} from "@/utils";
import { PrefixedAmountInput } from "./PrefixedAmountInput";
import {
  ReviewScreen,
  quoteFromIntent,
  type Intent,
  type IntentResponse,
  type PayoutDetails,
  type Quote,
} from "../SendScreen";
import { Icon } from "../icons";
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

const TOKENS = ["USDC", "USDT"] as const;

/** Flat source-chain picker: Paycrest chains first, ChainRails-only after. */
function SourceSelect({
  sourceChain,
  crDest,
  onSelect,
  style,
}: {
  sourceChain: ChainId;
  crDest: RampDestination | null;
  onSelect: (value: string) => void;
  style?: React.CSSProperties;
}) {
  const value = crDest ? `cr:${crDest.chainrailsChain}` : sourceChain;
  return (
    <span
      style={{
        position: "relative",
        display: "block",
        width: "100%",
        flex: style?.flex,
      }}
    >
      <span
        style={{
          position: "absolute",
          left: 12,
          top: "50%",
          zIndex: 1,
          display: "inline-flex",
          transform: "translateY(-50%)",
          pointerEvents: "none",
        }}
      >
        {crDest ? (
          <RampLogo
            chainrailsChain={crDest.chainrailsChain}
            label={crDest.label}
          />
        ) : (
          <ChainLogo
            id={sourceChain}
            label={getChain(sourceChain)?.name ?? sourceChain}
          />
        )}
      </span>
      <select
        value={value}
        onChange={(e) => onSelect(e.target.value)}
        style={{ ...style, paddingLeft: 42, flex: undefined }}
      >
        {PAYCREST_SELL_CHAIN_IDS.map((id) => (
          <option key={id} value={id}>
            {getChain(id)?.name ?? id}
          </option>
        ))}
        {/* ChainRails-only sell chains stay hidden until off-ramp KYB clears. */}
        {CHAINRAILS_OFFRAMP_ENABLED &&
          CHAINRAILS_RAMP_DESTINATIONS.map((d) => (
            <option key={d.chainrailsChain} value={`cr:${d.chainrailsChain}`}>
              {d.label}
            </option>
          ))}
      </select>
    </span>
  );
}

/** Quote lines (recipient amount + rate) derived from a unit rate. */
function rateLines(
  amount: string,
  currency: string,
  token: string,
  unitRate: number
) {
  return {
    amount: `≈ ${formatFiat(currency, (Number(amount) || 0) * unitRate)}`,
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

  // Live unit rate, fetched once per (currency, token) pair — we multiply it
  // locally as the user types so the Naira estimate updates with no extra API
  // calls. The exact rate locks when the order is created. Skipped on a
  // Chainrails source (that panel fetches its own rate).
  const { rate: unitRate } = usePaycrestRate(currency, token, !crDest);

  const amountNum = Number(amount) || 0;
  const estimate = unitRate && amountNum > 0 ? amountNum * unitRate : null;

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
    if (d.currency) setCurrency(d.currency);
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
    });
  }, [amount, currency, token, sourceChain, crDest, step, crOrderId]);

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
    if (launch.currency) setCurrency(launch.currency);
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

  const backButton = (
    <button
      className="btn btn-quiet btn-sm"
      onClick={onHeaderBack}
      style={{ padding: "0 8px", alignSelf: "flex-start", marginBottom: 4 }}
    >
      <Icon.Arrow rotate={180} size={12} /> Back
    </button>
  );
  const header = (
    <header className="col gap-1">
      {backButton}
      <h1
        style={{
          fontSize: 28,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          fontWeight: 500,
        }}
      >
        Sell
      </h1>
      <span className="muted" style={{ fontSize: 14 }}>
        Send stablecoins to a bank or mobile money account.
      </span>
    </header>
  );

  if (!ready) return null;

  // Non-Paycrest source → ChainRails off-ramp (manual deposit, dynamic banks).
  // The chain picker lives inside the panel so it stays one unified card.
  if (crDest) {
    return (
      <div className="col gap-6">
        {orderActive ? (
          <header className="col gap-1">{backButton}</header>
        ) : (
          header
        )}
        <ChainrailsSellPanel
          source={crDest}
          amount={amount}
          onAmountChange={setAmount}
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
          networkSelect={
            <SourceSelect
              sourceChain={sourceChain}
              crDest={crDest}
              onSelect={handleSourceSelect}
              style={{ ...INPUT, cursor: "pointer" }}
            />
          }
        />
      </div>
    );
  }

  if (quote) {
    return (
      <ReviewScreen
        quote={quote}
        text={label}
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
          const exec = {
            ...quote.exec,
            ...(payout ? { payout } : {}),
            ...(refundAddress ? { refundAddress } : {}),
          };
          onSubmit({ text: label, quote: { ...quote, exec } });
        }}
      />
    );
  }

  return (
    <div className="col gap-6">
      {header}

      <div className="card col gap-5" style={{ padding: 20 }}>
        <Field label="You sell">
          <div className="col gap-2">
            <div className="row center gap-2">
              <PrefixedAmountInput
                amount={amount}
                onAmountChange={setAmount}
                prefix="$"
              />
              <div className="row center gap-1" style={{ flex: "0 0 auto" }}>
                {TOKENS.map((t) => (
                  <button
                    key={t}
                    onClick={() => setToken(t)}
                    style={{
                      cursor: "pointer",
                      padding: "8px 14px",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 13,
                      fontWeight: 500,
                      lineHeight: 1.2,
                      borderRadius: 999,
                      border: "1px solid",
                      background:
                        token === t ? "var(--btn-bg)" : "var(--bg-elev)",
                      color: token === t ? "var(--btn-fg)" : "var(--fg-soft)",
                      borderColor:
                        token === t ? "var(--btn-bg)" : "var(--line-2)",
                    }}
                  >
                    <TokenLogo symbol={t} size={16} />
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Balance first — what they have, with Max right beside it. */}
            {balanceFloored !== undefined && (
              <div
                className="row between center gap-2"
                style={{ fontSize: 12.5, padding: "0 2px" }}
              >
                <span className="muted">
                  Balance on {getChain(sourceChain)?.name ?? sourceChain} ·{" "}
                  <span className="font-mono tabular">
                    {formatToken(balanceFloored, token, 2)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setAmount(String(balanceFloored))}
                  style={{
                    padding: "3px 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    background: "var(--bg-elev)",
                    border: "1px solid var(--line-2)",
                    borderRadius: 999,
                    color: "var(--accent)",
                    cursor: "pointer",
                  }}
                >
                  Max
                </button>
              </div>
            )}

            {/* One line: estimate + the rate that produced it, in parens. */}
            {unitRate && (
              <div
                className="row center gap-2"
                style={{ fontSize: 12.5, padding: "0 2px" }}
              >
                {estimate !== null && (
                  <span style={{ color: "var(--accent)", fontWeight: 500 }}>
                    ≈ {formatFiat(currency, estimate)}
                  </span>
                )}
                <span className="muted font-mono tabular">
                  {estimate !== null
                    ? `(1 ${token} = ${formatNumber(unitRate)} ${currency})`
                    : `1 ${token} = ${formatNumber(unitRate)} ${currency}`}
                </span>
              </div>
            )}

            {/* The figure above is an estimate at the live rate; Paycrest locks
                the real rate when the order is created, and the locked rate is
                shown on the funding screen before any crypto is sent. */}
            {unitRate && estimate !== null && (
              <span
                className="muted"
                style={{ fontSize: 11, padding: "0 2px", opacity: 0.85 }}
              >
                Estimate · final rate locks when you create the order
              </span>
            )}

            {overBalance && (
              <span
                style={{
                  fontSize: 12,
                  color: "var(--pend)",
                  padding: "0 2px",
                  lineHeight: 1.4,
                }}
              >
                That&apos;s more than this wallet holds — you can still continue
                and send from another wallet, or top up first.
              </span>
            )}
          </div>
        </Field>

        <label className="col gap-2">
          <span
            className="font-mono"
            style={{
              fontSize: 10,
              letterSpacing: 0.06,
              color: "var(--fg-mute)",
            }}
          >
            <span style={{ textTransform: "uppercase" }}>From</span> (The chain
            your USDC/USDT is on.)
          </span>
          <SourceSelect
            sourceChain={sourceChain}
            crDest={crDest}
            onSelect={handleSourceSelect}
            style={{ ...INPUT, cursor: "pointer" }}
          />
        </label>

        <Field label="Recipient gets paid in">
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            style={{ ...INPUT, cursor: "pointer" }}
          >
            {PAYCREST_FIAT.map((c) => (
              <option key={c} value={c}>
                {fiatOptionLabel(c)}
              </option>
            ))}
          </select>
        </Field>

        {error && (
          <div
            style={{
              padding: "12px 14px",
              background: "var(--err-soft)",
              border: "1px solid var(--err)",
              borderRadius: 10,
              fontSize: 13,
              color: "var(--fg-soft)",
            }}
          >
            {error}
          </div>
        )}

        <button
          className="btn btn-fat"
          disabled={!canContinue || loading}
          onClick={toReview}
          style={{
            background: canContinue ? "var(--btn-bg)" : "var(--bg-sunk)",
            color: canContinue ? "var(--btn-fg)" : "var(--fg-faint)",
            cursor: canContinue && !loading ? "pointer" : "default",
          }}
        >
          {loading ? (
            <>
              <Icon.Spinner size={14} /> Getting quote…
            </>
          ) : (
            <>
              Continue <Icon.ArrowRight />
            </>
          )}
        </button>
      </div>
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

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="col gap-2">
      <span
        className="font-mono"
        style={{
          fontSize: 10,
          letterSpacing: 0.06,
          color: "var(--fg-mute)",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
