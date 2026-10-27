"use client";

// AppScreens.tsx — History, Recipients, Settings screens

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useChainId, useSignMessage } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { signInWithEthereum } from "@/lib/siweClient";
import { fiatOptionLabel, formatFiat, titleCase } from "@/utils";
import { PAYCREST_FIAT, type PaycrestHistoryOrder } from "@/rails/paycrest";
import { formatToken } from "@/utils/format";
import { Icon } from "./icons";
import { PayoutForm, type PayoutDetails } from "./SendScreen";
import { upsertRecipient, useRecipients, type Recipient } from "./recipients";
import {
  loadTrackedRampOrders,
  type TrackedRampOrder,
} from "./chainrailsOrders";
import { loadSavedEmail } from "./rampEmail";
import { classifyRampStatus, type RampOrderPhase } from "@/rails/chainrails";

/* ────────────────── HISTORY ────────────────── */

/** One order from /api/paycrest/orders. */
export type Order = PaycrestHistoryOrder;

/** An order still awaiting its deposit can be resumed to fund or view it. */
export function isFundable(o: Order): boolean {
  if (o.direction === "offramp") {
    return o.status === "initiated" && !!o.receiveAddress;
  }
  return o.awaitingPayment && !!o.depositAccountIdentifier;
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Maps a Paycrest status to a chip tone + label. */
function statusChip(order: Order): {
  tone: "ok" | "pend" | "err";
  label: string;
} {
  if (order.awaitingPayment) return { tone: "pend", label: "Waiting for payment" };
  switch (order.status) {
    case "fulfilled":
    case "settled":
      return { tone: "ok", label: "Paid" };
    case "refunded":
      return { tone: "err", label: "Refunded" };
    case "expired":
      return { tone: "err", label: "Expired" };
    case "validated":
    case "processing":
      return { tone: "pend", label: "Processing" };
    case "pending":
      return { tone: "pend", label: "Confirming" };
    default:
      return { tone: "pend", label: "Awaiting funds" };
  }
}

function fiatLabel(currency: string | null, amount: number | null): string {
  if (amount === null || !currency) return "—";
  return formatFiat(currency, amount);
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function HistoryScreen({
  onResume,
  onResumeChainrails,
}: {
  /** Called when the user taps a still-fundable order to complete it. */
  onResume?: (order: Order) => void;
  /** Called when the user taps a Chainrails order to view it. */
  onResumeChainrails?: (order: TrackedRampOrder) => void;
}) {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { signMessageAsync } = useSignMessage();
  const chainId = useChainId();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // History is gated behind a SIWE session proving wallet ownership. When the
  // session is missing (or for a different wallet), we prompt the user to sign.
  const [needsAuth, setNeedsAuth] = useState(false);
  const [authing, setAuthing] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/paycrest/orders");
      if (res.status === 401) {
        setNeedsAuth(true);
        setOrders([]);
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
      // Session may belong to a previously-connected wallet; re-auth on mismatch.
      if (
        typeof data.address === "string" &&
        data.address.toLowerCase() !== address.toLowerCase()
      ) {
        setNeedsAuth(true);
        setOrders([]);
        return;
      }
      setNeedsAuth(false);
      setOrders(data.orders ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load orders.");
    } finally {
      setLoading(false);
    }
  }, [address]);

  const signIn = useCallback(async () => {
    if (!address) return;
    setAuthing(true);
    setError(null);
    try {
      await signInWithEthereum({ address, chainId, signMessageAsync });
      setNeedsAuth(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setAuthing(false);
    }
  }, [address, chainId, signMessageAsync, load]);

  useEffect(() => {
    if (isConnected && address) load();
    else {
      setOrders([]);
      setNeedsAuth(false);
    }
  }, [isConnected, address, load]);

  // Paycrest (signed-in wallet) and ChainRails (this browser / email) orders,
  // merged into one list, newest first.
  const rampHistory = useChainrailsHistory();
  const merged = [
    ...orders.map((order) => ({
      kind: "paycrest" as const,
      at: order.createdAt ? Date.parse(order.createdAt) : 0,
      order,
    })),
    ...rampHistory.orders.map((order) => ({
      kind: "chainrails" as const,
      at: order.createdAt,
      order,
    })),
  ].sort((a, b) => b.at - a.at);

  return (
    <div className="col gap-6">
      <header className="row between center wrap" style={{ gap: 12 }}>
        <div>
          <span className="eyebrow">Activity</span>
          <h1
            style={{
              fontSize: 30,
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
              marginTop: 6,
              fontWeight: 500,
            }}
          >
            History
          </h1>
          <span className="muted" style={{ fontSize: 14 }}>
            Your cash-out and on-ramp orders.
          </span>
        </div>
        {isConnected && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={load}
            disabled={loading}
          >
            {loading ? <Icon.Spinner size={12} /> : <Icon.Arrow size={12} />}{" "}
            Refresh
          </button>
        )}
      </header>

      {!isConnected ? (
        <EmptyState
          title="Connect your wallet"
          sub="Connect to see the orders tied to your address."
          action={
            <button
              className="btn btn-primary btn-sm"
              onClick={() => openConnectModal?.()}
            >
              Connect wallet
            </button>
          }
        />
      ) : needsAuth ? (
        <EmptyState
          title="Verify it's you"
          sub="Sign a quick message to prove you own this wallet and unlock your order history. It's free!"
          action={
            <button
              className="btn btn-primary btn-sm"
              onClick={signIn}
              disabled={authing}
            >
              {authing ? <Icon.Spinner size={12} /> : null} Sign in
            </button>
          }
        />
      ) : error ? (
        <EmptyState title="Couldn't load orders" sub={error} />
      ) : loading && orders.length === 0 && rampHistory.orders.length === 0 ? (
        <EmptyState title="Loading…" sub="Fetching your orders." />
      ) : null}

      {/* One list, newest first, whichever provider ran the order. */}
      {merged.length > 0 ? (
        <div className="col gap-3">
          {merged.map((item) =>
            item.kind === "paycrest" ? (
              <OrderCard key={item.order.id} order={item.order} onResume={onResume} />
            ) : (
              <ChainrailsOrderCard
                key={`cr-${item.order.id}`}
                order={item.order}
                phase={rampHistory.phases[item.order.id]}
                onResume={onResumeChainrails}
              />
            )
          )}
        </div>
      ) : (
        isConnected &&
        !needsAuth &&
        !error &&
        !loading && (
          <EmptyState
            title="No orders yet"
            sub="Your Buy and Sell orders will show up here."
          />
        )
      )}
    </div>
  );
}

/** Chip tone/label for a Chainrails ramp phase. */
function chainrailsChip(
  phase: RampOrderPhase | undefined,
  direction: "onramp" | "offramp"
): { tone: "ok" | "pend" | "err"; label: string } {
  switch (phase) {
    case "completed":
      return {
        tone: "ok",
        label: direction === "offramp" ? "Paid out" : "Received",
      };
    case "expired":
      return { tone: "err", label: "Expired" };
    case "failed":
      return { tone: "err", label: "Failed" };
    case "processing":
      return { tone: "pend", label: "Confirming" };
    case "pending":
      return { tone: "pend", label: "Awaiting payment" };
    default:
      return { tone: "pend", label: "Checking…" };
  }
}

/** A server order summary (GET /api/chainrails/orders) shaped for the card. */
type ServerRampOrder = {
  id: string | number;
  direction: "onramp" | "offramp" | null;
  fiatCurrency: string | null;
  fiatAmount: number | null;
  cryptoCurrency: string | null;
  cryptoAmount: number | null;
  createdAt: string | null;
};

function serverOrderToTracked(o: ServerRampOrder): TrackedRampOrder {
  return {
    id: String(o.id),
    direction: o.direction === "onramp" ? "onramp" : "offramp",
    chainLabel: "", // the store doesn't keep the display label
    cryptoLabel:
      o.cryptoAmount != null
        ? `${o.cryptoAmount} ${o.cryptoCurrency ?? "USDC"}`
        : (o.cryptoCurrency ?? "USDC"),
    fiatLabel:
      o.fiatAmount != null
        ? `${o.fiatAmount.toLocaleString()} ${o.fiatCurrency ?? ""}`.trim()
        : undefined,
    createdAt: o.createdAt ? Date.parse(o.createdAt) : Date.now(),
  };
}

/** Union by id — the local track has fuller labels, so it wins on overlap. */
function mergeRampOrders(
  local: TrackedRampOrder[],
  server: TrackedRampOrder[]
): TrackedRampOrder[] {
  const byId = new Map<string, TrackedRampOrder>();
  for (const o of server) byId.set(o.id, o);
  for (const o of local) byId.set(o.id, o);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Chainrails ramp orders (local track + server history), status re-fetched. */
/** ChainRails orders (this browser + server history by saved email) with live phases. */
function useChainrailsHistory() {
  const [orders, setOrders] = useState<TrackedRampOrder[]>([]);
  const [phases, setPhases] = useState<Record<string, RampOrderPhase>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const local = loadTrackedRampOrders();
      // Server-side history for this person (cross-device), keyed by saved email.
      let server: TrackedRampOrder[] = [];
      const email = loadSavedEmail();
      if (email) {
        try {
          const res = await fetch(
            `/api/chainrails/orders?email=${encodeURIComponent(email)}`
          );
          if (res.ok) {
            const data = await res.json();
            server = (Array.isArray(data?.orders) ? data.orders : []).map(
              serverOrderToTracked
            );
          }
        } catch {
          /* fall back to the local track */
        }
      }
      if (cancelled) return;

      const merged = mergeRampOrders(local, server);
      setOrders(merged);

      const entries = await Promise.all(
        merged.map(async (o): Promise<[string, RampOrderPhase]> => {
          try {
            const res = await fetch(`/api/chainrails/ramp/orders/${o.id}`, {
              cache: "no-store",
            });
            if (!res.ok) return [o.id, "unknown"];
            const data = await res.json();
            return [o.id, classifyRampStatus(data?.status)];
          } catch {
            return [o.id, "unknown"];
          }
        })
      );
      if (!cancelled) setPhases(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { orders, phases };
}

function ChainrailsOrderCard({
  order,
  phase,
  onResume,
}: {
  order: TrackedRampOrder;
  phase?: RampOrderPhase;
  onResume?: (order: TrackedRampOrder) => void;
}) {
  const chip = chainrailsChip(phase, order.direction);
  const isOfframp = order.direction === "offramp";
  // Both buys and sells re-open now: buys resume the checkout status screen,
  // sells reopen CashoutFlow's deposit screen (see resumeChainrailsOrder).
  const openable = !!onResume;
  return (
    <article
      className="card"
      onClick={openable ? () => onResume?.(order) : undefined}
      style={{ padding: 16, cursor: openable ? "pointer" : "default" }}
    >
      <div className="row between center" style={{ gap: 12 }}>
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 500 }}>
            {isOfframp ? "Sell" : "Buy crypto"} ·{" "}
            <span className="font-mono">{order.cryptoLabel}</span>
          </span>
          <span
            className="muted"
            style={{
              fontSize: 12.5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {order.chainLabel}
            {order.address ? ` · ${shortAddress(order.address)}` : ""}
          </span>
        </div>
        <span
          className={
            chip.tone === "ok"
              ? "chip chip-ok"
              : chip.tone === "pend"
                ? "chip chip-pend"
                : "chip chip-err"
          }
          style={{ padding: "2px 10px", flex: "0 0 auto" }}
        >
          {chip.label}
        </span>
      </div>

      <div className="hr" style={{ margin: "12px 0" }} />

      <div className="row between center" style={{ fontSize: 12.5 }}>
        <span className="font-mono" style={{ color: "var(--accent)" }}>
          {order.fiatLabel ?? "—"}
        </span>
        <span className="muted font-mono" style={{ fontSize: 11 }}>
          {timeAgo(new Date(order.createdAt).toISOString())} · #{order.id}
        </span>
      </div>

      {openable && (
        <div
          className="row center between"
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--line)",
          }}
        >
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              color: "var(--fg-soft)",
            }}
          >
            View order
          </span>
          <Icon.ArrowRight size={13} />
        </div>
      )}
    </article>
  );
}

function OrderCard({
  order,
  onResume,
}: {
  order: Order;
  onResume?: (order: Order) => void;
}) {
  const chip = statusChip(order);
  const isOfframp = order.direction === "offramp";
  const fundable = isFundable(order);
  const openable = !!onResume;
  const cryptoAmount = formatToken(order.amount, order.token, 2);
  return (
    <article
      className="card"
      onClick={openable ? () => onResume?.(order) : undefined}
      style={{
        padding: 16,
        cursor: openable ? "pointer" : "default",
        ...(fundable ? { borderColor: "var(--accent)" } : null),
      }}
    >
      <div className="row between center" style={{ gap: 12 }}>
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 500 }}>
            {isOfframp ? "Sell" : "Buy crypto"} ·{" "}
            <span className="font-mono">
              {cryptoAmount}
            </span>
          </span>
          <span
            className="muted"
            style={{
              fontSize: 12.5,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {isOfframp
              ? order.recipientName
                ? `${titleCase(order.recipientName)}${order.institution ? ` · ${order.institution}` : ""}${order.accountIdentifier ? ` · ${order.accountIdentifier}` : ""}`
                : order.network
              : order.recipientAddress
                ? `${titleCase(order.network)} · ${shortAddress(order.recipientAddress)}`
                : titleCase(order.network)}
          </span>
        </div>
        <span
          className={
            chip.tone === "ok"
              ? "chip chip-ok"
              : chip.tone === "pend"
                ? "chip chip-pend"
                : "chip chip-err"
          }
          style={{ padding: "2px 10px", flex: "0 0 auto" }}
        >
          {chip.label}
        </span>
      </div>

      <div className="hr" style={{ margin: "12px 0" }} />

      <div className="row between center" style={{ fontSize: 12.5 }}>
        <span className="font-mono" style={{ color: "var(--accent)" }}>
          {fiatLabel(order.currency, order.fiatAmount)}
          {order.rate ? (
            <span className="muted">
              {" "}
              · {order.rate}/{order.token}
            </span>
          ) : null}
        </span>
        <span className="muted font-mono" style={{ fontSize: 11 }}>
          {timeAgo(order.createdAt)}
        </span>
      </div>

      {openable && (
        <div
          className="row center between"
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--line)",
          }}
        >
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              color: fundable ? "var(--accent)" : "var(--fg-soft)",
            }}
          >
            {fundable
              ? isOfframp
                ? "Complete this transfer"
                : "Complete this purchase"
              : "View order"}
          </span>
          <Icon.ArrowRight size={13} />
        </div>
      )}
    </article>
  );
}

function EmptyState({
  title,
  sub,
  action,
}: {
  title: string;
  sub: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="card col center gap-2"
      style={{ padding: 40, textAlign: "center" }}
    >
      <span style={{ fontSize: 15, fontWeight: 500 }}>{title}</span>
      <span className="muted" style={{ fontSize: 13, maxWidth: "40ch" }}>
        {sub}
      </span>
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

/* ────────────────── RECIPIENTS ────────────────── */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function maskAccount(s: string): string {
  const t = s.trim();
  return t.length <= 4 ? t : `••${t.slice(-4)}`;
}

/**
 * Account number that reads as `••4020` until tapped. Tapping the digits reveals
 * the full number; the icon copies it. Masked by default so a glance over the
 * shoulder can't read the whole account.
 */
function AccountNumber({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const full = value.trim();

  const copy = () =>
    navigator.clipboard
      ?.writeText(full)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});

  return (
    <span className="row center" style={{ display: "inline-flex", gap: 5 }}>
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        aria-pressed={revealed}
        aria-label={revealed ? "Hide account number" : "Show account number"}
        title={revealed ? "Hide account number" : "Show full number"}
        className="font-mono transition-colors text-[var(--fg-mute)] hover:text-[var(--fg)]"
        style={{
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: "pointer",
          fontSize: 11.5,
          letterSpacing: revealed ? 0.4 : 1.2,
        }}
      >
        {revealed ? full : maskAccount(full)}
      </button>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy account number"
        title="Copy account number"
        className="transition-colors hover:text-[var(--fg)]"
        style={{
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: "pointer",
          color: copied ? "var(--accent)" : "var(--fg-mute)",
          display: "inline-flex",
          alignItems: "center",
        }}
      >
        {copied ? <Icon.Check size={11} /> : <Icon.Copy size={11} />}
      </button>
    </span>
  );
}

export function RecipientsScreen({
  onSend,
}: {
  onSend: (r: Recipient) => void;
}) {
  const { recipients, remove } = useRecipients();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? recipients.filter((r) =>
        [r.name, r.institutionName, r.accountIdentifier, r.currency].some((f) =>
          f.toLowerCase().includes(q)
        )
      )
    : recipients;

  return (
    <div className="col gap-6">
      <header className="row between center wrap" style={{ gap: 16 }}>
        <div>
          <span className="eyebrow">People &amp; places</span>
          <h1
            style={{
              fontSize: 30,
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
              marginTop: 6,
              fontWeight: 500,
            }}
          >
            Recipients
          </h1>
          <span className="muted" style={{ fontSize: 14 }}>
            Banks and mobile money you&apos;ve sent to before.
          </span>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setAdding(true)}
        >
          <Icon.Plus /> Add recipient
        </button>
      </header>

      {recipients.length > 0 && (
        <div
          className="row center"
          style={{
            padding: "10px 14px",
            border: "1px solid var(--line-2)",
            borderRadius: 10,
            background: "var(--bg-elev)",
            gap: 10,
          }}
        >
          <Icon.Search />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, number, or bank"
            style={{
              flex: 1,
              border: 0,
              outline: "none",
              background: "transparent",
              fontSize: 14,
              color: "var(--fg)",
            }}
          />
        </div>
      )}

      {recipients.length === 0 ? (
        <EmptyRecipients onAdd={() => setAdding(true)} />
      ) : filtered.length === 0 ? (
        <p className="muted" style={{ fontSize: 14 }}>
          No recipients match “{query}”.
        </p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 12,
          }}
        >
          {filtered.map((r) => (
            <RecipientCard
              key={r.id}
              r={r}
              onSend={() => onSend(r)}
              onRemove={() => remove(r.id)}
            />
          ))}
        </div>
      )}

      {adding && <AddRecipientModal onClose={() => setAdding(false)} />}
    </div>
  );
}

function RecipientCard({
  r,
  onSend,
  onRemove,
}: {
  r: Recipient;
  onSend: () => void;
  onRemove: () => void;
}) {
  return (
    <article className="card" style={{ padding: 16 }}>
      <div className="row center gap-3">
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: "var(--accent-soft)",
            color: "var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "Geist Mono, monospace",
            fontSize: 13,
            fontWeight: 600,
            flex: "0 0 auto",
          }}
        >
          {initialsOf(r.name)}
        </span>
        <div className="col grow" style={{ minWidth: 0 }}>
          <div className="row between center">
            <span
              style={{
                fontSize: 14,
                fontWeight: 500,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {titleCase(r.name)}
            </span>
            <span
              className="font-mono"
              style={{ fontSize: 10.5, color: "var(--fg-mute)" }}
            >
              {r.currency}
            </span>
          </div>
          <span
            className="font-mono row center"
            style={{ fontSize: 11.5, color: "var(--fg-mute)", gap: 5 }}
          >
            {r.institutionName} · <AccountNumber value={r.accountIdentifier} />
          </span>
        </div>
      </div>
      <div className="hr" style={{ margin: "12px 0" }} />
      <div className="row between center">
        <span
          className="font-mono"
          style={{ fontSize: 11, color: "var(--fg-mute)" }}
        >
          {r.lastSentAt
            ? `Last sent ${timeAgo(new Date(r.lastSentAt).toISOString())}`
            : `Added ${timeAgo(new Date(r.lastUsed).toISOString())}`}
        </span>
        <div className="row center gap-1">
          <button
            onClick={onRemove}
            title="Remove recipient"
            aria-label="Remove recipient"
            style={{
              background: "transparent",
              border: 0,
              padding: 6,
              cursor: "pointer",
              color: "var(--fg-mute)",
              display: "inline-flex",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
            >
              <path
                d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onSend}>
            Send
          </button>
        </div>
      </div>
    </article>
  );
}

function EmptyRecipients({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      className="card col center gap-3"
      style={{ padding: "40px 24px", textAlign: "center" }}
    >
      <span
        style={{
          width: 44,
          height: 44,
          borderRadius: 14,
          background: "var(--accent-soft)",
          color: "var(--accent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon.Book />
      </span>
      <div className="col gap-1">
        <span style={{ fontSize: 15, fontWeight: 500 }}>No recipients yet</span>
        <span className="muted" style={{ fontSize: 13 }}>
          Payout accounts are saved here automatically — or add one now.
        </span>
      </div>
      <button className="btn btn-primary btn-sm" onClick={onAdd}>
        <Icon.Plus /> Add recipient
      </button>
    </div>
  );
}

const REC_INPUT: React.CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  background: "var(--bg-soft)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  color: "var(--fg)",
  fontSize: 14,
  outline: "none",
};

const EMPTY_PAYOUT: PayoutDetails = {
  institution: "",
  institutionName: "",
  accountIdentifier: "",
  accountName: "",
};

const MONO_LABEL: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 0.06,
  color: "var(--fg-mute)",
  textTransform: "uppercase",
};

function AddRecipientModal({ onClose }: { onClose: () => void }) {
  const [currency, setCurrency] = useState<string>("NGN");
  const [payout, setPayout] = useState<PayoutDetails>(EMPTY_PAYOUT);
  const cardRef = useRef<HTMLDivElement>(null);

  const ready =
    !!payout.institution &&
    !!payout.accountIdentifier.trim() &&
    !!payout.accountName.trim();

  const save = () => {
    if (!ready) return;
    upsertRecipient(payout, currency);
    onClose();
  };

  // Esc to close, focus the first field on open, and trap Tab inside the modal.
  useEffect(() => {
    const node = cardRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const f = node.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    node?.querySelector<HTMLElement>("select, input, button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding:
          "max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))",
      }}
    >
      <div
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add recipient"
        className="card col"
        style={{
          width: "100%",
          maxWidth: 440,
          maxHeight: "calc(100dvh - 32px)",
          padding: 0,
          boxShadow:
            "0 16px 48px rgba(20,18,14,0.28), 0 4px 12px rgba(20,18,14,0.16)",
        }}
      >
        {/* sticky header */}
        <div
          className="col gap-1"
          style={{
            padding: "18px 20px 14px",
            borderBottom: "1px solid var(--line)",
            flex: "0 0 auto",
          }}
        >
          <div className="row between center">
            <h2 style={{ fontSize: 18, fontWeight: 500 }}>Add recipient</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "transparent",
                border: 0,
                color: "var(--fg-soft)",
                cursor: "pointer",
                padding: 4,
                display: "inline-flex",
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
          <span className="muted" style={{ fontSize: 13 }}>
            A bank or mobile money account to receive your payout.
          </span>
        </div>

        {/* scrollable body */}
        <div
          className="col gap-5"
          style={{ padding: 20, overflowY: "auto", flex: "1 1 auto" }}
        >
          <label className="col gap-2">
            <span className="font-mono" style={MONO_LABEL}>
              Currency
            </span>
            <select
              value={currency}
              onChange={(e) => {
                setCurrency(e.target.value);
                setPayout(EMPTY_PAYOUT); // institution codes are currency-specific
              }}
              style={{ ...REC_INPUT, cursor: "pointer" }}
            >
              {PAYCREST_FIAT.map((c) => (
                <option key={c} value={c}>
                  {fiatOptionLabel(c)}
                </option>
              ))}
            </select>
          </label>

          <div className="col gap-2">
            <span className="font-mono" style={MONO_LABEL}>
              Account details
            </span>
            <PayoutForm
              currency={currency}
              value={payout}
              onChange={setPayout}
              mode="payout"
              variant="embedded"
            />
          </div>
        </div>

        {/* sticky footer */}
        <div
          className="col gap-2"
          style={{
            padding: 20,
            borderTop: "1px solid var(--line)",
            flex: "0 0 auto",
          }}
        >
          <button
            className="btn btn-fat"
            disabled={!ready}
            onClick={save}
            style={{
              background: ready ? "var(--btn-bg)" : "var(--bg-sunk)",
              color: ready ? "var(--btn-fg)" : "var(--fg-faint)",
              cursor: ready ? "pointer" : "default",
            }}
          >
            Save recipient
          </button>
          {!ready && (
            <span
              className="muted"
              style={{ fontSize: 12, textAlign: "center" }}
            >
              Select a bank and enter the account number to save.
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
