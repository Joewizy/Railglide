"use client";

import { useEffect, useRef } from "react";
import toast from "react-hot-toast";
import {
  classifyRampStatus,
  isRampPhaseTerminal,
  type RampOrderPhase,
} from "@/rails/chainrails";
import {
  loadNotifiedRampIds,
  loadTrackedRampOrders,
  markRampNotified,
  type TrackedRampOrder,
} from "./chainrailsOrders";

/**
 * The ChainRails twin of useOrderNotifications: checks the ramp orders this
 * device created and toasts any that finished while the user was away — with
 * a "View" button that reopens the order. Runs on load and again whenever the
 * user comes back to the tab (they often pay in another tab and return), at
 * most once every 30s. Reads status live by id (no sign-in). Only recent,
 * not-yet-notified orders are considered, so old history never spams a toast.
 */
const RECENT_MS = 24 * 60 * 60 * 1000;
const RECHECK_GAP_MS = 30_000;

export function useRampOrderNotifications(
  onView: (order: TrackedRampOrder) => void
): void {
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  useEffect(() => {
    let cancelled = false;
    let checking = false;
    let lastCheck = 0;

    const checkFinishedOrders = async () => {
      if (checking || Date.now() - lastCheck < RECHECK_GAP_MS) return;
      const notified = loadNotifiedRampIds();
      const now = Date.now();
      const candidates = loadTrackedRampOrders().filter(
        (o) => !notified.has(o.id) && now - o.createdAt < RECENT_MS
      );
      if (!candidates.length) return;
      checking = true;
      lastCheck = now;
      for (const order of candidates) {
        if (cancelled) break;
        let phase: RampOrderPhase;
        try {
          const res = await fetch(`/api/chainrails/ramp/orders/${order.id}`, {
            cache: "no-store",
          });
          if (!res.ok) continue; // transient — try again next load
          const data = (await res.json()) as { status?: string } | null;
          phase = classifyRampStatus(data?.status);
        } catch {
          continue;
        }
        if (!isRampPhaseTerminal(phase)) continue; // still in flight
        // Unmounted mid-check: leave it un-notified so the next run toasts it.
        if (cancelled) break;

        markRampNotified(order.id);
        showToast(order, phase);
      }
      checking = false;
    };

    // Back on the tab (e.g. after paying in the provider's tab) → check again.
    const onReturn = () => {
      if (!document.hidden) void checkFinishedOrders();
    };

    void checkFinishedOrders();
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, []);

  function showToast(order: TrackedRampOrder, phase: RampOrderPhase) {
    const isBuy = order.direction === "onramp";
    const title =
      phase === "completed"
        ? isBuy
          ? "Buy complete"
          : "Payout complete"
        : phase === "expired"
          ? "Order expired"
          : "Order couldn't complete";
    const detail =
      phase === "completed"
        ? isBuy
          ? `Received ${order.cryptoLabel}`
          : `${order.fiatLabel ?? order.cryptoLabel} paid out`
        : `${order.cryptoLabel}${order.fiatLabel ? ` · ${order.fiatLabel}` : ""}`;
    const icon = phase === "completed" ? "✅" : "⚠️";

    toast(
      (t) => (
        <span className="row center gap-3">
          <span className="col" style={{ lineHeight: 1.3 }}>
            <strong style={{ fontSize: 13 }}>{title}</strong>
            <span style={{ fontSize: 12, color: "var(--fg-soft)" }}>
              {detail}
            </span>
          </span>
          <button
            className="btn btn-sm"
            style={{ whiteSpace: "nowrap" }}
            onClick={() => {
              onViewRef.current(order);
              toast.dismiss(t.id);
            }}
          >
            View
          </button>
        </span>
      ),
      { duration: 10000, icon }
    );
  }
}
