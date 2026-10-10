// usePaycrestOnramp — fiat → stablecoin. Creates an order, shows virtual-account
// deposit instructions, then polls until USDC lands. No signature — the user
// transfers fiat externally.
//   idle → creating → awaiting_deposit → settling → complete (or error)
import { useCallback, useEffect, useRef, useState } from "react";
import { getChain, type ChainId } from "@railglide/shared/network";
import {
  ensureNotificationPermission,
  notifyOrderComplete,
} from "@/lib/notifications";
import {
  classifyPaycrestOrder,
  humanizePaycrestError,
  isPaycrestFiat,
  paycrestNetworkSlug,
  paycrestPayoutInFlight,
  type PaycrestFiat,
  type PaycrestOrder,
  type PaycrestRecipient,
  type PaycrestToken,
} from "@/rails/paycrest";
import type { BuyerDetails } from "@railglide/shared/kyc";
import { createOnrampOrder, getOrder } from "@/api/paycrest";

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
  /** Human decimal fiat amount. */
  amount: string;
  fiatCurrency: PaycrestFiat;
  refundAccount: PaycrestRecipient;
  /** Date of birth + NIN (or ID) — required on every Buy order. */
  buyer: BuyerDetails;
  recipientAddress: `0x${string}`;
  reference?: string;
}

export function usePaycrestOnramp() {
  const [status, setStatus] = useState<PaycrestOnrampStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<PaycrestOrder | null>(null);
  // The rate locks at creation, so there's nothing to watch until the user has
  // actually sent their fiat. Polling only starts once they confirm — this flag
  // avoids hammering the API through the whole (open-ended) awaiting window.
  const [depositSent, setDepositSent] = useState(false);

  // Details for the "buy complete" notification (token/chain aren't on the order
  // object) plus a guard so we notify at most once per order.
  const notifyRef = useRef<{ token?: PaycrestToken; chainName?: string }>({});
  const notifiedRef = useRef(false);

  const markSent = useCallback(() => setDepositSent(true), []);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setOrder(null);
    setDepositSent(false);
    notifiedRef.current = false;
  }, []);

  const onramp = useCallback(
    async (params: PaycrestOnrampParams): Promise<PaycrestOrder> => {
      const {
        toChain,
        token,
        amount,
        fiatCurrency,
        refundAccount,
        buyer,
        recipientAddress,
        reference,
      } = params;
      try {
        setError(null);
        setOrder(null);
        notifiedRef.current = false;
        notifyRef.current = { token, chainName: getChain(toChain)?.name };

        if (!isPaycrestFiat(fiatCurrency)) {
          throw new Error(`Unsupported fiat currency "${fiatCurrency}".`);
        }
        const network = paycrestNetworkSlug(toChain);
        if (!network) {
          throw new Error(
            `Buying isn't available on ${getChain(toChain)?.name ?? toChain} yet.`
          );
        }
        if (
          !refundAccount.institution ||
          !refundAccount.accountIdentifier ||
          !refundAccount.accountName
        ) {
          throw new Error("A refund account is required.");
        }

        setStatus("creating");
        const created = await createOnrampOrder({
          direction: "onramp",
          amount,
          amountIn: "fiat",
          fiatCurrency,
          refundAccount,
          buyer,
          token,
          network,
          recipientAddress,
          reference,
        });
        setOrder(created);
        if (!created.depositAccountIdentifier || !created.amountToTransfer) {
          throw new Error("We didn't get deposit instructions for this order.");
        }
        setStatus("awaiting_deposit");
        // Ask now so the banner can fire the moment the deposit is confirmed,
        // rather than surfacing the OS prompt at that (worse) moment.
        void ensureNotificationPermission();
        return created;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Buy failed.";
        setError(humanizePaycrestError(msg));
        setStatus("error");
        throw err instanceof Error ? err : new Error(msg);
      }
    },
    []
  );

  // Poll only after the user says they've paid (or once the provider is already
  // moving), and at a relaxed cadence — a fiat transfer takes minutes to land.
  // Adopt an existing order (from History) — fetch it and jump straight to the
  // right phase: deposit instructions if still open, settling if the provider
  // is moving, or a terminal state.
  const resume = useCallback(async (orderId: string): Promise<void> => {
    try {
      setError(null);
      setDepositSent(false);
      // We don't know the token/chain for a resumed order; a still-in-flight one
      // can still notify (with just the amount) once polling sees it settle.
      notifiedRef.current = false;
      notifyRef.current = {};
      setStatus("creating");
      const fetched = await getOrder(orderId);
      setOrder(fetched);
      const outcome = classifyPaycrestOrder(fetched, "onramp");
      if (outcome === "success") {
        // Already settled before we resumed — surfacing a "complete" banner for
        // an old order would be noise, so mark it handled without notifying.
        notifiedRef.current = true;
        setStatus("complete");
        return;
      }
      if (outcome === "failed") {
        setError(humanizePaycrestError("This order was refunded."));
        setStatus("error");
        return;
      }
      if (outcome === "expired") {
        setError(
          humanizePaycrestError(
            "This order expired before your payment arrived."
          )
        );
        setStatus("error");
        return;
      }
      setStatus(
        paycrestPayoutInFlight(fetched) ? "settling" : "awaiting_deposit"
      );
    } catch (err) {
      setError(
        humanizePaycrestError(
          err instanceof Error ? err.message : "Couldn't load this order."
        )
      );
      setStatus("error");
    }
  }, []);

  const isPolling =
    (depositSent && status === "awaiting_deposit") || status === "settling";
  useEffect(() => {
    if (!isPolling || !order?.id) return;
    const orderId = order.id;
    let stopped = false;

    const tick = async () => {
      try {
        const latest = await getOrder(orderId);
        if (stopped) return;
        setOrder(latest);
        if (paycrestPayoutInFlight(latest)) {
          setStatus((s) => (s === "awaiting_deposit" ? "settling" : s));
        }
        const outcome = classifyPaycrestOrder(latest, "onramp");
        if (outcome === "success") {
          setStatus("complete");
          if (!notifiedRef.current) {
            notifiedRef.current = true;
            void notifyOrderComplete({
              kind: "buy",
              amount: latest.amount,
              token: notifyRef.current.token,
              chainName: notifyRef.current.chainName,
            });
          }
        } else if (outcome === "failed" || outcome === "expired") {
          setError(
            humanizePaycrestError(
              outcome === "failed"
                ? "This order was refunded."
                : "This order expired before your payment arrived."
            )
          );
          setStatus("error");
        }
      } catch {
        // transient — keep polling
      }
    };

    void tick();
    const handle = setInterval(tick, 12000);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }, [isPolling, order?.id]);

  return {
    status,
    error,
    order,
    depositSent,
    isRunning:
      status !== "idle" && status !== "complete" && status !== "error",
    onramp,
    markSent,
    resume,
    reset,
  };
}
