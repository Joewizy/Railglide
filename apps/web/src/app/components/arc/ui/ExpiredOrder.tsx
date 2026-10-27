"use client";

/**
 * The calm "This order expired" page, shared by every provider (Paycrest and
 * ChainRails, Buy and Sell). No red, one clear next step, a short "already
 * sent the money?" line, the old quote faded out, and what happened.
 *
 * Callers wrap it in FlowPage (or render it inside one) and pass the numbers.
 */

import React, { useState } from "react";
import { SUPPORT_EMAIL_URL } from "@/config/support";
import { ArrowRight, CheckIcon, StepProgress } from "./sendKit";

export type ExpiredRow = { label: string; value: React.ReactNode };

export function ExpiredOrder({
  steps,
  deadline,
  createdAt,
  againTitle,
  againSub,
  payLabel,
  payAmount,
  receiveLabel,
  receiveAmount,
  rateLine,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  quoteRows,
  orderId,
  onHome,
  twoColumns = true,
}: {
  /** The 3 flow steps, e.g. ["Amount", "Review", "Pay"]. */
  steps: string[];
  /** ISO time the order expired. */
  deadline: string | null;
  /** ISO time the order was created. */
  createdAt: string | null;
  againTitle: string;
  againSub: string;
  payLabel: string;
  payAmount: string;
  receiveLabel: string;
  /** Today's estimate, or null while loading / when it shows on the next step. */
  receiveAmount: string | null;
  rateLine?: string | null;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  quoteRows: ExpiredRow[];
  orderId?: string | null;
  onHome?: () => void;
  /** Off when rendered inside a narrow column (the progress card stacks). */
  twoColumns?: boolean;
}) {
  const created = createdAt ? Date.parse(createdAt) : NaN;
  const expired = deadline ? Date.parse(deadline) : NaN;
  const expiredTime = deadline ? clockTime(deadline) : null;
  const waitedMins =
    Number.isFinite(created) && Number.isFinite(expired)
      ? Math.round((expired - created) / 60000)
      : null;

  return (
    <>
      <div className="max-w-[540px]">
        <StepProgress steps={steps} current={2} />
      </div>

      <div className="flex items-start gap-4">
        <span className="grid size-12 flex-none place-items-center rounded-2xl bg-chip text-ink-soft">
          <TimerIcon />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">This order expired</h1>
          <p className="text-[15px] text-muted">
            No payment arrived{expiredTime ? ` before ${expiredTime}` : ""}, so the rate
            wasn&apos;t used. You haven&apos;t been charged.
          </p>
        </div>
      </div>

      <div
        className={`mt-6 grid grid-cols-1 gap-5 ${
          twoColumns ? "lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start" : ""
        }`}
      >
        <div className="flex min-w-0 flex-col gap-3">
          <section className="rounded-card border-2 border-ink bg-card px-5 py-[18px]">
            <h2 className="text-[17px] font-semibold">{againTitle}</h2>
            <p className="mt-1 text-[13px] text-muted">{againSub}</p>
            <div className="mt-4 flex items-center justify-between gap-4 rounded-2xl bg-page px-4 py-3.5">
              <div className="flex min-w-0 flex-col">
                <span className="text-[13px] text-muted">{payLabel}</span>
                <span className="text-xl font-semibold">{payAmount}</span>
              </div>
              <span className="flex-none text-muted">
                <ArrowRight />
              </span>
              <div className="flex min-w-0 flex-col items-end text-right">
                <span className="text-[13px] text-muted">{receiveLabel}</span>
                <span className="text-xl font-semibold">{receiveAmount ?? "…"}</span>
                {rateLine && <span className="text-xs text-muted">{rateLine}</span>}
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={onPrimary}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-button bg-ink text-[15px] font-semibold text-white hover:bg-black sm:flex-1"
              >
                {primaryLabel} <ArrowRight />
              </button>
              {secondaryLabel && onSecondary && (
                <button
                  type="button"
                  onClick={onSecondary}
                  className="h-12 rounded-button border border-edge bg-card px-5 text-[15px] font-semibold"
                >
                  {secondaryLabel}
                </button>
              )}
            </div>
          </section>

          {/* Brief: a late transfer is refunded, don't send twice. */}
          <p className="rounded-2xl bg-subtle px-4 py-3 text-[13px] leading-normal text-muted">
            <strong className="font-semibold text-ink">Already sent the money?</strong>{" "}
            Don&apos;t send it again. It will be refunded.{" "}
            <a href={SUPPORT_EMAIL_URL} className="font-semibold text-ink underline underline-offset-2">
              Contact support
            </a>
          </p>

          {quoteRows.length > 0 && (
            // Faded so it reads as history, not something to act on.
            <section className="rounded-card border border-edge bg-card px-5 py-[18px] opacity-60">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[17px] font-semibold text-ink-soft">Expired quote</h2>
                <span className="rounded-full bg-chip px-3 py-1 text-[13px] font-semibold text-ink-soft">
                  No longer valid
                </span>
              </div>
              <dl className="m-0 mt-2 flex flex-col text-sm">
                {quoteRows.map((r) => (
                  <div
                    key={r.label}
                    className="flex justify-between gap-4 border-b border-edge-soft py-2.5 last:border-0"
                  >
                    <dt className="text-muted">{r.label}</dt>
                    <dd className="m-0 text-right text-muted">{r.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>

        <aside className="flex flex-col gap-4 rounded-card border border-edge bg-card px-5 py-5 lg:sticky lg:top-6">
          <h2 className="text-[17px] font-semibold">What happened</h2>
          <ol className="m-0 flex list-none flex-col p-0">
            <Step
              icon={
                <span className="grid size-6 place-items-center rounded-full bg-success text-white">
                  <CheckIcon size={12} />
                </span>
              }
              line="bg-success"
              title="Rate locked"
              detail={`${createdAt ? `${clockTime(createdAt)} · ` : ""}payment details issued`}
            />
            <Step
              icon={<span className="size-6 rounded-full border-2 border-step-ring" />}
              line="bg-edge"
              title="No payment received"
              detail={waitedMins ? `Waited ${waitedMins} minutes` : "Nothing arrived in time"}
            />
            <Step
              icon={
                <span className="grid size-6 place-items-center rounded-full bg-ink-soft text-xs font-bold text-white">
                  ✕
                </span>
              }
              title="Order expired"
              detail={`${expiredTime ? `${expiredTime} · ` : ""}nothing was charged`}
            />
          </ol>
          {orderId && (
            <div className="flex flex-col gap-1.5 border-t border-edge-soft pt-3.5">
              <span className="text-[13px] text-muted">Order number</span>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[13px]">
                  {orderId.length > 14 ? `${orderId.slice(0, 8)}…${orderId.slice(-4)}` : orderId}
                </span>
                <CopyText text={orderId} />
              </div>
            </div>
          )}
        </aside>
      </div>

      {onHome && (
        <button
          type="button"
          onClick={onHome}
          className="mt-6 self-start text-sm font-semibold underline underline-offset-2"
        >
          Back to home
        </button>
      )}
    </>
  );
}

function Step({
  icon,
  line,
  title,
  detail,
}: {
  icon: React.ReactNode;
  /** Connector colour to the next step; omitted on the last one. */
  line?: string;
  title: string;
  detail: string;
}) {
  return (
    <li className="flex gap-3">
      <div className="flex flex-none flex-col items-center">
        {icon}
        {line && <span className={`min-h-5 w-0.5 flex-1 ${line}`} />}
      </div>
      <div className={`flex flex-col gap-0.5 ${line ? "pb-[18px]" : ""}`}>
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-[13px] text-muted">{detail}</span>
      </div>
    </li>
  );
}

function CopyText({ text }: { text: string }) {
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
      className="flex-none text-[13px] font-semibold text-ink"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function TimerIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2 2" />
      <path d="M10 2h4" />
    </svg>
  );
}

/** "2026-10-27T18:44:29Z" → "6:44 PM" (local). */
function clockTime(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
