"use client";

/**
 * The last step of a Paycrest Buy or Sell (design: Status.dc.html).
 *
 * Sell: "Send 800.00 USDC to finish" — pay from the connected wallet when it
 * holds enough, otherwise the deposit address (with QR) is the main card.
 * Buy: "Pay ₦22,109.97 to finish" — the one-time bank account to pay into.
 * Both show one countdown from the order's validUntil, the locked quote with
 * the order's real numbers, and the 4-step progress on the side.
 *
 * All order logic (create, fund, poll) lives in SendScreen; this only draws.
 */

import React, { useState } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { getChain, type ChainId } from "@/config/network";
import { paycrestOnrampPaid, type PaycrestOrder } from "@/rails/paycrest";
import { usePaycrestRate } from "@/hooks/usePaycrestRate";
import { ExpiredOrder, type ExpiredRow } from "./ui/ExpiredOrder";
import { PAYCREST_SENDER_FEE_PERCENT } from "@/config/fees";
import {
  formatDeadline,
  formatFiat,
  formatNumber,
  formatToken,
} from "@/utils";
import type { QuoteExec } from "./SendScreen";
import {
  ArrowRight,
  CheckIcon,
  FlowPage,
  Notice,
  PrimaryButton,
  StepProgress,
} from "./ui/sendKit";

/* ───────── types ───────── */

export type StageRow = {
  l: string;
  d: string;
  ref?: string;
  refHref?: string;
};

export type OfframpPhase =
  | "creating"
  | "awaiting-funds"
  | "sending"
  | "confirming"
  | "partial"
  | "converting"
  | "settled"
  | "expired"
  | "refunded";

export type PaycrestOrderScreenProps = {
  direction: "offramp" | "onramp";
  /** Headline for the in-between Sell phases (confirming, converting…). */
  headline: string;
  bootError: string | null;
  railError: string | null;
  done: boolean;
  onDone: () => void;
  onRestart: () => void;
  /** Creates a fresh Paycrest order (new id, address, validUntil) with the same payout. */
  onNewRate: () => void;
  onFund: () => void;
  funding: boolean;
  showFunding: boolean;
  isExpired: boolean;
  stuckAfterPaid: boolean;
  countdown: string | null;
  expiringSoon: boolean;
  sendLabel: string;
  receiveLabel: string;
  fromToken: string;
  fromChainLabel: string;
  fiatCode: string;
  payoutName: string | null;
  payoutBank: string | null;
  payoutAcct: string | null;
  offrampOrder: PaycrestOrder | null;
  onrampOrder: PaycrestOrder | null;
  balanceFormatted: string | undefined;
  hasBalance: boolean;
  offrampPaid: number;
  sendAmountNum: number;
  phase: OfframpPhase | null;
  stages: StageRow[];
  activeIndex: number;
  timelineDone: boolean;
  depositSent: boolean;
  transferTxHash: string | null;
  walletAddress: string | null;
  exec: QuoteExec | null;
  validUntil: string | null;
  /** Buy: back to step 1 with the same amount filled in. */
  onChangeAmount?: () => void;
  /** Set when the order was opened from History: a Back link to the list. */
  onBack?: () => void;
};

const MODAL_SHADOW =
  "0 16px 48px rgba(20,18,14,0.28), 0 4px 12px rgba(20,18,14,0.16)";

/* ───────── screen ───────── */

export function PaycrestOrderScreen(props: PaycrestOrderScreenProps) {
  const [confirmNav, setConfirmNav] = useState(false);
  const {
    direction,
    headline,
    bootError,
    railError,
    done,
    onDone,
    onRestart,
    onNewRate,
    onFund,
    funding,
    showFunding,
    isExpired,
    stuckAfterPaid,
    countdown,
    expiringSoon,
    sendLabel,
    receiveLabel,
    fromToken,
    fromChainLabel,
    fiatCode,
    payoutName,
    payoutBank,
    payoutAcct,
    offrampOrder,
    onrampOrder,
    balanceFormatted,
    hasBalance,
    offrampPaid,
    sendAmountNum,
    phase,
    stages,
    activeIndex,
    timelineDone,
    depositSent,
    transferTxHash,
    walletAddress,
    exec,
    validUntil,
    onChangeAmount,
    onBack,
  } = props;

  const isOfframp = direction === "offramp";
  const order = isOfframp ? offrampOrder : onrampOrder;
  const deadline = validUntil ? clockTime(validUntil) : null;

  // Buy: waiting for the bank transfer until the hook moves past step 2.
  const onrampWaiting =
    !isOfframp && !!onrampOrder?.depositAccountIdentifier && activeIndex <= 1;
  const waiting = isOfframp ? showFunding && !isExpired : onrampWaiting;

  const chainLabel = isOfframp
    ? fromChainLabel
    : exec?.toChain
      ? (getChain(exec.toChain)?.name ?? fromChainLabel)
      : fromChainLabel;
  const settlementChain = isOfframp ? exec?.fromChain : exec?.toChain;
  const receiptTx = isOfframp
    ? (offrampOrder?.txHash ?? transferTxHash)
    : (onrampOrder?.txHash ?? null);
  const receiptHref =
    receiptTx && settlementChain ? explorerTxUrl(settlementChain, receiptTx) : null;
  const cryptoRecipient = onrampOrder?.recipientAddress ?? walletAddress ?? null;

  // Buy amounts come straight from the order.
  const payAmount =
    onrampOrder?.amountToTransfer && onrampOrder.depositCurrency
      ? formatFiat(onrampOrder.depositCurrency, Number(onrampOrder.amountToTransfer))
      : sendLabel;

  // ── Title + subtitle ──
  const title = bootError || railError
    ? "Something went wrong"
    : done
      ? isOfframp
        ? "Sent"
        : "Purchase complete"
      : isOfframp
        ? isExpired
          ? "Rate expired"
          : waiting
            ? `Send ${sendLabel} to finish`
            : headline
        : onrampWaiting
          ? `Pay ${payAmount} to finish`
          : onrampOrder
            ? `Payment received — sending your ${fromToken}`
            : "Setting up your order…";
  const subtitle = done
    ? null
    : isOfframp
      ? waiting && payoutName
        ? `${payoutName} gets ${receiveLabel} once it arrives.`
        : null
      : onrampWaiting
        ? `You get ${receiveLabel} on ${chainLabel} once it arrives.`
        : null;

  const goHome = () => (waiting && !done ? setConfirmNav(true) : onDone());

  // Buy: the deadline passed with no payment. Shown as its own calm page (not
  // an error) with a fresh estimate at today's buy rate.
  const onrampExpired =
    !isOfframp &&
    !done &&
    !!onrampOrder &&
    !paycrestOnrampPaid(onrampOrder) &&
    (onrampOrder.status === "expired" ||
      (!!validUntil && Date.now() > Date.parse(validUntil)));
  const { rate: todaysRate } = usePaycrestRate(
    fiatCode,
    fromToken,
    onrampExpired,
    "buy"
  );

  if (onrampExpired && onrampOrder) {
    return (
      <OnrampExpired
        order={onrampOrder}
        exec={exec}
        fiatCode={fiatCode}
        token={fromToken}
        chainLabel={chainLabel}
        todaysRate={todaysRate}
        recipient={cryptoRecipient}
        onNewOrder={onNewRate}
        onChangeAmount={onChangeAmount}
        onHome={onDone}
        onBack={onBack}
      />
    );
  }

  // ── Locked quote rows ──
  const quoteRows: { label: string; value: React.ReactNode }[] = [];
  if (isOfframp && offrampOrder) {
    const fee = Number(offrampOrder.senderFee ?? 0);
    quoteRows.push({ label: "You send", value: sendLabel });
    if (fee > 0)
      quoteRows.push({
        label: `Fee (${PAYCREST_SENDER_FEE_PERCENT}%)`,
        value: formatToken(fee, fromToken, 2),
      });
    if (offrampOrder.amount)
      quoteRows.push({
        label: "Amount converted",
        value: formatToken(Number(offrampOrder.amount), fromToken, 2),
      });
    if (offrampOrder.rate)
      quoteRows.push({
        label: "Rate",
        value: `1 ${fromToken} = ${formatNumber(Number(offrampOrder.rate))} ${fiatCode}`,
      });
    quoteRows.push({ label: "They receive", value: receiveLabel });
    const paidTo = [payoutName, payoutBank, payoutAcct].filter(Boolean).join(" · ");
    if (paidTo) quoteRows.push({ label: "Paid to", value: paidTo });
  } else if (!isOfframp && onrampOrder) {
    quoteRows.push({ label: "You pay", value: payAmount });
    if (onrampOrder.rate)
      quoteRows.push({
        label: "Rate",
        value: `1 ${fromToken} = ${formatNumber(Number(onrampOrder.rate))} ${fiatCode}`,
      });
    quoteRows.push({ label: "You receive", value: receiveLabel });
    if (cryptoRecipient)
      quoteRows.push({
        label: "To",
        value: (
          <>
            <span className="font-mono">{short0x(cryptoRecipient)}</span> on{" "}
            {chainLabel}
          </>
        ),
      });
  }

  return (
    <FlowPage wide mode={isOfframp ? "sell" : "buy"} onBack={onBack}>
      <div className="max-w-[540px]">
        <StepProgress
          steps={isOfframp ? ["Amount", "Recipient", "Send"] : ["Amount", "Review", "Pay"]}
          current={done ? 3 : 2}
        />
      </div>

      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{title}</h1>
          {subtitle && <p className="text-[15px] text-muted">{subtitle}</p>}
        </div>
        {waiting && countdown && (
          <span
            role="timer"
            className={`inline-flex h-10 items-center gap-2 rounded-full px-3.5 text-sm font-semibold ${
              expiringSoon ? "bg-[#fde8e6] text-danger" : "bg-warn-bg text-warn-strong"
            }`}
          >
            <ClockIcon />
            {countdown} left{deadline ? ` · ${isOfframp ? "send" : "pay"} by ${deadline}` : ""}
          </span>
        )}
      </div>

      {bootError ? (
        <div className="mt-6">
          <Notice tone="error" title="Couldn't start this order.">
            {bootError}
          </Notice>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          {/* ── Main column ── */}
          <div className="flex min-w-0 flex-col gap-3">
            {railError && (
              <Card>
                <Notice tone="error" title="This order stopped.">
                  {railError}
                </Notice>
                <div className="mt-3 flex gap-2">
                  {/* Buy: an expired/failed order can't be reopened, so retry
                      makes a fresh order (new account + rate). Sell re-adopts. */}
                  <SmallButton onClick={isOfframp ? onRestart : onNewRate}>
                    {isOfframp ? "Try again" : "Get a new account"}
                  </SmallButton>
                  <SmallButton secondary onClick={onDone}>
                    Start over
                  </SmallButton>
                </div>
              </Card>
            )}

            {/* Sell: how to send the USDC */}
            {isOfframp && waiting && offrampOrder?.receiveAddress && (
              <>
                <h2 className="text-[17px] font-semibold">Choose how to send it</h2>
                {walletAddress && hasBalance && (
                  <Card className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <h3 className="text-[15px] font-semibold">From your connected wallet</h3>
                      <span className="text-[13px] text-muted">
                        {short0x(walletAddress)}
                        {balanceFormatted !== undefined &&
                          ` · balance ${formatToken(Number(balanceFormatted), fromToken, 2)} on ${fromChainLabel}`}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={funding || phase === "sending"}
                      onClick={onFund}
                      className="inline-flex h-12 items-center gap-2 rounded-button bg-ink px-5 text-[15px] font-semibold text-white hover:bg-black disabled:cursor-wait disabled:bg-disabled disabled:text-muted"
                    >
                      {funding || phase === "sending" ? "Confirm in your wallet…" : `Send ${sendLabel}`}
                      {!funding && phase !== "sending" && <ArrowRight />}
                    </button>
                  </Card>
                )}
                <Card primary={!hasBalance}>
                  <div className="flex flex-col gap-1">
                    <h3 className="text-[15px] font-semibold">From an exchange or another wallet</h3>
                    <span className="flex items-center gap-1.5 text-[13px] text-warn-ink">
                      <span className="size-1.5 rounded-full bg-warn-strong" />
                      {fromToken} on <strong className="font-semibold">{fromChainLabel}</strong>{" "}
                      only, in one transfer
                    </span>
                  </div>
                  <div className="mt-4 flex flex-wrap items-start gap-5">
                    <div className="flex min-w-0 flex-1 flex-col gap-3">
                      <CopyRow label="Amount" value={sendLabel} copyText={String(sendAmountNum)} />
                      <CopyRow
                        label="Address"
                        value={offrampOrder.receiveAddress}
                        copyText={offrampOrder.receiveAddress}
                        mono
                      />
                    </div>
                    <div className="flex flex-col items-center gap-1.5">
                      <div
                        role="img"
                        aria-label="QR code of the deposit address"
                        className="rounded-xl border border-edge bg-white p-2"
                      >
                        <QRCodeSVG value={offrampOrder.receiveAddress} size={112} />
                      </div>
                      <span className="text-xs text-muted">Scan from an exchange app</span>
                    </div>
                  </div>
                  <p className="mt-4 text-[13px] leading-normal text-muted">
                    Exchanges may deduct a withdrawal fee. Make sure the full {sendLabel}{" "}
                    arrives, or the order is refunded.
                  </p>
                </Card>
              </>
            )}

            {/* Sell: sent from the wallet, waiting for it to confirm */}
            {isOfframp && depositSent && phase === "confirming" && transferTxHash && exec && (
              <a
                href={explorerTxUrl(exec.fromChain, transferTxHash) ?? "#"}
                target="_blank"
                rel="noreferrer"
                className="self-start text-sm font-semibold underline underline-offset-2"
              >
                View your payment on {fromChainLabel} ↗
              </a>
            )}

            {/* Sell: part of the deposit arrived */}
            {isOfframp && phase === "partial" && (
              <Notice tone="warning" title="Part of your deposit arrived.">
                Received {formatToken(offrampPaid, fromToken, 2)} of {sendLabel}. Send{" "}
                {formatToken(Math.max(sendAmountNum - offrampPaid, 0), fromToken, 2)} more
                to the same address to continue.
              </Notice>
            )}

            {/* Buy: the account to pay into */}
            {onrampWaiting && onrampOrder && (
              <Card primary>
                <h2 className="text-[17px] font-semibold">Pay into this account</h2>
                <p className="mt-1 text-[13px] text-muted">
                  Send the exact amount in one transfer from your bank app.
                </p>
                <div className="mt-4 flex flex-col gap-3">
                  <CopyRow
                    label="Amount"
                    value={payAmount}
                    copyText={String(onrampOrder.amountToTransfer ?? "")}
                  />
                  <CopyRow
                    label="Account number"
                    value={onrampOrder.depositAccountIdentifier ?? ""}
                    copyText={onrampOrder.depositAccountIdentifier ?? ""}
                    mono
                  />
                  {onrampOrder.depositInstitution && (
                    <InfoRow label="Bank" value={onrampOrder.depositInstitution} />
                  )}
                  {onrampOrder.depositAccountName && (
                    <InfoRow label="Account name" value={onrampOrder.depositAccountName} />
                  )}
                </div>
              </Card>
            )}

            {/* Sell: the deposit window closed */}
            {isOfframp && isExpired &&
              (stuckAfterPaid ? (
                <Notice tone="warning" title="Your payment arrived — the payout is taking longer.">
                  Don&apos;t send again. If it can&apos;t be completed, the refund goes to{" "}
                  {walletAddress ? short0x(walletAddress) : "your wallet"}.
                </Notice>
              ) : (
                <Card>
                  <h2 className="text-[15px] font-semibold">This rate has expired</h2>
                  <p className="mt-1 text-sm text-muted">
                    Nothing arrived before {deadline ?? "the deadline"}, so nothing was
                    charged. Anything sent after that is refunded to your wallet. Get a new
                    rate for the same amount and recipient.
                  </p>
                  <PrimaryButton onClick={onNewRate}>
                    Get a new rate <ArrowRight />
                  </PrimaryButton>
                </Card>
              ))}
            {isOfframp && phase === "refunded" && (
              <Notice tone="info" title="Refunded.">
                This order couldn&apos;t be completed, so your deposit went back
                {walletAddress ? ` to ${short0x(walletAddress)}` : " to your wallet"}.
              </Notice>
            )}

            {/* Done */}
            {done && (
              <Card className="flex flex-col items-center text-center">
                <span className="grid size-12 place-items-center rounded-full bg-success text-white">
                  <CheckIcon size={22} />
                </span>
                <p className="mt-3 text-[28px] font-semibold tracking-[-0.02em]">{receiveLabel}</p>
                <p className="mt-1 text-[15px] text-muted">
                  {isOfframp
                    ? payoutName
                      ? `delivered to ${payoutName}${[payoutBank, payoutAcct].filter(Boolean).length ? ` · ${[payoutBank, payoutAcct].filter(Boolean).join(" · ")}` : ""}`
                      : "delivered"
                    : cryptoRecipient
                      ? `in your wallet ${short0x(cryptoRecipient)} on ${chainLabel}`
                      : `on ${chainLabel}`}
                </p>
                {completedLabel(order) && (
                  <p className="mt-1 text-[13px] text-muted">{completedLabel(order)}</p>
                )}
                {receiptHref && (
                  <a
                    href={receiptHref}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 text-sm font-semibold underline underline-offset-2"
                  >
                    View transaction on {chainLabel} ↗
                  </a>
                )}
              </Card>
            )}

            {/* Locked quote — the order's real numbers */}
            {quoteRows.length > 0 && !(isOfframp && isExpired) && phase !== "refunded" && (
              <Card>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-[17px] font-semibold">
                    {done ? "Order summary" : "Locked quote"}
                  </h2>
                  {!done && (
                    <span className="inline-flex items-center gap-1 text-[13px] font-medium text-success">
                      <CheckIcon size={13} />
                      Rate locked
                    </span>
                  )}
                </div>
                <dl className="m-0 mt-2 flex flex-col text-sm">
                  {quoteRows.map((r) => (
                    <div
                      key={r.label}
                      className="flex justify-between gap-4 border-b border-edge-soft py-2.5 last:border-0"
                    >
                      <dt className="text-muted">{r.label}</dt>
                      <dd className="m-0 text-right font-medium">{r.value}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            )}
          </div>

          {/* ── Progress ── */}
          {stages.length > 0 && (
            <aside
              aria-labelledby="progress-h"
              className="flex flex-col gap-4 rounded-card border border-edge bg-card px-5 py-5 lg:sticky lg:top-6"
            >
              <h2 id="progress-h" className="text-[17px] font-semibold">
                Progress
              </h2>
              <ProgressList
                stages={stages}
                activeIndex={activeIndex}
                done={timelineDone}
                failed={!!railError}
              />
              {waiting && deadline && (
                <p className="border-t border-edge-soft pt-3.5 text-[13px] leading-normal text-muted">
                  {isOfframp
                    ? `If nothing arrives by ${deadline}, the order expires. Anything sent after that is refunded to your wallet.`
                    : `If your payment doesn't arrive by ${deadline}, the order expires and the account closes.`}
                </p>
              )}
              {order?.id && (
                <div className="flex items-start justify-between gap-2 text-[13px] text-muted">
                  <span className="min-w-0">
                    Order{" "}
                    <span className="select-all break-all font-mono text-ink">{order.id}</span>
                  </span>
                  <CopyLink text={order.id} />
                </div>
              )}
            </aside>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={goHome}
        className="mt-6 self-start text-sm font-semibold underline underline-offset-2"
      >
        Back to home
      </button>

      {confirmNav && (
        <StatusModal
          title="This order is still waiting"
          body="It keeps running if you leave. You can come back to it from History."
          confirmLabel="Go home"
          onConfirm={() => {
            setConfirmNav(false);
            onDone();
          }}
          onClose={() => setConfirmNav(false)}
        />
      )}
    </FlowPage>
  );
}

/* ───────── Buy: expired order ───────── */

function OnrampExpired({
  order,
  exec,
  fiatCode,
  token,
  chainLabel,
  todaysRate,
  recipient,
  onNewOrder,
  onChangeAmount,
  onHome,
  onBack,
}: {
  order: PaycrestOrder;
  exec: QuoteExec | null;
  fiatCode: string;
  token: string;
  chainLabel: string;
  todaysRate: number | null;
  recipient: string | null;
  onNewOrder: () => void;
  onChangeAmount?: () => void;
  onHome: () => void;
  onBack?: () => void;
}) {
  // The amount they typed (fiat), priced again at today's buy rate.
  const typedAmount = Number(exec?.fromAmount ?? 0);
  const newEstimate =
    todaysRate && typedAmount > 0 ? typedAmount / todaysRate : null;

  const quoteRows: ExpiredRow[] = [
    ...(Number(order.amountToTransfer) > 0
      ? [
          {
            label: "You were paying",
            value: formatFiat(order.depositCurrency ?? fiatCode, Number(order.amountToTransfer)),
          },
        ]
      : []),
    ...(order.rate
      ? [{ label: "Rate", value: `1 ${token} = ${formatNumber(Number(order.rate))} ${fiatCode}` }]
      : []),
    { label: "You'd have received", value: formatToken(Number(order.amount), token, 2) },
    ...(recipient
      ? [
          {
            label: "To",
            value: (
              <>
                <span className="font-mono">{short0x(recipient)}</span> · {chainLabel}
              </>
            ),
          },
        ]
      : []),
  ];

  return (
    <FlowPage wide mode="buy" onBack={onBack}>
      <ExpiredOrder
        steps={["Amount", "Review", "Pay"]}
        deadline={order.validUntil ?? null}
        createdAt={order.createdAt ?? null}
        againTitle="Buy again at today's rate"
        againSub="Same amount, wallet and bank details. You'll get new payment details and a fresh time limit."
        payLabel="You pay"
        payAmount={typedAmount > 0 ? formatFiat(fiatCode, typedAmount) : "—"}
        receiveLabel="You receive about"
        receiveAmount={newEstimate !== null ? formatToken(newEstimate, token, 2) : null}
        rateLine={todaysRate ? `1 ${token} ≈ ${formatNumber(todaysRate)} ${fiatCode}` : null}
        primaryLabel="Get new payment details"
        onPrimary={onNewOrder}
        secondaryLabel={onChangeAmount ? "Change amount" : undefined}
        onSecondary={onChangeAmount}
        quoteRows={quoteRows}
        orderId={order.id}
        onHome={onHome}
      />
    </FlowPage>
  );
}

/* ───────── pieces ───────── */

function Card({
  children,
  className = "",
  primary = false,
}: {
  children: React.ReactNode;
  className?: string;
  /** The card the user should act on gets the dark border. */
  primary?: boolean;
}) {
  return (
    <section
      className={`rounded-card bg-card px-5 py-[18px] ${
        primary ? "border-2 border-ink" : "border border-edge"
      } ${className}`}
    >
      {children}
    </section>
  );
}

function SmallButton({
  children,
  onClick,
  secondary = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  secondary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-10 rounded-xl px-4 text-sm font-semibold ${
        secondary ? "border border-edge bg-card text-ink" : "bg-ink text-white"
      }`}
    >
      {children}
    </button>
  );
}

/** A labelled value with a Copy button. */
function CopyRow({
  label,
  value,
  copyText,
  mono = false,
}: {
  label: string;
  value: string;
  copyText: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] text-muted">{label}</span>
      <div className="flex items-center justify-between gap-3 rounded-[14px] bg-page px-3.5 py-2.5">
        <span
          className={`min-w-0 select-all break-all ${
            mono ? "font-mono text-[13px]" : "text-[15px] font-semibold"
          }`}
        >
          {value}
        </span>
        <button
          type="button"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() =>
            navigator.clipboard
              ?.writeText(copyText)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {})
          }
          className="inline-flex h-9 flex-none items-center gap-1.5 rounded-full border border-edge bg-card px-3 text-[13px] font-semibold"
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 px-0.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function CopyLink({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {})
      }
      className="flex-none font-semibold text-ink"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Done = green check, current = ringed dot, later = grey ring. */
function ProgressList({
  stages,
  activeIndex,
  done,
  failed,
}: {
  stages: StageRow[];
  activeIndex: number;
  done: boolean;
  failed: boolean;
}) {
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {stages.map((s, i) => {
        const isDone = done || activeIndex > i;
        const isActive = !done && activeIndex === i;
        const isFailed = failed && isActive;
        const last = i === stages.length - 1;
        return (
          <li key={i} aria-current={isActive ? "step" : undefined} className="flex gap-3">
            <div className="flex flex-none flex-col items-center">
              {isFailed ? (
                <span className="grid size-6 place-items-center rounded-full bg-danger text-xs font-bold text-white">
                  !
                </span>
              ) : isDone ? (
                <span className="grid size-6 place-items-center rounded-full bg-success text-white">
                  <CheckIcon size={12} />
                </span>
              ) : isActive ? (
                <span className="grid size-6 place-items-center rounded-full border-2 border-ink">
                  <span className="size-2 rounded-full bg-ink" />
                </span>
              ) : (
                <span className="size-6 rounded-full border-2 border-step-ring" />
              )}
              {!last && (
                <span
                  className={`min-h-5 w-0.5 flex-1 ${isDone ? "bg-success" : "bg-edge"}`}
                />
              )}
            </div>
            <div className={`flex min-w-0 flex-col gap-0.5 ${last ? "" : "pb-[18px]"}`}>
              <span
                className={`text-sm ${
                  isDone || isActive ? "font-semibold" : "font-medium text-ink-soft"
                }`}
              >
                {s.l}
              </span>
              <span className="text-[13px] leading-[1.45] text-muted">{s.d}</span>
              {s.ref && s.refHref && (isDone || isActive) && (
                <a
                  href={s.refHref}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13px] font-medium underline underline-offset-2"
                >
                  {s.ref} ↗
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StatusModal({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  onConfirm?: () => void;
  onClose: () => void;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        className="w-full max-w-[360px] rounded-card border border-edge bg-card p-5 font-inter text-ink"
        style={{ boxShadow: MODAL_SHADOW }}
      >
        <strong className="text-[15px]">{title}</strong>
        <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <SmallButton secondary onClick={onClose}>
            {confirmLabel ? "Cancel" : "Got it"}
          </SmallButton>
          {confirmLabel && onConfirm && (
            <SmallButton onClick={onConfirm}>{confirmLabel}</SmallButton>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

/* ───────── utils ───────── */

function explorerTxUrl(chainId: ChainId, txHash: string): string | null {
  const base = getChain(chainId)?.explorer;
  return base ? `${base}/tx/${txHash}` : null;
}

function short0x(hash: string): string {
  if (!hash.startsWith("0x") || hash.length < 14) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

/** "2026-10-27T18:44:29Z" → "6:44 PM" (local). */
function clockTime(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "43" → "43s", "126" → "2m 06s". */
function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${String(s).padStart(2, "0")}s` : `${m}m`;
}

/**
 * "Completed in 2m 06s" from the order's transactionLogs (deposit → paid out),
 * falling back to created → updated, then a timestamp.
 */
function completedLabel(order: PaycrestOrder | null): string | null {
  if (!order) return null;
  const logs = transactionLogs(order.raw);
  const at = (s: string) => logs.find((l) => l.status === s)?.at;
  const start = at("crypto_deposited") ?? at("order_fulfilling");
  const end = at("order_fulfilled") ?? at("order_settled");
  if (start != null && end != null && end > start)
    return `Completed in ${formatDuration(Math.round((end - start) / 1000))}`;
  const created = order.createdAt ? Date.parse(order.createdAt) : NaN;
  const updated = order.updatedAt ? Date.parse(order.updatedAt) : NaN;
  if (Number.isFinite(created) && Number.isFinite(updated) && updated > created) {
    const secs = Math.round((updated - created) / 1000);
    if (secs > 0 && secs < 600) return `Completed in ${formatDuration(secs)}`;
  }
  return order.updatedAt ? `Completed ${formatDeadline(order.updatedAt)}` : null;
}

/** The order's transactionLogs (under raw.data, or raw), sorted by time. */
function transactionLogs(raw: unknown): { status: string; at: number }[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const data =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : root;
  const logs = data.transactionLogs;
  if (!Array.isArray(logs)) return [];
  return logs
    .map((l) => {
      const o = (l ?? {}) as Record<string, unknown>;
      return {
        status: typeof o.status === "string" ? o.status : "",
        at: typeof o.created_at === "string" ? Date.parse(o.created_at) : NaN,
      };
    })
    .filter((l) => l.status && Number.isFinite(l.at))
    .sort((a, b) => a.at - b.at);
}
