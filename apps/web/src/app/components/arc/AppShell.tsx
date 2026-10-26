"use client";

// AppShell.tsx — responsive shell + screen switcher
//
// Mobile-first: below ~860px the sidebar collapses into a hamburger drawer
// and the main column goes full-width; at desktop widths the sidebar is
// sticky. The Send experience starts at the Home goal chooser, which routes
// into the existing Send flow (per-goal guided flows land in Phase 2). The
// account chip is wired to wagmi; the connected address flows through to
// StatusScreen as the CCTP mint recipient.

import React, { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAccount, useDisconnect } from "wagmi";
import { useAccountModal, useConnectModal } from "@rainbow-me/rainbowkit";
import { Icon } from "./icons";
import { SendScreen, StatusScreen, type Intent } from "./SendScreen";
import { Home, type FlowId } from "./Home";
import { RelaySwapPanel } from "./RelaySwapPanel";
import { CashoutFlow } from "./flows/CashoutFlow";
import { BuyFlow } from "./flows/BuyFlow";
import { HistoryScreen, RecipientsScreen, type Order } from "./AppScreens";
import { type TrackedRampOrder } from "./chainrailsOrders";
import {
  DEFAULT_SETTLEMENT_CHAIN_ID,
  IS_TESTNET,
  getChain,
  type TokenSymbol,
} from "@/config/network";
import { chainIdFromPaycrestSlug } from "@/rails/paycrest";
import { formatFiat, formatToken, titleCase } from "@/utils";
import { resolveInstitutionHint } from "@/assistant/institutions";
import type { FlowLaunch } from "@/assistant/types";
import {
  clearChatState,
  clearFlowDraft,
  clearPendingLaunch,
  clearStoredIntent,
  loadStoredIntent,
  parseFlow,
  parseView,
  savePendingLaunch,
  storeIntent,
  type SwapView,
} from "./swapUrl";
import { useSwapFlowNav } from "./useSwapFlowNav";
import { useOrderNotifications } from "./useOrderNotifications";
import { useRampOrderNotifications } from "./useRampOrderNotifications";
import {
  matchRecipient,
  storePendingRecipient,
  upsertRecipient,
  type Recipient,
} from "./recipients";

type View = SwapView;

/** Reconstructs a minimal Intent from a History order so StatusScreen can
 *  adopt and fund it (resumeOrderId tells StatusScreen not to recreate it). */
function intentFromOrder(o: Order): Intent {
  const chain =
    chainIdFromPaycrestSlug(o.network) ?? DEFAULT_SETTLEMENT_CHAIN_ID;
  const chainName = getChain(chain)?.name ?? chain;
  const fiat = o.currency ?? "";
  const cryptoAmt = formatToken(o.amount, o.token, 2);

  if (o.direction === "onramp") {
    const fiatLabel =
      o.fiatAmount !== null && fiat ? formatFiat(fiat, o.fiatAmount) : fiat;
    const refundName = o.refundAccountName
      ? titleCase(o.refundAccountName)
      : "";
    return {
      text: `Buy ${cryptoAmt} ${o.token} with ${fiatLabel}`,
      resumeOrderId: o.id,
      quote: {
        from: {
          token: fiat,
          chain: chainName,
          amount: o.fiatAmount ?? 0,
        },
        to: {
          kind: "Wallet",
          currency: o.token,
          amount: `${cryptoAmt} ${o.token}`,
          label: chainName,
          sub: o.recipientAddress ?? "—",
        },
        rate: o.rate,
        fee: { network: "—", rail: "—", spread: "—", total: "—" },
        eta: "≈ 2 min",
        rail: ["Deposit", "Confirm", "Receive"],
        kind: "fiat",
        railName: "Fiat",
        railReason: "",
        exec: {
          rail: "paycrest",
          action: "onramp",
          fromChain: chain,
          fromToken: fiat as TokenSymbol,
          fromAmount: o.fiatAmount !== null ? String(o.fiatAmount) : o.amount,
          toChain: chain,
          toToken: o.token as TokenSymbol,
          fiatCurrency: fiat,
          recipient: o.recipientAddress,
          payout: {
            institution: o.refundInstitution ?? "",
            institutionName:
              o.refundInstitutionName ?? o.refundInstitution ?? "",
            accountIdentifier: o.refundAccountIdentifier ?? "",
            accountName: refundName,
          },
        },
      },
    };
  }

  const fiatGets =
    o.fiatAmount !== null && fiat
      ? formatFiat(fiat, o.fiatAmount)
      : `Paid out in ${fiat}`;
  const name = o.recipientName ? titleCase(o.recipientName) : "";
  return {
    text: `Sell ${cryptoAmt} ${o.token} for ${fiat}`,
    resumeOrderId: o.id,
    quote: {
      from: { token: o.token, chain: chainName, amount: Number(o.amount) },
      to: {
        kind: "Bank account",
        currency: fiat,
        amount: fiatGets,
        label: "Bank / mobile money",
        sub: o.accountIdentifier ?? "—",
      },
      rate: o.rate,
      fee: { network: "—", rail: "—", spread: "—", total: "—" },
      eta: "≈ 2 min",
      rail: ["Deposit", "Settle", "Payout"],
      kind: "fiat",
      railName: "Fiat",
      railReason: "",
      exec: {
        rail: "paycrest",
        action: "offramp",
        fromChain: chain,
        fromToken: o.token as TokenSymbol,
        fromAmount: o.amount,
        toChain: null,
        toToken: null,
        fiatCurrency: fiat,
        recipient: o.accountIdentifier,
        payout: {
          institution: o.institution ?? "",
          institutionName: o.institution ?? "",
          accountIdentifier: o.accountIdentifier ?? "",
          accountName: name,
        },
      },
    },
  };
}

/** Minimal Intent to re-open a tracked Chainrails buy so its status/checkout
 *  can be viewed. `resumeOrderId` tells ChainrailsStatus to poll, never create. */
function intentFromChainrailsOrder(o: TrackedRampOrder): Intent {
  return {
    text: `Buy ${o.cryptoLabel} on ${o.chainLabel}`,
    resumeOrderId: o.id,
    quote: {
      from: { token: "FIAT", chain: o.chainLabel, amount: 0 },
      to: {
        kind: "Wallet",
        currency: "USDC",
        amount: o.cryptoLabel,
        label: o.chainLabel,
        sub: o.address ?? "",
      },
      rate: null,
      fee: { network: "—", rail: "—", spread: "—", total: "—" },
      eta: "≈ 3–10 min",
      rail: [],
      kind: "fiat",
      railName: "Chainrails",
      railReason: "",
      exec: {
        rail: "chainrails",
        action: "onramp",
        fromChain: "ethereum",
        fromToken: "USDC" as TokenSymbol,
        fromAmount: "0",
        toChain: null,
        toToken: "USDC" as TokenSymbol,
        fiatCurrency: null,
        recipient: o.address ?? null,
        chainrailsRamp: {
          provider: "",
          countryCode: "",
          cryptoAmount: 0,
          destinationChain: "",
          destinationLabel: o.chainLabel,
          addressKind: "evm",
        },
      },
    },
  };
}

const MOBILE_QUERY = "(max-width: 860px)";

function useIsMobile(): boolean {
  // Default desktop so SSR + first paint match; correct on mount.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return isMobile;
}

export default function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { patchUrl } = useSwapFlowNav();
  const isMobile = useIsMobile();

  // Navigation is mirrored in the URL so refresh keeps the current screen.
  const view = parseView(searchParams.get("view"));
  const flow = parseFlow(searchParams.get("flow"));
  const showStatus = searchParams.get("status") === "1";

  const [recentIntent, setRecentIntent] = useState<Intent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Restore in-flight status after refresh (?status=1), or drop a stale param.
  useEffect(() => {
    if (!showStatus) {
      setRecentIntent(null);
      return;
    }
    const stored = loadStoredIntent();
    if (stored) setRecentIntent(stored);
    else patchUrl({ status: null });
  }, [showStatus, patchUrl]);

  const goToView = (v: View) => {
    clearStoredIntent();
    clearFlowDraft();
    patchUrl({ view: v, flow: null, status: null, step: null });
    setDrawerOpen(false);
  };

  const submit = (intent: Intent) => {
    clearFlowDraft();
    // Auto-capture the payout target as a recipient (deduped) so the address
    // book fills itself from real off-ramps.
    const { exec } = intent.quote;
    if (exec.action === "offramp" && exec.payout) {
      upsertRecipient(exec.payout, exec.fiatCurrency, true);
    }
    storeIntent(intent);
    setRecentIntent(intent);
    patchUrl({ view: "send", flow: null, status: true, step: null });
  };

  const sendToRecipient = (r: Recipient) => {
    storePendingRecipient(r);
    pickFlow("cashout");
    setDrawerOpen(false);
  };

  const resumeOrder = (order: Order) => {
    clearFlowDraft();
    const intent = intentFromOrder(order);
    storeIntent(intent);
    setRecentIntent(intent);
    patchUrl(
      { view: "send", flow: null, status: true, step: null },
      { push: true }
    );
    setDrawerOpen(false);
  };

  const resumeChainrailsOrder = (order: TrackedRampOrder) => {
    clearFlowDraft();
    // Sells live in CashoutFlow, not StatusScreen. The order id rides in the URL
    // (crOrder) so a refresh stays on the deposit screen; CashoutFlow looks the
    // rest up from tracked History.
    if (order.direction === "offramp") {
      patchUrl(
        {
          view: "send",
          flow: "cashout",
          status: null,
          step: null,
          crOrder: order.id,
        },
        { push: true }
      );
      setDrawerOpen(false);
      return;
    }
    const intent = intentFromChainrailsOrder(order);
    storeIntent(intent);
    setRecentIntent(intent);
    patchUrl(
      { view: "send", flow: null, status: true, step: null },
      { push: true }
    );
    setDrawerOpen(false);
  };

  // Toast orders that finished while the user was away; "View" reopens them.
  useOrderNotifications(resumeOrder);
  useRampOrderNotifications(resumeChainrailsOrder);

  const pickFlow = (id: FlowId | "describe") => {
    clearFlowDraft();
    // Push so the back button returns to the chooser, not out of the app.
    // crOrder: null so a fresh Sell never inherits a resumed order from the URL.
    patchUrl(
      { view: "send", flow: id, status: null, step: null, crOrder: null },
      { push: true }
    );
  };

  const launchFlow = async (launch: FlowLaunch) => {
    clearFlowDraft();
    clearPendingLaunch();

    const currency = launch.currency ?? "NGN";
    const matched = launch.recipientHint
      ? matchRecipient(launch.recipientHint, currency)
      : null;
    if (matched) storePendingRecipient(matched);

    // Resolve bank/mobile-money hint client-side (no PII to the LLM).
    let institution: string | undefined;
    let institutionName: string | undefined;
    if (launch.flow === "cashout" && launch.institutionHint) {
      const partial = await resolveInstitutionHint(
        currency,
        launch.institutionHint
      );
      if (partial) {
        institution = partial.institution;
        institutionName = partial.institutionName;
      }
    }

    savePendingLaunch({ ...launch, institution, institutionName });
    pickFlow(launch.flow);
    setDrawerOpen(false);
  };

  const backToChooser = () => {
    clearFlowDraft();
    patchUrl({ flow: null, step: null });
  };

  const finishStatus = () => {
    clearStoredIntent();
    clearFlowDraft();
    clearChatState();
    setRecentIntent(null);
    patchUrl({ status: null, step: null });
  };

  // Global "Back" chrome — step up ONE level instead of jumping to the landing
  // page. A status screen (often opened from History via a pushed URL) goes back
  // to wherever opened it; History/Recipients go to the app home; a sub-flow goes
  // to the chooser; only the bare home leaves the app to the landing page.
  const onBack = () => {
    if (showStatus) {
      router.back();
      return;
    }
    if (flow) {
      backToChooser();
      return;
    }
    if (view !== "send") {
      goToView("send");
      return;
    }
    router.push("/");
  };

  // Bridge/Swap uses the swap card; "describe" is the NL path; cash out /
  // buy are guided fiat flows. All converge on Review → StatusScreen.
  const flowBody = () => {
    switch (flow) {
      case "cashout":
        return <CashoutFlow onSubmit={submit} onBack={backToChooser} />;
      case "buy":
        return <BuyFlow onSubmit={submit} onBack={backToChooser} />;
      case "bridge":
        return (
          <WithBack onBack={backToChooser}>
            <RelaySwapPanel />
          </WithBack>
        );
      case "describe":
        return (
          <WithBack onBack={backToChooser}>
            <SendScreen onLaunch={launchFlow} />
          </WithBack>
        );
      default:
        return <Home onPick={pickFlow} />;
    }
  };

  const sendBody = showStatus ? (
    <StatusScreen
      intent={recentIntent}
      onDone={finishStatus}
      onStartNew={() => pickFlow("buy")}
      onBack={onBack}
    />
  ) : (
    flowBody()
  );

  const main = (
    <main
      style={{
        padding: isMobile
          ? "16px 16px 96px"
          : "28px clamp(20px, 3vw, 44px) 64px",
        maxWidth: 1100,
        width: "100%",
      }}
    >
      {/* Re-keyed per screen so each navigation fades in (respects
          prefers-reduced-motion via the global guard). */}
      <div
        key={`${view}|${flow}|${showStatus}`}
        style={{ animation: "fade-up .22s var(--ease) both" }}
      >
        {view === "send" && sendBody}
        {view === "history" && (
          <HistoryScreen
            onResume={resumeOrder}
            onResumeChainrails={resumeChainrailsOrder}
          />
        )}
        {view === "recipients" && <RecipientsScreen onSend={sendToRecipient} />}
      </div>
    </main>
  );

  // ---- mobile: top bar + slide-in drawer ----
  if (isMobile) {
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
        <MobileTopBar onMenu={() => setDrawerOpen(true)} onBack={onBack} />
        {main}
        {drawerOpen && (
          <div
            onClick={() => setDrawerOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.45)",
              zIndex: 40,
              animation: "fade-up .15s var(--ease) both",
            }}
          >
            <aside
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 264,
                maxWidth: "84vw",
                height: "100%",
                background: "var(--bg)",
                borderRight: "1px solid var(--line)",
                padding: "18px 16px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div className="row between center" style={{ marginBottom: 4 }}>
                <span
                  className="row center gap-2"
                  style={{ fontSize: 14, fontWeight: 500 }}
                >
                  <Icon.Logo size={20} /> Railglide
                </span>
                <button
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close menu"
                  style={{
                    background: "transparent",
                    border: 0,
                    color: "var(--fg-soft)",
                    cursor: "pointer",
                    padding: 4,
                  }}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M6 6l12 12M18 6L6 18"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
              <NavContent view={view} setView={goToView} />
            </aside>
          </div>
        )}
      </div>
    );
  }

  // ---- desktop: sticky sidebar grid ----
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "232px 1fr",
        minHeight: "100vh",
        background: "var(--bg)",
      }}
    >
      <aside
        style={{
          borderRight: "1px solid var(--line)",
          padding: "20px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          position: "sticky",
          top: 0,
          height: "100vh",
          background: "var(--bg)",
        }}
      >
        <button
          onClick={onBack}
          className="row center gap-2"
          style={{
            background: "transparent",
            border: 0,
            color: "var(--fg)",
            padding: "6px 4px",
            fontSize: 14,
            fontWeight: 500,
            marginBottom: 4,
          }}
        >
          <Icon.Logo size={20} /> <span>Railglide</span>
        </button>
        <NavContent view={view} setView={goToView} />
      </aside>
      {main}
    </div>
  );
}

function WithBack({
  onBack,
  children,
}: {
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="col gap-4">
      <button
        className="btn btn-quiet btn-sm"
        onClick={onBack}
        style={{ padding: "0 8px", alignSelf: "flex-start" }}
      >
        <Icon.Arrow rotate={180} size={12} /> Choose another
      </button>
      {children}
    </div>
  );
}

function MobileTopBar({
  onMenu,
  onBack,
}: {
  onMenu: () => void;
  onBack: () => void;
}) {
  return (
    <div
      className="row between center"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 30,
        padding: "12px 14px",
        background: "var(--bg)",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <button
        onClick={onMenu}
        aria-label="Open menu"
        style={{
          background: "transparent",
          border: 0,
          color: "var(--fg)",
          cursor: "pointer",
          padding: 6,
          display: "inline-flex",
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M3 6h18M3 12h18M3 18h18"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button
        onClick={onBack}
        className="row center gap-2"
        style={{
          background: "transparent",
          border: 0,
          color: "var(--fg)",
          fontSize: 14,
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        <Icon.Logo size={18} /> Railglide
      </button>
      <AccountChip compact />
    </div>
  );
}

function NavContent({
  view,
  setView,
}: {
  view: View;
  setView: (v: View) => void;
}) {
  const items: { id: View; label: string; icon: React.ReactNode }[] = [
    { id: "send", label: "Home", icon: <Icon.Send /> },
    { id: "history", label: "History", icon: <Icon.History /> },
    { id: "recipients", label: "Recipients", icon: <Icon.Book /> },
  ];
  return (
    <>
      <AccountChip />

      <div className="col gap-1">
        {items.map((it) => (
          <button
            key={it.id}
            onClick={() => setView(it.id)}
            className="row center gap-3"
            style={{
              background: view === it.id ? "var(--bg-soft)" : "transparent",
              border: 0,
              padding: "9px 12px",
              borderRadius: 10,
              color: view === it.id ? "var(--fg)" : "var(--fg-soft)",
              fontSize: 14,
              textAlign: "left",
              justifyContent: "flex-start",
              fontWeight: view === it.id ? 500 : 400,
            }}
          >
            {it.icon} {it.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      {/* Testnet-only warning chip. On mainnet it's just wasted space, so we
          drop it and keep the badge purely as a "you're on testnet" safety cue. */}
      {IS_TESTNET && (
        <div className="card row center between" style={{ padding: "10px 12px" }}>
          <span
            className="row center gap-2"
            style={{ fontSize: 12, color: "var(--fg-soft)" }}
          >
            <Icon.Globe size={12} /> Testnet
          </span>
        </div>
      )}
    </>
  );
}

function AccountChip({ compact }: { compact?: boolean }) {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();

  if (!isConnected || !address) {
    return (
      <button
        onClick={() => openConnectModal?.()}
        className="card row center between"
        style={{
          padding: compact ? "6px 10px" : "10px 12px",
          marginBottom: compact ? 0 : 8,
          cursor: "pointer",
          border: "1px solid var(--line)",
        }}
      >
        <span className="row center gap-2" style={{ fontSize: 13 }}>
          {!compact && (
            <span
              style={{
                width: 26,
                height: 26,
                borderRadius: "50%",
                background: "var(--bg-sunk)",
                border: "1px dashed var(--line-2)",
              }}
            />
          )}
          <span style={{ color: "var(--fg-soft)" }}>Connect</span>
        </span>
        {!compact && <Icon.ArrowRight size={11} />}
      </button>
    );
  }

  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;

  if (compact) {
    return (
      <button
        onClick={() => openAccountModal?.()}
        className="card row center gap-2"
        style={{ padding: "6px 10px", cursor: "pointer" }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "var(--accent)",
          }}
        />
        <span
          className="font-mono"
          style={{ fontSize: 11, color: "var(--fg)" }}
        >
          {short}
        </span>
      </button>
    );
  }

  return (
    <div
      className="card row center between"
      style={{ padding: "10px 12px", marginBottom: 8 }}
    >
      <button
        onClick={() => openAccountModal?.()}
        className="row center gap-2"
        style={{
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: "pointer",
          color: "inherit",
          textAlign: "left",
          flex: 1,
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: "var(--accent)",
          }}
        />
        <div className="col" style={{ lineHeight: 1.2 }}>
          <span
            className="font-mono"
            style={{ fontSize: 11.5, color: "var(--fg)" }}
          >
            {short}
          </span>
          <span className="row center gap-1" style={{ fontSize: 10 }}>
            <Icon.Dot size={6} color="var(--ok)" />
            <span style={{ color: "var(--ok)" }}>Connected</span>
          </span>
        </div>
      </button>
      <button
        onClick={() => disconnect()}
        title="Disconnect"
        style={{
          background: "transparent",
          border: 0,
          padding: 4,
          cursor: "pointer",
          color: "var(--fg-mute)",
        }}
      >
        <Icon.ChevDown size={11} />
      </button>
    </div>
  );
}
