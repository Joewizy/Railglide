// usePaycrestOfframp — stablecoin → fiat. Backend creates an order with a
// provider receiveAddress; the only signature is the on-chain transfer to it;
// then poll until settled.
//   idle → creating → awaiting_funding → funding → settling → complete (or error)
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BaseError,
  UserRejectedRequestError,
  erc20Abi,
  getAddress,
  parseUnits,
} from "viem";
import { useConfig } from "wagmi";
import {
  switchChain,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import {
  getChain,
  getToken,
  getTokenAddress,
  type ChainId,
} from "@railglide/shared/network";
import {
  chainIdFromPaycrestSlug,
  classifyPaycrestOrder,
  humanizePaycrestError,
  isPaycrestFiat,
  paycrestNetworkSlug,
  paycrestAmountDue,
  paycrestPayoutInFlight,
  type PaycrestFiat,
  type PaycrestOrder,
  type PaycrestRecipient,
  type PaycrestToken,
} from "@/rails/paycrest";
import { createOfframpOrder, getOrder } from "@/api/paycrest";
import {
  ensureNotificationPermission,
  notifyOrderComplete,
} from "@/lib/notifications";

export type PaycrestOfframpStatus =
  | "idle"
  | "creating"
  | "awaiting_funding"
  | "funding"
  | "settling"
  | "complete"
  | "error";

export interface PaycrestOfframpParams {
  fromChain: ChainId;
  token: PaycrestToken;
  /** Human decimal amount, e.g. "50". */
  amount: string;
  fiatCurrency: PaycrestFiat;
  recipient: PaycrestRecipient;
  /** EVM address refunds return to; ties the order to a wallet for History. */
  refundAddress: `0x${string}`;
  reference?: string;
}

/** True when the wallet error is the user declining the signature. */
/**
 * parseUnits that rounds UP when the amount has more decimals than the token,
 * so a deposit is never a hair short of what's due.
 */
function parseUnitsUp(amount: string, decimals: number): bigint {
  const [whole, fraction = ""] = amount.split(".");
  const kept = fraction.slice(0, decimals);
  const units = parseUnits(kept ? `${whole}.${kept}` : whole, decimals);
  return /[1-9]/.test(fraction.slice(decimals)) ? units + 1n : units;
}

export function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError) {
    return Boolean(err.walk((e) => e instanceof UserRejectedRequestError));
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /user rejected|user denied|denied transaction|user cancel/i.test(msg);
}

export function usePaycrestOfframp() {
  const config = useConfig();

  const [status, setStatus] = useState<PaycrestOfframpStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<PaycrestOrder | null>(null);
  const [transferTxHash, setTransferTxHash] = useState<`0x${string}` | null>(
    null
  );

  const fundingRef = useRef<{
    tokenAddress: `0x${string}`;
    receiveAddress: `0x${string}`;
    units: bigint;
    srcChainId: number;
    orderId: string;
  } | null>(null);
  const fundedRef = useRef(false);
  // Set when the user says they funded the order from an external wallet (not
  // via "Send from wallet"). Lets them opt into polling without us hammering the
  // API through the whole awaiting-funding window.
  const [manualCheck, setManualCheck] = useState(false);
  const markSent = useCallback(() => setManualCheck(true), []);
  // Whether "Send from wallet" can run — true only when we hold the funding
  // context from creating the order this session. A resumed order has no
  // context, so the user sends to the deposit address manually instead.
  const [fundable, setFundable] = useState(false);

  // Once-guard for the "sale complete" notification. The payout amount/currency
  // come straight off the settled order, so no other detail needs capturing.
  const notifiedRef = useRef(false);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setOrder(null);
    setTransferTxHash(null);
    setManualCheck(false);
    setFundable(false);
    fundingRef.current = null;
    fundedRef.current = false;
    notifiedRef.current = false;
  }, []);

  // --- Step 1: create the order, then wait for the user to confirm -------
  const offramp = useCallback(
    async (params: PaycrestOfframpParams): Promise<PaycrestOrder> => {
      const {
        fromChain,
        token,
        amount,
        fiatCurrency,
        recipient,
        refundAddress,
        reference,
      } = params;
      try {
        setError(null);
        setOrder(null);
        setTransferTxHash(null);
        fundingRef.current = null;
        fundedRef.current = false;
        notifiedRef.current = false;

        if (!isPaycrestFiat(fiatCurrency)) {
          throw new Error(`Unsupported payout currency "${fiatCurrency}".`);
        }
        const network = paycrestNetworkSlug(fromChain);
        if (!network) {
          throw new Error(
            `Off-ramp isn't available from ${getChain(fromChain)?.name ?? fromChain} yet.`
          );
        }
        if (
          !recipient.institution ||
          !recipient.accountIdentifier ||
          !recipient.accountName
        ) {
          throw new Error(
            "Payout institution, account number and name are required."
          );
        }

        const srcEntry = getChain(fromChain);
        if (!srcEntry?.viemChain) {
          throw new Error("Off-ramp requires an EVM chain.");
        }
        const srcChainId = srcEntry.viemChain.id;

        const rawToken = getTokenAddress(token, fromChain);
        const decimals = getToken(token)?.decimals;
        if (!rawToken || decimals === undefined) {
          throw new Error(`No ${token} address configured for "${fromChain}".`);
        }
        const tokenAddress = getAddress(rawToken.toLowerCase());

        let units: bigint;
        try {
          units = parseUnits(amount, decimals);
        } catch {
          throw new Error(`Couldn't parse the amount "${amount}".`);
        }
        if (units <= 0n) throw new Error("Amount must be greater than zero.");

        setStatus("creating");
        const created = await createOfframpOrder({
          direction: "offramp",
          amount,
          token,
          network,
          refundAddress,
          currency: fiatCurrency,
          recipient,
          reference,
        });
        setOrder(created);

        if (!created.receiveAddress) {
          throw new Error("We didn't get a deposit address for this order.");
        }
        // Send what Paycrest says is due (amount + fees), not the typed number.
        fundingRef.current = {
          tokenAddress,
          receiveAddress: getAddress(created.receiveAddress.toLowerCase()),
          units: parseUnitsUp(paycrestAmountDue(created), decimals),
          srcChainId,
          orderId: created.id,
        };
        setFundable(true);
        setStatus("awaiting_funding");
        // Ask now so the banner can fire the moment the payout settles, rather
        // than surfacing the OS prompt at that (worse) moment.
        void ensureNotificationPermission();
        return created;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Off-ramp failed.";
        setError(humanizePaycrestError(msg));
        setStatus("error");
        throw err instanceof Error ? err : new Error(msg);
      }
    },
    []
  );

  // --- Step 2: send the stablecoin once the user confirms ----------------
  const fund = useCallback(async (): Promise<void> => {
    const ctx = fundingRef.current;
    if (!ctx) throw new Error("No order to fund — create the order first.");
    try {
      setError(null);
      setStatus("funding");
      await switchChain(config, { chainId: ctx.srcChainId });
      const transferHash = await writeContract(config, {
        address: ctx.tokenAddress,
        abi: erc20Abi,
        functionName: "transfer",
        args: [ctx.receiveAddress, ctx.units],
        chainId: ctx.srcChainId,
      });
      setTransferTxHash(transferHash);
      fundedRef.current = true;
      await waitForTransactionReceipt(config, {
        hash: transferHash,
        chainId: ctx.srcChainId,
      });
      setStatus("settling");
    } catch (err) {
      if (isUserRejection(err)) {
        setStatus("awaiting_funding");
        throw err;
      }
      const msg = err instanceof Error ? err.message : "Transfer failed.";
      setError(humanizePaycrestError(msg));
      setStatus("error");
      throw err instanceof Error ? err : new Error(msg);
    }
  }, [config]);

  // Adopt an existing order (from History). Given the order's token + source
  // network we rebuild the wallet funding context so "Send from wallet" works on
  // a resumed order too; if we can't, the user sends to the deposit address
  // manually and taps "I've sent the payment".
  const resume = useCallback(
    async (
      orderId: string,
      opts?: { token?: PaycrestToken; network?: string }
    ): Promise<void> => {
      try {
        setError(null);
        setManualCheck(false);
        setFundable(false);
        setTransferTxHash(null);
        fundingRef.current = null;
        fundedRef.current = false;
        notifiedRef.current = false;
        setStatus("creating");
        const fetched = await getOrder(orderId);
        setOrder(fetched);
        const outcome = classifyPaycrestOrder(fetched, "offramp");
        if (outcome === "success") {
          // Already settled before we resumed — don't fire a stale banner.
          notifiedRef.current = true;
          setStatus("complete");
          return;
        }
        if (outcome === "failed") {
          setError(
            humanizePaycrestError(
              "This order was refunded — funds are returning to your refund address."
            )
          );
          setStatus("error");
          return;
        }
        if (outcome === "expired") {
          setError(
            humanizePaycrestError("This order expired. Start a new sale.")
          );
          setStatus("error");
          return;
        }

        // Rebuild the funding context so the user can fund from their wallet.
        const inFlight = paycrestPayoutInFlight(fetched);
        if (!inFlight && opts?.token && opts.network && fetched.receiveAddress) {
          const fromChain = chainIdFromPaycrestSlug(opts.network);
          const rawToken = fromChain
            ? getTokenAddress(opts.token, fromChain)
            : null;
          const decimals = getToken(opts.token)?.decimals;
          const srcChainId = fromChain
            ? getChain(fromChain)?.viemChain?.id
            : undefined;
          if (fromChain && rawToken && decimals !== undefined && srcChainId) {
            try {
              const units = parseUnitsUp(
                paycrestAmountDue(fetched),
                decimals
              );
              if (units > 0n) {
                fundingRef.current = {
                  tokenAddress: getAddress(rawToken.toLowerCase()),
                  receiveAddress: getAddress(
                    fetched.receiveAddress.toLowerCase()
                  ),
                  units,
                  srcChainId,
                  orderId: fetched.id,
                };
                setFundable(true);
              }
            } catch {
              // Fall back to manual send.
            }
          }
        }
        setStatus(inFlight ? "settling" : "awaiting_funding");
      } catch (err) {
        setError(
          humanizePaycrestError(
            err instanceof Error ? err.message : "Couldn't load this order."
          )
        );
        setStatus("error");
      }
    },
    []
  );

  // Poll only once funds are actually on the way: "Send from wallet" moves us to
  // funding/settling, or the user confirms an external transfer. No polling while
  // the order just sits at awaiting_funding — the rate is already locked.
  const isPolling =
    status === "funding" ||
    status === "settling" ||
    (manualCheck && status === "awaiting_funding");
  useEffect(() => {
    if (!isPolling || !order?.id) return;
    const orderId = order.id;
    let stopped = false;

    const tick = async () => {
      try {
        const latest = await getOrder(orderId);
        if (stopped) return;
        setOrder(latest);
        const outcome = classifyPaycrestOrder(latest, "offramp");
        if (outcome === "success") {
          setStatus("complete");
          if (!notifiedRef.current) {
            notifiedRef.current = true;
            const rate = Number(latest.rate);
            const payout =
              latest.rate && Number(latest.amount) > 0 && rate > 0
                ? (Number(latest.amount) * rate).toLocaleString("en-US", {
                    maximumFractionDigits: 2,
                  })
                : undefined;
            void notifyOrderComplete({
              kind: "sell",
              amount: payout,
              currency: latest.currency,
            });
          }
          return;
        }
        if (outcome === "failed" || outcome === "expired") {
          if (fundedRef.current) {
            setError(
              humanizePaycrestError(
                outcome === "failed"
                  ? "This order was refunded — funds are returning to your refund address."
                  : "Payout is taking longer than expected. Check this order in History."
              )
            );
            setStatus("error");
          }
          // If unfunded, the window just closed — leave the panel up.
        }
      } catch {
        // transient — keep polling
      }
    };

    void tick();
    const handle = setInterval(tick, 10000);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }, [isPolling, order?.id]);

  return {
    status,
    error,
    order,
    transferTxHash,
    manualCheck,
    fundable,
    isRunning:
      status !== "idle" && status !== "complete" && status !== "error",
    offramp,
    fund,
    markSent,
    resume,
    reset,
  };
}
