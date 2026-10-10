"use client";

/**
 * Saves the buyer's Buy details (date of birth, NIN or ID, phone) in this
 * browser so they only type them once. Paycrest needs them on every Buy order.
 * They stay on this device; the server only passes them on to Paycrest.
 */

import type { BuyerDetails } from "@railglide/shared/kyc";

const KEY = "railglide:buyer-details";

export function loadBuyerDetails(): BuyerDetails | null {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as BuyerDetails) : null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Merge with what's saved, so NGN details survive buying in another currency. */
export function saveBuyerDetails(details: BuyerDetails): void {
  try {
    const merged = { ...(loadBuyerDetails() ?? {}), ...details };
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // Storage blocked — they'll just be asked again next time.
  }
}

export function clearBuyerDetails(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
