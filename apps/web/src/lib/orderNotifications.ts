"use client";

import {
  paycrestAwaitingPayment,
  type PaycrestDirection,
  type PaycrestHistoryOrder,
  type PaycrestOrder,
} from "@/rails/paycrest";

/**
 * Per-device record of the fiat orders this browser created, so we can notify
 * the user when one finishes after they've left the order screen. We track by
 * order id (status is fetchable by id, no wallet auth needed) plus the bits the
 * by-id fetch doesn't carry for off-ramps (crypto token + network), so "View"
 * can reopen the exact order. No PII — bank details are never stored here.
 *
 * Cross-device is covered by History (the by-wallet, signed-in path); this is
 * just the "welcome back, your cashout landed" nudge on the device that made it.
 */

export interface TrackedOrder {
  id: string;
  direction: PaycrestDirection;
  /** Crypto token (USDC/USDT) — not in the by-id payload for off-ramps. */
  token: string;
  /** Paycrest network slug, e.g. "base" — also absent from the off-ramp payload. */
  network: string;
  /** When we started tracking (ms), for pruning. */
  ts: number;
  /** Set once we've shown the completion toast, so we don't repeat it. */
  notified?: boolean;
}

const KEY = "railglide:tracked-orders";

// Drop entries this old so the list can't grow forever (orders settle in
// minutes; a month is a generous ceiling for a "while you were away" toast).
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

function read(): TrackedOrder[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TrackedOrder[]) : [];
  } catch {
    return [];
  }
}

function write(list: TrackedOrder[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // localStorage unavailable / full — non-fatal, notifications are a nicety.
  }
}

/** Start tracking an order this device just created. Idempotent on id. */
export function trackOrder(entry: Omit<TrackedOrder, "ts" | "notified">): void {
  const list = read();
  if (list.some((o) => o.id === entry.id)) return;
  list.push({ ...entry, ts: Date.now() });
  write(list);
}

/** Orders we haven't yet shown a completion toast for. */
export function getPendingTrackedOrders(): TrackedOrder[] {
  return read().filter((o) => !o.notified);
}

/** Mark an order as notified so its toast isn't shown again. */
export function markTrackedNotified(id: string): void {
  const list = read();
  const next = list.map((o) => (o.id === id ? { ...o, notified: true } : o));
  write(next);
}

/** Stop tracking an order (e.g. it 404'd or is too old to matter). */
export function untrackOrder(id: string): void {
  write(read().filter((o) => o.id !== id));
}

/** Drop entries older than MAX_AGE_MS. Call on load. */
export function pruneTrackedOrders(): void {
  const now = Date.now();
  write(read().filter((o) => now - o.ts < MAX_AGE_MS));
}

/**
 * Rebuilds a History-shaped order from a tracked entry + the by-id snapshot, so
 * the existing resume path can reopen the exact order. The off-ramp payout
 * recipient (name / institution / account) rides along from the by-id payload
 * when present, so the reopened success card matches the live one; it's read
 * fresh here, never persisted to the device tracker.
 */
export function buildHistoryOrder(
  tracked: TrackedOrder,
  order: PaycrestOrder
): PaycrestHistoryOrder {
  const direction: PaycrestDirection = order.direction ?? tracked.direction;
  const fiatAmount =
    direction === "onramp" && order.amountToTransfer
      ? Number(order.amountToTransfer)
      : order.rate && order.amount
        ? Number(order.amount) * Number(order.rate)
        : null;
  return {
    id: order.id,
    direction,
    status: order.status,
    awaitingPayment: paycrestAwaitingPayment(order),
    amount: order.amount,
    token: tracked.token,
    network: tracked.network,
    rate: order.rate ?? null,
    currency:
      direction === "onramp"
        ? (order.depositCurrency ?? null)
        : order.currency || null,
    fiatAmount: Number.isFinite(fiatAmount as number) ? fiatAmount : null,
    recipientName: order.recipientName ?? null,
    institution: order.recipientInstitution ?? null,
    accountIdentifier: order.recipientAccountIdentifier ?? null,
    recipientAddress: order.recipientAddress ?? null,
    receiveAddress: order.receiveAddress ?? null,
    depositAccountIdentifier: order.depositAccountIdentifier ?? null,
    refundInstitution: null,
    refundInstitutionName: null,
    refundAccountIdentifier: null,
    refundAccountName: null,
    txHash: order.txHash ?? null,
    createdAt: order.createdAt ?? null,
  };
}
