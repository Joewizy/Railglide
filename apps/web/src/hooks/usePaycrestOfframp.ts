"use client";

/**
 * usePaycrestOfframp — full fiat off-ramp flow (stablecoin → bank / mobile money).
 *
 * Drives the whole off-ramp from the connected wallet, advancing through a
 * status state machine the UI can render:
 *
 *   idle → creating → funding → settling → complete        (or → error)
 *
 * The model: Paycrest issues an order with a provider `receiveAddress`. We
 * create the order (server route holds the API key), send the stablecoin to
 * that address on-chain (the only signature the user makes), then poll the
 * order until the provider settles fiat to the recipient.
 *
 * Pairs with src/rails/paycrest.ts and the /api/paycrest/* routes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BaseError,
  UserRejectedRequestError,
  erc20Abi,
  getAddress,
  parseUnits,
} from "viem";
import { useAccount, useConfig } from "wagmi";
import { switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import {
  clearOrderSendTx,
  getOrderSendTxHash,
  saveOrderSendTx,
} from "@/lib/offrampSendCache";
import {
  classifyPaycrestOrder,
  humanizePaycrestError,
  isPaycrestFiat,
  paycrestNetworkSlug,
  type PaycrestFiat,
  type PaycrestOrder,
  type PaycrestRecipient,
  type PaycrestToken,
  paycrestAmountDue,
} from "@/rails/paycrest";
import { pollPaycrestOrder } from "@/lib/paycrestPoll";
import { trackOrder } from "@/lib/orderNotifications";
import { getChain, getToken, getTokenAddress, type ChainId } from "@/config/network";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** EVM address refunds return to if the order fails — also ties the order
   *  to a wallet for History. Need not be the connected wallet. */
  refundAddress: `0x${string}`;
  reference?: string;
}

export interface UsePaycrestOfframpReturn {
  status: PaycrestOfframpStatus;
  error: string | null;
  order: PaycrestOrder | null;
  /** Hash of the on-chain transfer that funded the provider's receive address. */
  transferTxHash: `0x${string}` | null;
  /** True while a run is mid-flight (not idle/complete/error). */
  isRunning: boolean;
  /** Step 1: create the order. Stops at `awaiting_funding` for user review. */
  offramp: (params: PaycrestOfframpParams) => Promise<PaycrestOrder>;
  /**
   * Step 2: send the stablecoin (wallet signature) once the user confirms.
   * Resolves when the transfer is mined; the poll effect then settles it.
   */
  fund: () => Promise<void>;
  /** Adopt an existing order (e.g. resumed from History) so it can be funded. */
  resume: (params: ResumeParams) => Promise<PaycrestOrder>;
  reset: () => void;
}

export interface ResumeParams {
  orderId: string;
  fromChain: ChainId;
  token: PaycrestToken;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * parseUnits that rounds UP when the amount has more decimals than the token
 * (Paycrest can return e.g. "50.399233931644239"), so a deposit is never a
 * hair short of what's due.
 */
function parseUnitsUp(amount: string, decimals: number): bigint {
  const [whole, fraction = ""] = amount.split(".");
  const kept = fraction.slice(0, decimals);
  const units = parseUnits(kept ? `${whole}.${kept}` : whole, decimals);
  return /[1-9]/.test(fraction.slice(decimals)) ? units + 1n : units;
}

export function usePaycrestOfframp(): UsePaycrestOfframpReturn {
  const config = useConfig();
  const { address, isConnected } = useAccount();

  const [status, setStatus] = useState<PaycrestOfframpStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<PaycrestOrder | null>(null);
  const [transferTxHash, setTransferTxHash] = useState<`0x${string}` | null>(
    null
  );

  // Funding context captured at order time, used when the user taps "Send".
  const fundingRef = useRef<{
    tokenAddress: `0x${string}`;
    receiveAddress: `0x${string}`;
    units: bigint;
    srcChainId: number;
    orderId: string;
  } | null>(null);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setOrder(null);
    setTransferTxHash(null);
    fundingRef.current = null;
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

        // --- validate ----------------------------------------------------
        // No wallet needed to create the order or send manually — only the
        // one-tap fund() (below) needs a connected wallet. We just need a
        // refund address, which the Review screen collects (prefilled from the
        // wallet when connected).
        if (!isPaycrestFiat(fiatCurrency)) {
          throw new Error(`Unsupported payout currency "${fiatCurrency}".`);
        }
        const network = paycrestNetworkSlug(fromChain);
        if (!network) {
          throw new Error(
            `Off-ramp isn't available from ${getChain(fromChain)?.name ?? fromChain} yet.`
          );
        }
        if (!recipient.institution || !recipient.accountIdentifier || !recipient.accountName) {
          throw new Error("Payout institution, account number and name are required.");
        }

        const srcEntry = getChain(fromChain);
        if (!srcEntry?.viemChain) {
          throw new Error("Off-ramp requires an EVM chain with a configured viem chain.");
        }
        const srcChainId = srcEntry.viemChain.id;

        const rawToken = getTokenAddress(token, fromChain);
        const decimals = getToken(token)?.decimals;
        if (!rawToken || decimals === undefined) {
          throw new Error(`No ${token} address configured for "${fromChain}".`);
        }
        // Normalise to a valid EIP-55 address regardless of how it's stored.
        const tokenAddress = getAddress(rawToken.toLowerCase());

        let units: bigint;
        try {
          units = parseUnits(amount, decimals);
        } catch {
          throw new Error(`Couldn't parse the amount "${amount}".`);
        }
        if (units <= 0n) {
          throw new Error("Amount must be greater than zero.");
        }

        // --- create the order (server proxies Paycrest) ------------------
        setStatus("creating");
        const created = await createOrder({
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
        trackOrder({ id: created.id, direction: "offramp", token, network });

        if (!created.receiveAddress) {
          throw new Error(
            "We didn't get a deposit address for this order."
          );
        }

        // Stash everything fund() needs; wait for explicit user action.
        // Send what Paycrest says is due (amount + fees), not the typed number.
        fundingRef.current = {
          tokenAddress,
          receiveAddress: getAddress(created.receiveAddress.toLowerCase()),
          units: parseUnitsUp(paycrestAmountDue(created), decimals),
          srcChainId,
          orderId: created.id,
        };
        setStatus("awaiting_funding");
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

  // --- Step 2: send the stablecoin once the user confirms the invoice ----
  const fund = useCallback(async (): Promise<void> => {
    const ctx = fundingRef.current;
    if (!ctx) {
      throw new Error("No order to fund — create the order first.");
    }
    try {
      setError(null);

      // Move the stablecoin to the provider's receive address.
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
      // Remember the deposit so a resumed order knows it's already funded,
      // even before Paycrest credits it (avoids a double-send prompt).
      saveOrderSendTx(ctx.orderId, transferHash);
      await waitForTransactionReceipt(config, {
        hash: transferHash,
        chainId: ctx.srcChainId,
      });

      // Stablecoin is on its way — hand off to the poll effect, which is
      // already running and will carry us to complete.
      setStatus("settling");
    } catch (err) {
      // User backed out in the wallet — not an error. Return them to the
      // invoice so they can send when ready; show nothing scary.
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

  // Adopt an existing order (resumed from History) and stop at the funding
  // step. Re-fetches the order so amount / address / status are fresh.
  const resume = useCallback(
    async ({ orderId, fromChain, token }: ResumeParams): Promise<PaycrestOrder> => {
      try {
        setError(null);
        setTransferTxHash(null);
        fundingRef.current = null;

        if (!isConnected || !address) {
          throw new Error("Connect a wallet first.");
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

        setStatus("creating");
        const res = await fetch(`/api/paycrest/order/${orderId}`);
        const fetched = (await res.json()) as PaycrestOrder;
        if (!res.ok || !fetched?.id) {
          throw new Error("Couldn't load this order.");
        }
        setOrder(fetched);
        // Restore funding tx hash for the explorer link only — phase comes
        // from Paycrest, not from whether we have a cached send.
        const priorTx = getOrderSendTxHash(orderId);
        if (priorTx) setTransferTxHash(priorTx as `0x${string}`);

        const outcome = classifyPaycrestOrder(fetched, "offramp");
        if (outcome === "failed" || outcome === "expired") {
          clearOrderSendTx(orderId);
        }
        if (outcome === "success") {
          setStatus("complete");
          return fetched;
        }
        if (!fetched.receiveAddress) {
          throw new Error("This order has no deposit address.");
        }
        fundingRef.current = {
          tokenAddress,
          receiveAddress: getAddress(fetched.receiveAddress.toLowerCase()),
          units: parseUnitsUp(paycrestAmountDue(fetched), decimals),
          srcChainId,
          orderId: fetched.id,
        };
        // awaiting_funding drives the funding panel; the poll effect picks
        // up terminal states (expired/refunded) from the live order.
        setStatus("awaiting_funding");
        return fetched;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Couldn't resume order.";
        setError(humanizePaycrestError(msg));
        setStatus("error");
        throw err instanceof Error ? err : new Error(msg);
      }
    },
    [address, isConnected]
  );

  // One shared poller covers the whole funding → settling lifecycle, so a
  // deposit from ANY source (the wallet button, another wallet, an exchange)
  // advances the screen. It pauses while the tab is hidden and stops on a
  // terminal state. Read-only — no signing, no order creation.
  const isPolling =
    status === "awaiting_funding" ||
    status === "funding" ||
    status === "settling";
  useEffect(() => {
    if (!isPolling || !order?.id) return;
    const orderId = order.id;
    const handle = pollPaycrestOrder(orderId, {
      direction: "offramp",
      onUpdate: (o) => setOrder(o),
      onSettled: (settled, outcome) => {
        if (settled) setOrder(settled);
        if (outcome === "success") {
          setStatus("complete");
          return;
        }
        if (outcome === "failed") clearOrderSendTx(orderId);
        // If the user already sent funds, surface the failure. Otherwise the
        // window simply closed — leave the screen up; StatusScreen renders
        // the expired/refunded phase from the order itself.
        if (getOrderSendTxHash(orderId)) {
          setError(
            humanizePaycrestError(
              outcome === "failed"
                ? "This order was refunded — funds are returning to your refund address."
                : "Payout is taking longer than expected. Check this order in History."
            )
          );
          setStatus("error");
        }
      },
    });
    return () => handle.stop();
  }, [isPolling, order?.id]);

  return {
    status,
    error,
    order,
    transferTxHash,
    isRunning:
      status !== "idle" && status !== "complete" && status !== "error",
    offramp,
    fund,
    resume,
    reset,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** True when the wallet error is the user declining the signature. */
export function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError) {
    return Boolean(err.walk((e) => e instanceof UserRejectedRequestError));
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /user rejected|user denied|denied transaction|user cancel/i.test(msg);
}

interface CreateOrderBody {
  direction: "offramp";
  amount: string;
  token: PaycrestToken;
  network: string;
  refundAddress: `0x${string}`;
  currency: PaycrestFiat;
  recipient: PaycrestRecipient;
  reference?: string;
}

async function createOrder(body: CreateOrderBody): Promise<PaycrestOrder> {
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


