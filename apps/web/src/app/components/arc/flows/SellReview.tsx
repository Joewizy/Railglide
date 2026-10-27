"use client";

/**
 * Sell step 2 — "Who's getting the money?" (design: Review.dc.html).
 *
 * Collects the bank / mobile money account (BankAccountFields) and the refund
 * address for a Paycrest sell, then hands them to CashoutFlow's onConfirm.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { PAYCREST_SENDER_FEE_PERCENT, amountBeforeFee } from "@/config/fees";
import { FIAT_NAMES, formatQuoteRate, formatToken, titleCase } from "@/utils";
import type { PayoutDetails, Quote } from "../SendScreen";
import {
  loadRecipients,
  upsertRecipient,
  type Recipient,
} from "../recipients";
import {
  ArrowRight,
  FlowPage,
  PrimaryButton,
  StepProgress,
} from "../ui/sendKit";
import {
  BankAccountFields,
  BankTile,
  EMPTY_ACCOUNT,
  accountBlocker,
  type LookupState,
} from "../ui/BankAccountFields";
import { PickerSheet, type PickerGroup } from "../ui/PickerSheet";

export function SellReview({
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
  onConfirm: (payout: PayoutDetails, refundAddress: string) => void;
}) {
  const { address } = useAccount();
  const currency = quote.exec.fiatCurrency;
  const token = quote.from.token;

  const [payout, setPayoutState] = useState<PayoutDetails>(
    initialPayout ?? {
      ...EMPTY_ACCOUNT,
      accountIdentifier: quote.exec.recipient ?? "",
    }
  );
  const setPayout = (next: PayoutDetails) => {
    setPayoutState(next);
    onPayoutChange?.(next);
  };

  const [lookup, setLookup] = useState<LookupState>("idle");
  const [savedOpen, setSavedOpen] = useState(false);

  // Saved recipients for this currency (localStorage, so read after mount).
  const [saved, setSaved] = useState<Recipient[]>([]);
  useEffect(() => {
    setSaved(loadRecipients().filter((r) => r.currency === currency));
  }, [currency]);

  // Refund address: prefilled with the connected wallet.
  const [refund, setRefund] = useState(address ?? "");
  useEffect(() => {
    if (address) setRefund((cur) => cur || address);
  }, [address]);
  const refundValid = /^0x[0-9a-fA-F]{40}$/.test(refund.trim());

  const acct = payout.accountIdentifier.trim();
  const alreadySaved = saved.some(
    (r) => r.institution === payout.institution && r.accountIdentifier === acct
  );
  const [saveRecipient, setSaveRecipient] = useState(true);

  const name = payout.accountName.trim();
  const firstName = name ? titleCase(name).split(" ")[0] : "";

  // The button says what's missing, in order.
  const blocker =
    accountBlocker(payout, lookup) ??
    (!refundValid ? "Enter a refund address" : null);

  const confirm = () => {
    const final = { ...payout, accountIdentifier: acct, accountName: name };
    if (saveRecipient && !alreadySaved) upsertRecipient(final, currency);
    onConfirm(final, refund.trim());
  };

  const savedGroups = useMemo<PickerGroup[]>(
    () => [
      {
        label: "Saved",
        items: saved.map((r) => ({
          value: r.id,
          title: titleCase(r.accountName || r.name),
          subtitle: `${r.institutionName} · ${r.accountIdentifier}`,
          logo: <BankTile name={r.accountName || r.name} />,
        })),
      },
    ],
    [saved]
  );

  const amount = quote.from.amount;
  const converted = amountBeforeFee(amount);
  const fee = amount - converted;
  const rate = formatQuoteRate(quote.rate);

  const summary = (
    <div className="flex flex-col gap-3 rounded-card border border-edge bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] text-muted">You send</span>
          <span className="whitespace-nowrap text-lg font-semibold tracking-[-0.01em] sm:text-[22px]">
            {formatToken(amount, token, 2)}
          </span>
          <span className="text-[13px] text-muted">on {quote.from.chain}</span>
        </div>
        <span className="flex-none text-muted">
          <ArrowRight />
        </span>
        <div className="flex min-w-0 flex-col items-end gap-0.5 text-right">
          <span className="text-[13px] text-muted">Recipient gets</span>
          <span className="whitespace-nowrap text-lg font-semibold tracking-[-0.01em] sm:text-[22px]">
            {quote.to.amount}
          </span>
          <span className="text-[13px] text-muted">
            {currency ? (FIAT_NAMES[currency] ?? currency) : ""}
          </span>
        </div>
      </div>
      <dl className="m-0 flex flex-col border-t border-edge-soft pt-1 text-sm">
        <Row label={`Fee (${PAYCREST_SENDER_FEE_PERCENT}%)`} value={formatToken(fee, token, 2)} />
        <Row label="Amount converted" value={formatToken(converted, token, 2)} />
        {rate && <Row label="Rate" value={rate} />}
      </dl>
      <div className="flex items-center justify-between gap-3 border-t border-edge-soft pt-3 text-[13px] text-muted">
        <span>The fee is fixed. The rate locks on the next step and can move slightly.</span>
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
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold">Payout account</h2>
        {saved.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setSavedOpen((v) => !v)}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-edge bg-pill px-3 text-[13px] font-semibold"
            >
              <PersonIcon />
              Saved recipients
            </button>
            <PickerSheet
              open={savedOpen}
              onClose={() => setSavedOpen(false)}
              title="Saved recipients"
              groups={savedGroups}
              value=""
              searchPlaceholder="Search name or account"
              onSelect={(id) => {
                const r = saved.find((s) => s.id === id);
                if (!r) return;
                setPayout({
                  institution: r.institution,
                  institutionName: r.institutionName,
                  accountIdentifier: r.accountIdentifier,
                  accountName: r.accountName,
                });
              }}
            />
          </div>
        )}
      </div>

      <BankAccountFields
        id="payout"
        currency={currency}
        value={payout}
        onChange={setPayout}
        onLookupChange={setLookup}
        wrongLabel="Not them?"
      />

      {name && !alreadySaved && (
        <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={saveRecipient}
            onChange={(e) => setSaveRecipient(e.target.checked)}
            className="size-[18px] accent-ink"
          />
          Save {firstName} to Recipients
        </label>
      )}

      {/* Refund address: prefilled with the connected wallet, always editable */}
      <div className="flex flex-col gap-1.5 border-t border-edge-soft pt-4">
        <label htmlFor="refund" className="text-[13px] font-medium text-muted">
          Refund address
        </label>
        <input
          id="refund"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="0x… wallet address"
          value={refund}
          onChange={(e) => setRefund(e.target.value)}
          className="h-12 w-full rounded-[14px] border border-edge bg-card px-3.5 font-mono text-[13px] text-ink outline-none placeholder:text-muted focus:border-ink focus:shadow-[0_0_0_3px_rgba(23,23,26,0.08)]"
        />
        <span className="text-[13px] text-muted">
          {refund.trim() && !refundValid
            ? "That doesn't look like a valid wallet address."
            : "This wallet will be used for any refunds."}
        </span>
      </div>
    </div>
  );

  return (
    <FlowPage mode="sell" onBack={onBack} backLabel="Back to amount">
      <StepProgress steps={["Amount", "Recipient", "Send"]} current={1} />
      <h1 className="mb-4 text-[26px] font-semibold tracking-[-0.02em]">
        Who&apos;s getting the money?
      </h1>
      {summary}
      <div className="h-4" />
      {form}
      <PrimaryButton disabled={!!blocker} onClick={confirm}>
        {blocker ?? (
          <>
            Lock rate and get deposit address <ArrowRight />
          </>
        )}
      </PrimaryButton>
      <p className="mt-3 text-center text-[13px] leading-normal text-muted">
        Nothing leaves your wallet until you send it on the next step.
      </p>
    </FlowPage>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 font-medium">{value}</dd>
    </div>
  );
}

function PersonIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
    </svg>
  );
}
