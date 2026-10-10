import * as SecureStore from "expo-secure-store";
import type { BuyerDetails } from "@railglide/shared/kyc";

// Buyer details for Buy orders (date of birth, NIN or ID, phone). Paycrest
// needs them on every Buy, so we keep them in the device's secure storage
// (Keychain / Keystore) and refill the form next time. Never sent anywhere
// except with the order itself.
const KEY = "railglide.buyer-details";

export async function loadBuyerDetails(): Promise<BuyerDetails | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const parsed = raw ? (JSON.parse(raw) as BuyerDetails) : null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Merge with what's saved, so NGN details survive buying in another currency. */
export async function saveBuyerDetails(details: BuyerDetails): Promise<void> {
  try {
    const merged = { ...((await loadBuyerDetails()) ?? {}), ...details };
    await SecureStore.setItemAsync(KEY, JSON.stringify(merged));
  } catch {
    // Secure storage unavailable — they'll just be asked again next time.
  }
}

export async function clearBuyerDetails(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    /* nothing to clear */
  }
}
