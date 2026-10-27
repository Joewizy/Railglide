"use client";

/**
 * Shared pieces for the Buy and Sell flows, built from the screens in
 * /apps/design with the Tailwind tokens in globals.css (@theme).
 *
 * Inter with tabular numbers on amounts, sentence-case labels, 20px cards,
 * 52px primary button, touch targets of at least 44px. Monospace is only for
 * wallet addresses.
 */

import React from "react";
import "flag-icons/css/flag-icons.min.css";

/* ------------------------------------------------------------------------ */
/* Layout                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * One knob to scale the whole Buy/Sell page (text, inputs, buttons, gaps).
 * 1 = as designed; 0.9 = 10% smaller; 1.1 = 10% bigger.
 */
export const FLOW_ZOOM = 0.8;

/** Page wrapper: Inter, tabular numbers, the warm page colour. */
export function FlowPage({
  children,
  wide = false,
  mode,
  onBack,
  backLabel = "Back",
}: {
  children: React.ReactNode;
  /** Two-column pages (recipient, status) use 960px instead of 540px. */
  wide?: boolean;
  /** Shows "Buy" or "Sell" at the top left so it's clear which flow this is. */
  mode?: "buy" | "sell";
  /** Back link, pinned to the far left of the page (not inside the column). */
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <div className="relative w-full font-inter" style={{ zoom: FLOW_ZOOM }}>
      {/* Desktop: in the left gutter, level with the Buy/Sell tag. Phones:
          its own row above the page. */}
      {onBack && (
        <div className="mb-1 flex lg:absolute lg:left-0 lg:top-0 lg:mb-0">
          <BackLink onClick={onBack}>{backLabel}</BackLink>
        </div>
      )}
      <div
        className={`mx-auto flex w-full flex-col text-ink tabular-nums ${
          wide ? "max-w-[960px]" : "max-w-[540px]"
        }`}
      >
        {mode && <FlowModeTag mode={mode} />}
        {children}
      </div>
    </div>
  );
}

/** Small "Buy" / "Sell" tag at the top of a flow page. */
function FlowModeTag({ mode }: { mode: "buy" | "sell" }) {
  return (
    <span className="mb-2 inline-flex h-7 items-center gap-1.5 self-start rounded-full bg-chip px-3 text-[13px] font-semibold text-ink">
      <Svg size={14}>
        {mode === "buy" ? <path d="M17 7L7 17M7 9v8h8" /> : <path d="M7 17L17 7M9 7h8v8" />}
      </Svg>
      {mode === "buy" ? "Buy" : "Sell"}
    </span>
  );
}

/** White card with the soft border. */
export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-card border border-edge bg-card px-4 py-3.5 sm:px-5 sm:py-[18px] ${className}`}
    >
      {children}
    </div>
  );
}

/** "Back" link with a left chevron. */
export function BackLink({
  onClick,
  children = "Back",
}: {
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-1 inline-flex h-11 items-center sm:h-9 gap-1 self-start rounded-[10px] pl-1 pr-2.5 text-sm font-medium text-ink-soft hover:text-ink"
    >
      <ChevronLeft />
      {children}
    </button>
  );
}

/** Page title + optional subtitle. */
export function FlowHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: React.ReactNode;
}) {
  return (
    <header className="mt-2 flex flex-col gap-1">
      <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{title}</h1>
      {subtitle && (
        <p className="text-sm leading-normal text-muted">{subtitle}</p>
      )}
    </header>
  );
}

/* ------------------------------------------------------------------------ */
/* Progress                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Numbered step progress. Done steps get a green check, the current one is
 * filled, later ones are outlined. Used with 3 steps on the forms (Amount,
 * Recipient, Send) and 4 on the status page.
 */
export function StepProgress({
  steps,
  current,
}: {
  steps: string[];
  /** Index of the current step (0-based). Steps before it count as done. */
  current: number;
}) {
  return (
    <ol
      aria-label="Progress"
      className="mb-4 mt-4 flex items-center gap-2 text-[13px] font-medium sm:gap-2.5"
    >
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <React.Fragment key={label}>
            {i > 0 && (
              <li
                aria-hidden
                className={`h-px flex-1 ${done || active ? "bg-success" : "bg-step-line"}`}
              />
            )}
            <li
              aria-current={active ? "step" : undefined}
              className={`flex items-center gap-1.5 sm:gap-2 ${
                active ? "text-ink" : "text-muted"
              }`}
            >
              {done ? (
                <span className="grid size-5 place-items-center rounded-full bg-success text-white sm:size-[22px]">
                  <CheckIcon size={12} />
                </span>
              ) : active ? (
                <span className="grid size-5 place-items-center rounded-full bg-ink text-[11px] font-semibold text-white sm:size-[22px] sm:text-xs">
                  {i + 1}
                </span>
              ) : (
                <span className="grid size-[18px] place-items-center rounded-full border border-step-ring text-[11px] font-semibold sm:size-5 sm:text-xs">
                  {i + 1}
                </span>
              )}
              <span className="whitespace-nowrap">{label}</span>
            </li>
          </React.Fragment>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------------ */
/* Amount input                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Big-number amount card: label on the left, an optional slot on the right
 * (balance + Max), the input with a pill beside it, and an optional message
 * slot underneath (errors, the zero-balance notice).
 */
export function AmountField({
  id,
  label,
  value,
  onChange,
  aside,
  pill,
  children,
  readOnly = false,
  prefix,
}: {
  id: string;
  label: string;
  value: string;
  onChange?: (value: string) => void;
  aside?: React.ReactNode;
  pill?: React.ReactNode;
  children?: React.ReactNode;
  readOnly?: boolean;
  /** Muted text before the number, e.g. "≈" on an estimate. */
  prefix?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-card border border-edge bg-card px-4 py-3.5 focus-within:border-ink focus-within:shadow-[0_0_0_3px_rgba(23,23,26,0.08)] sm:gap-1.5 sm:px-5 sm:pb-3.5 sm:pt-4">
      <div className="flex items-center justify-between gap-3 leading-5">
        <label htmlFor={id} className="text-[13px] font-medium text-muted">
          {label}
        </label>
        {aside}
      </div>
      <div className="flex items-center gap-2.5 sm:gap-3">
        {prefix && value && (
          <span aria-hidden className="text-[28px] font-semibold text-muted">
            {prefix}
          </span>
        )}
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange?.(e.target.value.replace(/[^0-9.]/g, ""))}
          className="h-12 min-w-0 flex-1 border-0 bg-transparent p-0 text-4xl font-semibold tracking-[-0.02em] text-ink outline-none placeholder:text-placeholder sm:h-12 sm:text-[34px]"
        />
        {pill}
      </div>
      {children}
    </div>
  );
}

/** "Balance 1,240.50 USDC · Max" for the amount card. Max hides at 0. */
export function BalanceAside({
  balanceLabel,
  showMax,
  onMax,
}: {
  balanceLabel: string;
  showMax: boolean;
  onMax: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted">
      <span>Balance {balanceLabel}</span>
      {showMax && (
        <button
          type="button"
          onClick={onMax}
          className="h-8 rounded-full bg-chip px-3 text-xs font-semibold text-ink"
        >
          Max
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Pills                                                                     */
/* ------------------------------------------------------------------------ */

const PILL =
  "inline-flex h-[46px] flex-none items-center gap-2 rounded-full border pl-[7px] pr-2.5 text-ink sm:h-12 sm:gap-2.5 sm:pl-2 sm:pr-3";

/**
 * Token + chain pill ("USDC on Base"). `emphasize` gives it the dark border
 * the zero-balance state uses to invite a tap.
 */
export function TokenChainPill({
  token,
  chainName,
  tokenLogo,
  chainLogo,
  onClick,
  emphasize = false,
}: {
  token: string;
  chainName: string;
  tokenLogo: React.ReactNode;
  chainLogo?: React.ReactNode;
  onClick?: () => void;
  emphasize?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Change token or chain, currently ${token} on ${chainName}`}
      className={`${PILL} ${
        emphasize ? "border-[1.5px] border-ink bg-card" : "border-edge bg-pill"
      }`}
    >
      <span className="relative size-7 flex-none sm:size-[30px]">
        <span className="grid size-full place-items-center">{tokenLogo}</span>
        {chainLogo && (
          <span className="absolute -bottom-[3px] -right-[3px] grid size-[14px] place-items-center overflow-hidden rounded-full border-2 border-pill bg-card">
            {chainLogo}
          </span>
        )}
      </span>
      <span className="flex flex-col items-start leading-[1.15]">
        <span className="text-sm font-semibold sm:text-[15px]">{token}</span>
        <span className="text-[11px] text-muted sm:text-xs">on {chainName}</span>
      </span>
      <ChevronDown />
    </button>
  );
}

/** SVG country flag from the flag-icons set ("ng", "ci", …). */
export function Flag({
  countryCode,
  className = "",
}: {
  countryCode: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`fi fi-${countryCode.toLowerCase()} block h-5 w-7 flex-none overflow-hidden rounded border border-black/10 bg-cover ${className}`}
    />
  );
}

/** Currency pill: flag, code, country ("NGN · Nigeria"). Opens the picker. */
export function CurrencyPill({
  countryCode,
  currencyCode,
  countryName,
  currencyName,
  onClick,
}: {
  countryCode: string;
  currencyCode: string;
  countryName: string;
  /** For the accessible label, e.g. "Nigerian Naira". */
  currencyName?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Change currency, currently ${currencyName ?? currencyCode}`}
      className={`${PILL} border-edge bg-pill pl-[9px] sm:pl-2.5`}
    >
      <Flag countryCode={countryCode} />
      <span className="flex flex-col items-start leading-[1.15]">
        <span className="text-sm font-semibold sm:text-[15px]">
          {currencyCode}
        </span>
        <span className="text-[11px] text-muted sm:text-xs">{countryName}</span>
      </span>
      <ChevronDown />
    </button>
  );
}

/* ------------------------------------------------------------------------ */
/* Summary + rate                                                            */
/* ------------------------------------------------------------------------ */

export type SummaryRow = {
  label: React.ReactNode;
  value: React.ReactNode;
  /** The bold total row with a line above it. */
  total?: boolean;
};

/** Label/value rows on the soft background (fee, total, …). */
export function SummaryRows({
  rows,
  className = "",
}: {
  rows: SummaryRow[];
  className?: string;
}) {
  return (
    <dl
      className={`flex flex-col gap-2.5 rounded-2xl border border-edge bg-subtle px-5 py-3 text-sm ${className}`}
    >
      {rows.map((row, i) => (
        <div
          key={i}
          className={`flex justify-between gap-3 ${
            row.total ? "border-t border-edge pt-2.5" : ""
          }`}
        >
          <dt className={row.total ? "font-medium" : "text-muted"}>
            {row.label}
          </dt>
          <dd className={`m-0 ${row.total ? "font-semibold" : "font-medium"}`}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** "1 USDC = 1,375.32 NGN" line between the two amount cards. */
export function RateLine({
  rate,
  right,
  approximate = false,
}: {
  /** e.g. "1 USDC" and "1,375.32 NGN". */
  rate: { from: string; to: string } | null;
  right?: React.ReactNode;
  /** Use ≈ instead of = (ChainRails rates are indicative). */
  approximate?: boolean;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 px-1 py-2 text-[13px] text-muted sm:px-1.5">
      <span className="flex items-center gap-1.5">
        <RefreshIcon />
        {rate ? (
          <span>
            {rate.from} {approximate ? "≈" : "="}{" "}
            <strong className="font-semibold text-ink">{rate.to}</strong>
          </span>
        ) : (
          <span>Fetching the live rate…</span>
        )}
      </span>
      {right && <span>{right}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Buttons + notices                                                         */
/* ------------------------------------------------------------------------ */

/**
 * The 52px primary button. When it can't proceed it says why (`label` is the
 * reason, e.g. "Enter an amount") rather than sitting silently disabled.
 */
export function PrimaryButton({
  children,
  onClick,
  disabled = false,
  loading = false,
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
}) {
  const off = disabled || loading;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={off}
      className={`mt-4 flex h-[52px] w-full items-center justify-center gap-2 rounded-button text-base font-semibold ${
        off
          ? "cursor-not-allowed bg-disabled text-muted"
          : "cursor-pointer bg-ink text-white hover:bg-black"
      } ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

/** Small reassurance line under the button (shield icon). */
export function Reassurance({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[13px] text-muted">
      <ShieldIcon />
      {children}
    </p>
  );
}

/**
 * Inline notice. "warning" is the amber box (zero balance); "info" is the blue
 * box (ChainRails identity check); "error" is red text.
 */
export function Notice({
  tone,
  title,
  children,
  actions,
}: {
  tone: "warning" | "info" | "error";
  title?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  if (tone === "error") {
    return (
      <div role="alert" className="flex items-center gap-1.5 text-[13px] text-danger">
        <AlertIcon />
        <span>
          {title && <strong className="font-semibold">{title} </strong>}
          {children}
        </span>
      </div>
    );
  }
  if (tone === "info") {
    return (
      <div
        role="note"
        className="mt-3 flex items-start gap-2.5 rounded-[14px] bg-info-bg px-3.5 py-3 text-[13px] leading-[1.45] text-info-ink"
      >
        <span className="mt-px flex-none">
          <ShieldIcon />
        </span>
        <span>
          {title && (
            <strong className="font-semibold text-info-strong">{title} </strong>
          )}
          {children}
        </span>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="mt-1.5 flex items-start gap-2.5 rounded-[14px] bg-warn-bg p-3 text-[13px] leading-[1.45] text-warn-ink"
    >
      <span className="mt-px flex-none">
        <AlertIcon />
      </span>
      <div className="flex min-w-0 flex-col gap-2.5">
        <div>
          {title && (
            <strong className="font-semibold text-warn-strong">{title} </strong>
          )}
          {children}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Icons (stroke icons from the design files)                                */
/* ------------------------------------------------------------------------ */

function Svg({
  size = 16,
  children,
  strokeWidth = 2,
}: {
  size?: number;
  children: React.ReactNode;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function ChevronDown() {
  return (
    <span className="text-muted">
      <Svg>
        <path d="M6 9l6 6 6-6" />
      </Svg>
    </span>
  );
}

export function ChevronLeft() {
  return (
    <Svg size={18}>
      <path d="M15 18l-6-6 6-6" />
    </Svg>
  );
}

export function ArrowRight() {
  return (
    <Svg size={18}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </Svg>
  );
}

export function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <Svg size={size} strokeWidth={3}>
      <path d="M5 12l5 5L20 7" />
    </Svg>
  );
}

function RefreshIcon() {
  return (
    <Svg size={14}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </Svg>
  );
}

function ShieldIcon() {
  return (
    <Svg size={14}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Svg>
  );
}

function AlertIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </Svg>
  );
}

function Spinner() {
  return (
    <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
  );
}
