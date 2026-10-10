"use client";

/**
 * usePaycrestOnramp — fiat on-ramp flow (bank / mobile money → stablecoin).
 *
 *   idle → creating → awaiting_deposit → settling → complete   (or → error)
 *
 * Creates an order via /api/paycrest/order, surfaces virtual-account deposit
 * instructions, then polls until USDC lands in the recipient wallet.
 * No wallet signature is required — the user transfers fiat externally.
 */

import { useCallback, useEffect, useState } from "react";
import {
  classifyPaycrestOrder,
  humanizePaycrestError,
  isPaycrestFiat,
  paycrestNetworkSlug,
  paycrestPayoutInFlight,
  type PaycrestFiat,
  type PaycrestOrder,
  type PaycrestRefundAccount,
  type PaycrestToken,
} from "@/rails/paycrest";
import type { BuyerDetails } from "@railglide/shared/kyc";
import { pollPaycrestOrder } from "@/lib/paycrestPoll";
import { trackOrder } from "@/lib/orderNotifications";
import { getChain, type ChainId } from "@/config/network";

export type PaycrestOnrampStatus =
  | "idle"
  | "creating"
  | "awaiting_deposit"
  | "settling"
  | "complete"
  | "error";

export interface PaycrestOnrampParams {
  toChain: ChainId;
  token: PaycrestToken;
  /** Human decimal amount — fiat or crypto per amountIn. */
  amount: string;
  amountIn?: "fiat" | "crypto";
  fiatCurrency: PaycrestFiat;
  refundAccount: PaycrestRefundAccount;
  /** Date of birth + NIN (or ID) — required on every Buy order. */
  buyer: BuyerDetails;
  recipientAddress: `0x${string}`;
  reference?: string;
}

export interface UsePaycrestOnrampReturn {
  status: PaycrestOnrampStatus;
  error: string | null;
  order: PaycrestOrder | null;
  isRunning: boolean;
  onramp: (params: PaycrestOnrampParams) => Promise<PaycrestOrder>;
  /** Adopt an existing order from History (view settled or finish in-flight). */
  resume: (params: { orderId: string }) => Promise<PaycrestOrder>;
  reset: () => void;
}

export function usePaycrestOnramp(): UsePaycrestOnrampReturn {
  const [status, setStatus] = useState<PaycrestOnrampStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<PaycrestOrder | null>(null);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setOrder(null);
  }, []);

  const onramp = useCallback(
    async (params: PaycrestOnrampParams): Promise<PaycrestOrder> => {
      const {
        toChain,
        token,
        amount,
        amountIn = "fiat",
        fiatCurrency,
        refundAccount,
        buyer,
        recipientAddress,
        reference,
      } = params;

      try {
        setError(null);
        setOrder(null);

        if (!isPaycrestFiat(fiatCurrency)) {
          throw new Error(`Unsupported fiat currency "${fiatCurrency}".`);
        }
        const network = paycrestNetworkSlug(toChain);
        if (!network) {
          throw new Error(
            `On-ramp isn't available on ${getChain(toChain)?.name ?? toChain} yet.`
          );
        }
        if (
          !refundAccount.institution ||
          !refundAccount.accountIdentifier ||
          !refundAccount.accountName
        ) {
          throw new Error(
            "Refund account institution, identifier and name are required."
          );
        }

        setStatus("creating");
        const created = await createOrder({
          direction: "onramp",
          amount,
          amountIn,
          fiatCurrency,
          refundAccount,
          buyer,
          token,
          network,
          recipientAddress,
          reference,
        });
        setOrder(created);
        trackOrder({ id: created.id, direction: "onramp", token, network });

        if (
          !created.depositAccountIdentifier ||
          !created.amountToTransfer
        ) {
          throw new Error(
            "We didn't get deposit instructions for this order."
          );
        }

        // The poll effect drives awaiting_deposit → settling → complete.
        setStatus("awaiting_deposit");
        return created;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "On-ramp failed.";
        setError(humanizePaycrestError(msg));
        setStatus("error");
        throw err instanceof Error ? err : new Error(msg);
      }
    },
    []
  );

  const resume = useCallback(async ({ orderId }: { orderId: string }) => {
    try {
      setError(null);
      setStatus("creating");
      const res = await fetch(`/api/paycrest/order/${orderId}`);
      const fetched = (await res.json()) as PaycrestOrder;
      if (!res.ok || !fetched?.id) {
        throw new Error("Couldn't load this order.");
      }
      setOrder(fetched);

      const outcome = classifyPaycrestOrder(fetched, "onramp");
      if (outcome === "success") {
        setStatus("complete");
        return fetched;
      }
      if (outcome === "failed") {
        throw new Error("This order was refunded.");
      }
      if (outcome === "expired") {
        throw new Error("This order expired before your payment arrived.");
      }
      setStatus(paycrestPayoutInFlight(fetched) ? "settling" : "awaiting_deposit");
      return fetched;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't resume order.";
      setError(humanizePaycrestError(msg));
      setStatus("error");
      throw err instanceof Error ? err : new Error(msg);
    }
  }, []);

  // One shared poller drives the screen from awaiting_deposit to complete.
  // It pauses while the tab is hidden and stops on any terminal state.
  const isPolling = status === "awaiting_deposit" || status === "settling";
  useEffect(() => {
    if (!isPolling || !order?.id) return;
    const handle = pollPaycrestOrder(order.id, {
      direction: "onramp",
      onUpdate: (next) => {
        setOrder(next);
        // First sign the provider is moving flips the timeline to settling.
        if (paycrestPayoutInFlight(next)) {
          setStatus((s) => (s === "awaiting_deposit" ? "settling" : s));
        }
      },
      onSettled: (settled, outcome) => {
        if (settled) setOrder(settled);
        if (outcome === "success") {
          setStatus("complete");
          return;
        }
        setError(humanizePaycrestError(onrampFailureMessage(outcome)));
        setStatus("error");
      },
    });
    return () => handle.stop();
  }, [isPolling, order?.id]);

  return {
    status,
    error,
    order,
    isRunning:
      status !== "idle" && status !== "complete" && status !== "error",
    onramp,
    resume,
    reset,
  };
}

interface CreateOnrampBody {
  direction: "onramp";
  amount: string;
  amountIn?: "fiat" | "crypto";
  fiatCurrency: PaycrestFiat;
  refundAccount: PaycrestRefundAccount;
  buyer: BuyerDetails;
  token: PaycrestToken;
  network: string;
  recipientAddress: `0x${string}`;
  reference?: string;
}

async function createOrder(body: CreateOnrampBody): Promise<PaycrestOrder> {
  const res = await fetch("/api/paycrest/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `Couldn't create this order (${res.status}).`);
  }
  return data as PaycrestOrder;
}

/** Maps a non-success poll outcome to a message the user can act on. */
function onrampFailureMessage(
  outcome: "failed" | "expired" | "timeout"
): string {
  if (outcome === "failed") return "This order was refunded.";
  if (outcome === "expired") {
    return "This order expired before your payment arrived.";
  }
  return (
    "On-ramp is taking longer than expected. If you already deposited, " +
    "check this order in History."
  );
}
