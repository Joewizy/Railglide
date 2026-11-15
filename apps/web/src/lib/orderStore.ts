/**
 * Server-owned Paycrest order store (Upstash Redis).
 *
 * Source of truth we control: the webhook and reconcile cron write order state
 * here so the app still knows an order settled after the user closes the tab.
 *
 * No-ops when Redis is unconfigured or failing — callers fall back to Paycrest.
 */
import { redis } from "@/lib/redis";
import {
  isPaycrestTerminalStatus,
  paycrestStatusRank,
  type PaycrestOrder,
  type PaycrestOrderStatus,
} from "@/rails/paycrest";

/** What we persist per order. The normalized `order` is already PII-light. */
export interface StoredPaycrestOrder {
  order: PaycrestOrder;
  /** Connected wallet this order belongs to (lowercased), when known. */
  walletAddress: string | null;
  /** Last webhook event that touched this record, e.g. "payment_order.settled". */
  event: string | null;
  /** When we last wrote this record (ISO). */
  updatedAt: string;
  /** When the order first reached a terminal state (ISO). */
  terminalAt?: string;
}

const ORDER_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const EVENT_TTL_SECONDS = 60 * 60 * 24 * 7; // covers Paycrest's 24h retry window

const orderKey = (id: string) => `paycrest:store:order:${id}`;
const walletIndexKey = (address: string) => `paycrest:store:wallet:${address.toLowerCase()}`;
const eventKey = (eventId: string) => `paycrest:store:event:${eventId}`;

// Non-terminal order ids the reconcile cron walks; pruned once an order settles.
const OPEN_ORDERS_KEY = "paycrest:store:open";

/** Claims an event id so a retried/duplicate webhook is processed once. */
export async function markWebhookEventSeen(eventId: string): Promise<boolean> {
  if (!redis) return true;
  try {
    const claim = await redis.set(eventKey(eventId), 1, {
      nx: true,
      ex: EVENT_TTL_SECONDS,
    });
    return claim !== null;
  } catch (err) {
    // Can't dedupe with Redis down — process anyway; the upsert is monotonic.
    console.error("[orderStore] event-dedupe failed", err);
    return true;
  }
}

/**
 * Releases an event-id claim so a later retry isn't dropped as a duplicate.
 * Called when persisting the order failed after the claim was taken.
 */
export async function releaseWebhookEvent(eventId: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(eventKey(eventId));
  } catch (err) {
    console.error("[orderStore] event-release failed", err);
  }
}

/**
 * Monotonic guard: never move an order backwards, never leave a terminal state.
 * Same-rank snapshots prefer the more recent one.
 */
function shouldReplace(prev: StoredPaycrestOrder, next: PaycrestOrder): boolean {
  const prevStatus = prev.order.status;
  const nextStatus = next.status;
  if (isPaycrestTerminalStatus(prevStatus) && !isPaycrestTerminalStatus(nextStatus)) {
    return false;
  }
  const prevRank = paycrestStatusRank(prevStatus);
  const nextRank = paycrestStatusRank(nextStatus);
  if (nextRank !== prevRank) return nextRank > prevRank;
  const prevAt = timeOf(prev.order.updatedAt ?? prev.updatedAt);
  const nextAt = timeOf(next.updatedAt);
  return nextAt >= prevAt;
}

/**
 * A webhook snapshot can carry fewer fields than the full order we saved when
 * it was created (e.g. no recipient wallet or deposit account). Take the new
 * values, but keep any old value the new snapshot is missing. An order never
 * changes direction, so the saved direction (and its currency) always wins.
 */
function mergeOrder(prev: PaycrestOrder | undefined, next: PaycrestOrder): PaycrestOrder {
  if (!prev) return next;
  const merged: Record<string, unknown> = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined && value !== null && value !== "") merged[key] = value;
  }
  merged.direction = prev.direction;
  if (prev.direction !== next.direction) merged.currency = prev.currency;
  return merged as unknown as PaycrestOrder;
}

function timeOf(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export interface UpsertResult {
  stored: StoredPaycrestOrder | null;
  /** True when this call advanced the record (new order or newer status). */
  changed: boolean;
  /** True when a configured store errored — the caller must not ack the event. */
  failed: boolean;
}

/**
 * Idempotent, monotonic upsert of an order snapshot. Safe to call from the
 * webhook and from any reconcile/read path with a fresher payload.
 */
export async function upsertStoredOrder(
  order: PaycrestOrder,
  meta: { walletAddress?: string | null; event?: string | null } = {}
): Promise<UpsertResult> {
  // Unconfigured store is a deliberate no-op (callers read live); not a failure.
  if (!redis) return { stored: null, changed: false, failed: false };

  try {
    const existing = await redis.get<StoredPaycrestOrder>(orderKey(order.id));
    if (existing && !shouldReplace(existing, order)) {
      return { stored: existing, changed: false, failed: false };
    }

    const nowIso = new Date().toISOString();
    const becameTerminal = isPaycrestTerminalStatus(order.status);
    const record: StoredPaycrestOrder = {
      order: mergeOrder(existing?.order, order),
      // The owner is set when the order is created; later events (webhooks)
      // can't change it — they only know the destination address.
      walletAddress: existing?.walletAddress ?? meta.walletAddress ?? null,
      event: meta.event ?? existing?.event ?? null,
      updatedAt: nowIso,
      terminalAt: becameTerminal
        ? (existing?.terminalAt ?? nowIso)
        : existing?.terminalAt,
    };

    await redis.set(orderKey(order.id), record, { ex: ORDER_TTL_SECONDS });

    if (becameTerminal) {
      await redis.srem(OPEN_ORDERS_KEY, order.id);
    } else {
      await redis.sadd(OPEN_ORDERS_KEY, order.id);
    }

    if (record.walletAddress) {
      const key = walletIndexKey(record.walletAddress);
      await redis.zadd(key, {
        score: timeOf(order.createdAt) || Date.now(),
        member: order.id,
      });
      await redis.expire(key, ORDER_TTL_SECONDS);
    }

    return { stored: record, changed: true, failed: false };
  } catch (err) {
    // Store outage: signal the caller so the webhook can 5xx and be retried
    // instead of acking an event we never persisted.
    console.error("[orderStore] upsert failed", err);
    return { stored: null, changed: false, failed: true };
  }
}

/** Non-terminal order ids for the reconcile cron to re-sync. */
export async function listOpenOrderIds(): Promise<string[]> {
  if (!redis) return [];
  try {
    return (await redis.smembers(OPEN_ORDERS_KEY)) ?? [];
  } catch (err) {
    console.error("[orderStore] listOpenOrderIds failed", err);
    return [];
  }
}

/** A stored order, or null when absent / unconfigured / erroring (caller reads live). */
export async function getStoredOrder(
  id: string
): Promise<StoredPaycrestOrder | null> {
  if (!redis) return null;
  try {
    return (await redis.get<StoredPaycrestOrder>(orderKey(id))) ?? null;
  } catch (err) {
    console.error("[orderStore] getStoredOrder failed", err);
    return null;
  }
}

/** Ids of the orders recorded for a wallet. Empty when the store is off or erroring. */
export async function listStoredOrderIdsByWallet(address: string): Promise<string[]> {
  if (!redis) return [];
  try {
    return (await redis.zrange<string[]>(walletIndexKey(address), 0, -1)) ?? [];
  } catch (err) {
    console.error("[orderStore] listStoredOrderIdsByWallet failed", err);
    return [];
  }
}

/** A wallet's stored orders, newest first; skips entries whose record expired. */
export async function listStoredOrdersByWallet(
  address: string
): Promise<StoredPaycrestOrder[]> {
  if (!redis) return [];
  try {
    const ids = await redis.zrange<string[]>(walletIndexKey(address), 0, -1, {
      rev: true,
    });
    if (!ids.length) return [];
    const records = await Promise.all(ids.map((id) => getStoredOrder(id)));
    return records.filter((r): r is StoredPaycrestOrder => r !== null);
  } catch (err) {
    console.error("[orderStore] listStoredOrdersByWallet failed", err);
    return [];
  }
}

/** Statuses we'd consider "still moving" — exported for reconcile callers. */
export function isStoredOrderTerminal(record: StoredPaycrestOrder): boolean {
  return isPaycrestTerminalStatus(record.order.status as PaycrestOrderStatus);
}
