"use client";

/**
 * Shared client-side poller for a single ChainRails ramp order — the twin of
 * paycrestPoll for the Chainrails routes.
 *
 * One loop per order id (opening the same order twice can't double-poll).
 *
 * Paying a ramp order happens elsewhere (provider checkout, KYC, a bank app or
 * wallet) and takes minutes, so checking fast is wasted. The loop:
 *   - checks every 30s for the first few ticks, then every 60s;
 *   - pauses while the tab is hidden or unfocused (the user is off paying),
 *     and checks once straight away when they come back;
 *   - stops at a terminal state or the attempt cap.
 * `waitFirst` skips the opening check (the user just left to pay); `fast`
 * checks every 5s, only for waiting on bank details we can't show yet.
 */

import {
  classifyRampStatus,
  isRampPhaseTerminal,
  type RampOrderPhase,
} from "@/rails/chainrails";

export interface RampPollHandle {
  stop: () => void;
}

export interface RampPollOptions<T extends { status?: string | null }> {
  /** Fresh order snapshot on every successful poll. */
  onUpdate: (order: T) => void;
  /** Fires once when the loop stops, with the final order + phase. */
  onSettled: (order: T | null, phase: RampOrderPhase) => void;
  /** Hard cap on requests before the order is treated as unresolved. */
  maxAttempts?: number;
  /** Don't check right away — the user has just gone off to pay. */
  waitFirst?: boolean;
  /** Check every 5s — only while waiting for payment details to appear. */
  fast?: boolean;
}

const FAST_INTERVAL_MS = 5_000;
const EARLY_INTERVAL_MS = 30_000;
const LATE_INTERVAL_MS = 60_000;
const EARLY_TICKS = 4; // 30s this many times (~2 min), then every 60s

/** One live poller per order id. */
const active = new Map<string, RampPollHandle>();

export function pollRampOrder<T extends { status?: string | null }>(
  orderId: string | number,
  {
    onUpdate,
    onSettled,
    maxAttempts = 120,
    waitFirst = false,
    fast = false,
  }: RampPollOptions<T>
): RampPollHandle {
  const key = String(orderId);
  const running = active.get(key);
  if (running) return running;

  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let requestInFlight = false;

  // Awake = tab visible AND window focused — polling while the user is off in
  // the provider's checkout tab would be pure waste.
  const isAwake = () => !document.hidden && (document.hasFocus?.() ?? true);

  // 30s ×4, then 60s. Fast mode: 5s.
  const nextDelay = () =>
    fast
      ? FAST_INTERVAL_MS
      : attempt < EARLY_TICKS
        ? EARLY_INTERVAL_MS
        : LATE_INTERVAL_MS;

  const schedule = () => {
    if (stopped || timer !== null || requestInFlight) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, nextDelay());
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    controller?.abort();
    document.removeEventListener("visibilitychange", onActivityChange);
    window.removeEventListener("focus", onActivityChange);
    window.removeEventListener("blur", onActivityChange);
    active.delete(key);
  };

  const settle = (order: T | null, phase: RampOrderPhase) => {
    stop();
    onSettled(order, phase);
  };

  async function tick() {
    if (stopped || requestInFlight) return;
    if (!isAwake()) return; // paused; onActivityChange resumes us on focus
    if (attempt >= maxAttempts) return settle(null, "unknown");
    attempt++;

    requestInFlight = true;
    const requestController = new AbortController();
    controller = requestController;
    let shouldReschedule = false;

    try {
      const res = await fetch(`/api/chainrails/ramp/orders/${key}`, {
        cache: "no-store",
        signal: requestController.signal,
      });
      if (!stopped) {
        if (!res.ok) {
          shouldReschedule = true;
        } else {
          const order = (await res.json()) as T | null;
          if (!stopped) {
            if (!order) {
              shouldReschedule = true;
            } else {
              onUpdate(order);

              const phase = classifyRampStatus(order.status);
              if (isRampPhaseTerminal(phase)) settle(order, phase);
              else shouldReschedule = true;
            }
          }
        }
      }
    } catch {
      // Aborted by stop(), or a transient network error — try again later.
      shouldReschedule = !stopped;
    } finally {
      requestInFlight = false;
      if (controller === requestController) controller = null;
    }

    if (shouldReschedule) schedule();
  }

  function onActivityChange() {
    if (stopped) return;
    if (isAwake()) {
      if (timer === null && !requestInFlight) void tick();
    } else if (timer !== null) {
      clearTimeout(timer); // left the tab — hold until we're back
      timer = null;
    }
  }

  const handle: RampPollHandle = { stop };
  active.set(key, handle);
  document.addEventListener("visibilitychange", onActivityChange);
  window.addEventListener("focus", onActivityChange);
  window.addEventListener("blur", onActivityChange);
  if (waitFirst) schedule();
  else void tick(); // check straight away
  return handle;
}
