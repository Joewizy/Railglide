"use client";

/**
 * Buy step 2 — review a Paycrest purchase, in the same layout as Sell's
 * recipient page. Collects where the USDC goes, the refund account
 * (BankAccountFields) and the buyer's details Paycrest needs on every Buy
 * order, then hands them to BuyFlow's onConfirm.
 */

import React, { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  checkBuyerDetails,
  trimBuyerDetails,
  type BuyerDetails,
} from "@railglide/shared/kyc";
import {
  clearBuyerDetails,
  loadBuyerDetails,
  saveBuyerDetails,
} from "@/lib/buyerDetails";
import { FIAT_NAMES, formatQuoteRate } from "@/utils";
import {
  isRecipientAddressValid,
  type PayoutDetails,
  type Quote,
} from "../SendScreen";
import { BuyerDetailsForm } from "../BuyerDetailsForm";
import {
  ArrowRight,
  FlowPage,
  PrimaryButton,
  StepProgress,
} from "../ui/sendKit";
import {
  BankAccountFields,
  EMPTY_ACCOUNT,
  accountBlocker,
  type LookupState,
} from "../ui/BankAccountFields";

export function BuyReview({
  quote,
  initialPayout,
  onPayoutChange,
  onBack,
  onConfirm,
}: {
  quote: Quote;
  initialPayout?: PayoutDetails;
  onPayoutChange?: (payout: PayoutDetails) => void;
  onBack: () => void;
  onConfirm: (
    refund: PayoutDetails,
    destination: string,
    buyer: BuyerDetails
  ) => void;
}) {
  const { address } = useAccount();
  const currency = quote.exec.fiatCurrency ?? "";
  const token = quote.exec.toToken ?? "USDC";

  // Where the USDC goes: prefilled with the connected wallet, always editable.
  const [destination, setDestination] = useState(address ?? "");
  useEffect(() => {
    if (address) setDestination((cur) => cur || address);
  }, [address]);
  const destinationValid = isRecipientAddressValid(
    destination,
    quote.exec.toChain
  );

  // Refund account (bank + number + looked-up name).
  const [refund, setRefundState] = useState<PayoutDetails>(
    initialPayout ?? EMPTY_ACCOUNT
  );
  const setRefund = (next: PayoutDetails) => {
    setRefundState(next);
    onPayoutChange?.(next);
  };
  const [lookup, setLookup] = useState<LookupState>("idle");

  // Buyer details, saved on this device after mount (no localStorage on SSR).
  const [buyer, setBuyer] = useState<BuyerDetails>({ birthDate: "" });
  const [rememberBuyer, setRememberBuyer] = useState(true);
  const [buyerSaved, setBuyerSaved] = useState(false);
  useEffect(() => {
    const saved = loadBuyerDetails();
    if (saved) {
      setBuyer(saved);
      setBuyerSaved(true);
    }
  }, []);
  const buyerProblems = checkBuyerDetails(currency, buyer);

  // The button says what's missing, in order.
  const blocker = !destinationValid
    ? "Enter your wallet address"
    : (accountBlocker(refund, lookup) ??
      (buyerProblems[0]?.replace(/\.$/, "") || null));

  const confirm = () => {
    const details = trimBuyerDetails(currency, buyer);
    if (rememberBuyer) saveBuyerDetails(details);
    onConfirm(
      {
        ...refund,
        accountIdentifier: refund.accountIdentifier.trim(),
        accountName: refund.accountName.trim(),
      },
      destination.trim(),
      details
    );
  };

  const rate = formatQuoteRate(quote.rate);

  const summary = (
    <div className="flex flex-col gap-3 rounded-card border border-edge bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] text-muted">You pay</span>
          <span className="whitespace-nowrap text-lg font-semibold tracking-[-0.01em] sm:text-[22px]">
            {quote.from.amount.toLocaleString()} {currency}
          </span>
          <span className="text-[13px] text-muted">
            {FIAT_NAMES[currency] ?? currency}
          </span>
        </div>
        <span className="flex-none text-muted">
          <ArrowRight />
        </span>
        <div className="flex min-w-0 flex-col items-end gap-0.5 text-right">
          <span className="text-[13px] text-muted">You receive</span>
          <span className="whitespace-nowrap text-lg font-semibold tracking-[-0.01em] sm:text-[22px]">
            {quote.to.amount}
          </span>
          <span className="text-[13px] text-muted">on {quote.to.label}</span>
        </div>
      </div>
      {rate && (
        <dl className="m-0 flex justify-between gap-3 border-t border-edge-soft pt-3 text-sm">
          <dt className="text-muted">Rate</dt>
          <dd className="m-0 font-medium">{rate}</dd>
        </dl>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-edge-soft pt-3 text-[13px] text-muted">
        <span>The rate locks on the next step and can move slightly.</span>
        <button
          type="button"
          onClick={onBack}
          className="flex-none font-semibold text-ink underline underline-offset-2"
        >
          Edit
        </button>
      </div>
    </div>
  );

  const form = (
    <div className="flex flex-col gap-4 rounded-card border border-edge bg-card px-5 py-4">
      {/* Where the USDC goes */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="buy-destination"
          className="text-[13px] font-medium text-muted"
        >
          Receive {token} to
        </label>
        <input
          id="buy-destination"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder={`Your ${quote.to.label} wallet address`}
          spellCheck={false}
          autoComplete="off"
          className="h-12 w-full rounded-[14px] border border-edge bg-card px-3.5 font-mono text-[13px] text-ink outline-none placeholder:text-muted focus:border-ink focus:shadow-[0_0_0_3px_rgba(23,23,26,0.08)]"
        />
        {destination.trim() && !destinationValid && (
          <span className="text-[13px] text-danger">
            That doesn&apos;t look like a valid {quote.to.label} address.
          </span>
        )}
      </div>

      {/* Refund account */}
      <div className="flex flex-col gap-0.5 border-t border-edge-soft pt-4">
        <h2 className="text-[15px] font-semibold">Refund account</h2>
        <p className="text-[13px] text-muted">
          This account will be used for any refunds. Use one in your name.
        </p>
      </div>
      <BankAccountFields
        id="refund"
        currency={currency}
        value={refund}
        onChange={setRefund}
        onLookupChange={setLookup}
        wrongLabel="Not yours?"
      />

      {/* Buyer details */}
      <div className="flex flex-col gap-0.5 border-t border-edge-soft pt-4">
        <h2 className="text-[15px] font-semibold">Your details</h2>
      </div>
      <BuyerDetailsForm
        currency={currency}
        value={buyer}
        onChange={setBuyer}
        remember={rememberBuyer}
        onRememberChange={(on) => {
          setRememberBuyer(on);
          if (!on) {
            clearBuyerDetails();
            setBuyerSaved(false);
          }
        }}
        saved={buyerSaved}
      />
    </div>
  );

  return (
    <FlowPage mode="buy" onBack={onBack} backLabel="Back to amount">
      <StepProgress steps={["Amount", "Review", "Pay"]} current={1} />
      <h1 className="mb-4 text-[26px] font-semibold tracking-[-0.02em]">
        Review your purchase
      </h1>
      {summary}
      <div className="h-4" />
      {form}
      <PrimaryButton disabled={!!blocker} onClick={confirm}>
        {blocker ?? (
          <>
            Continue to payment <ArrowRight />
          </>
        )}
      </PrimaryButton>
      <p className="mt-3 text-center text-[13px] leading-normal text-muted">
        You&apos;ll see the account to pay into next. Your {token} arrives once
        the payment clears.
      </p>
    </FlowPage>
  );
}
