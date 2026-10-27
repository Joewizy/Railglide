"use client";

/**
 * Bank + account number + the holder's name, looked up from
 * the bank. Used for the Sell payout account and the Buy refund account.
 *
 * Calls /api/paycrest/institutions for the bank list (cached an hour) and
 * /api/paycrest/verify-account for the name. When the bank confirms the
 * account but won't share the name, the user types it.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { cachedFetch, ONE_HOUR } from "@/lib/cachedFetch";
import { titleCase } from "@/utils";
import type { PayoutDetails } from "../SendScreen";
import { CheckIcon, ChevronDown, Notice } from "./sendKit";
import { PickerSheet, type PickerGroup } from "./PickerSheet";

type Institution = { name: string; code: string; type: string };

/** Where the name lookup is up to. */
export type LookupState = "idle" | "checking" | "found" | "no-name" | "error";

export const EMPTY_ACCOUNT: PayoutDetails = {
  institution: "",
  institutionName: "",
  accountIdentifier: "",
  accountName: "",
};

/** What's still missing, in order — for the button label. Null when ready. */
export function accountBlocker(
  value: PayoutDetails,
  lookup: LookupState
): string | null {
  if (!value.institution) return "Choose a bank";
  if (value.accountIdentifier.trim().length < 6) return "Enter the account number";
  if (lookup === "checking") return "Checking account…";
  if (lookup === "error") return "Check the account details";
  if (!value.accountName.trim()) return "Enter the account name";
  return null;
}

const INPUT =
  "h-12 w-full rounded-[14px] border border-edge bg-card px-3.5 text-base font-medium text-ink outline-none placeholder:font-normal placeholder:text-muted focus:border-ink focus:shadow-[0_0_0_3px_rgba(23,23,26,0.08)]";

/** Banks for a currency, from our Paycrest proxy. */
function useInstitutions(currency: string | null) {
  const [list, setList] = useState<Institution[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!currency) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    cachedFetch(
      `/api/paycrest/institutions?currency=${encodeURIComponent(currency)}`,
      {},
      ONE_HOUR
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
        if (!cancelled) setList(data.institutions ?? []);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Couldn't load banks.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currency]);
  return { list, loading, error };
}

export function BankAccountFields({
  id,
  currency,
  value,
  onChange,
  onLookupChange,
  wrongLabel,
}: {
  /** Prefix for input ids, so two of these can share a page. */
  id: string;
  currency: string | null;
  value: PayoutDetails;
  onChange: (next: PayoutDetails) => void;
  onLookupChange: (state: LookupState) => void;
  /** Link that clears the number, e.g. "Not them?". */
  wrongLabel: string;
}) {
  const banks = useInstitutions(currency);
  const [bankOpen, setBankOpen] = useState(false);
  const accountRef = useRef<HTMLInputElement>(null);

  // Look up the holder's name once a bank and account number are both in.
  const [lookup, setLookupState] = useState<LookupState>("idle");
  const [lookupError, setLookupError] = useState("");
  const setLookup = (state: LookupState) => {
    setLookupState(state);
    onLookupChange(state);
  };
  const acct = value.accountIdentifier.trim();
  useEffect(() => {
    if (!value.institution || acct.length < 6) {
      setLookup("idle");
      if (value.accountName) onChange({ ...value, accountName: "" });
      return;
    }
    let cancelled = false;
    setLookup("checking");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/paycrest/verify-account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            institution: value.institution,
            accountIdentifier: acct,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && data?.accountName) {
          setLookup("found");
          onChange({ ...value, accountName: data.accountName });
        } else if (data?.needsName) {
          setLookup("no-name");
          onChange({ ...value, accountName: "" });
        } else {
          setLookupError(data?.error || "Couldn't verify this account.");
          setLookup("error");
          onChange({ ...value, accountName: "" });
        }
      } catch {
        if (cancelled) return;
        setLookupError("Couldn't reach the verification service.");
        setLookup("error");
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Only re-check when the bank or number changes; the name is set here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.institution, acct]);

  const bankGroups = useMemo<PickerGroup[]>(
    () => [
      {
        label: "Banks",
        items: banks.list.map((b) => ({
          value: b.code,
          title: b.name,
          trailing: b.type === "mobile_money" ? "Mobile money" : "Bank",
          logo: <BankTile name={b.name} />,
        })),
      },
    ],
    [banks.list]
  );
  const selectedBank = banks.list.find((b) => b.code === value.institution);
  const name = value.accountName.trim();

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span id={`${id}-bank-label`} className="text-[13px] font-medium text-muted">
          Bank
        </span>
        <div className="relative">
          <button
            type="button"
            aria-labelledby={`${id}-bank-label ${id}-bank-value`}
            aria-haspopup="listbox"
            disabled={banks.loading || !!banks.error}
            onClick={() => setBankOpen((v) => !v)}
            className="flex h-12 w-full items-center gap-3 rounded-[14px] border border-edge bg-card px-3.5 text-left disabled:cursor-wait"
          >
            {value.institution ? <BankTile name={value.institutionName} /> : null}
            <span
              id={`${id}-bank-value`}
              className={`flex-1 truncate text-[15px] ${
                value.institution ? "font-medium" : "text-muted"
              }`}
            >
              {value.institution
                ? value.institutionName
                : banks.loading
                  ? "Loading banks…"
                  : banks.error
                    ? "Couldn't load banks"
                    : "Choose a bank"}
            </span>
            {selectedBank && (
              <span className="text-xs text-muted">
                {selectedBank.type === "mobile_money" ? "Mobile money" : "Bank"}
              </span>
            )}
            <ChevronDown />
          </button>
          <PickerSheet
            open={bankOpen}
            onClose={() => setBankOpen(false)}
            title="Choose a bank"
            groups={bankGroups}
            value={value.institution}
            searchPlaceholder="Search banks"
            onSelect={(code) => {
              const b = banks.list.find((i) => i.code === code);
              onChange({ ...value, institution: code, institutionName: b?.name ?? "" });
            }}
          />
        </div>
        {banks.error && <Notice tone="error">{banks.error}</Notice>}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-acct`} className="text-[13px] font-medium text-muted">
          Account number
        </label>
        <input
          ref={accountRef}
          id={`${id}-acct`}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="e.g. 0123456789"
          value={value.accountIdentifier}
          onChange={(e) => onChange({ ...value, accountIdentifier: e.target.value })}
          className={`${INPUT} tracking-[0.02em] placeholder:tracking-normal`}
        />
      </div>

      {lookup === "checking" && (
        <p className="flex items-center gap-2 text-[13px] text-muted">
          <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Checking account…
        </p>
      )}
      {lookup === "error" && (
        <Notice tone="error">{lookupError} Check the number and the bank.</Notice>
      )}
      {lookup === "found" && name && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-[14px] border border-[#bfdccb] bg-[#eef6f1] p-3.5"
        >
          <span className="grid size-6 flex-none place-items-center rounded-full bg-success text-white">
            <CheckIcon size={13} />
          </span>
          <span className="min-w-0 flex-1 pt-0.5 text-[15px] font-semibold text-[#134a30]">
            {titleCase(name)}
          </span>
          <button
            type="button"
            onClick={() => {
              onChange({ ...value, accountIdentifier: "", accountName: "" });
              accountRef.current?.focus();
            }}
            className="flex-none pt-0.5 text-[13px] font-semibold text-[#134a30] underline underline-offset-2"
          >
            {wrongLabel}
          </button>
        </div>
      )}
      {lookup === "no-name" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className="text-[13px] font-medium text-muted">
            Account holder&apos;s name
          </label>
          <input
            id={`${id}-name`}
            type="text"
            autoComplete="off"
            placeholder="Name on the account"
            value={value.accountName}
            onChange={(e) => onChange({ ...value, accountName: e.target.value })}
            className={INPUT}
          />
          <span className="text-[13px] text-muted">
            {value.institutionName || "The provider"} found this account but
            didn&apos;t share the name. Type it as it appears on the account.
          </span>
        </div>
      )}
    </>
  );
}

/** Letter tile standing in for a bank logo. */
export function BankTile({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid size-7 flex-none place-items-center rounded-lg bg-chip text-[13px] font-bold text-ink-soft"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
