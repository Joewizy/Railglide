"use client";

/**
 * "Your details" on the Buy review step: date of birth plus NIN for
 * Nigeria, or an ID document elsewhere (and an M-Pesa number for Kenya).
 * Every Buy order needs these. If "Remember" is on (the default) they're saved
 * in this browser, so a returning buyer sees them already filled in.
 */

import React, { useState } from "react";
import {
  BUYER_ID_TYPES,
  XOF_COUNTRIES,
  buyerDetailsNote,
  needsKenyanPhone,
  asksForNin,
  buyerDetailsSummary,
  checkBuyerDetails,
  type BuyerDetails,
  type BuyerIdType,
} from "@railglide/shared/kyc";
import { ChevronDown } from "./ui/sendKit";

const INPUT =
  "h-12 w-full rounded-[14px] border border-edge bg-card px-3.5 text-[15px] text-ink outline-none placeholder:text-muted focus:border-ink focus:shadow-[0_0_0_3px_rgba(23,23,26,0.08)]";

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Small red hint once an 11-digit number has been typed but is the wrong length. */
function elevenDigitHint(value: string | undefined, name: string) {
  const digits = (value ?? "").replace(/[\s-]/g, "");
  if (!digits || /^\d{11}$/.test(digits)) return null;
  return <span className="text-[13px] text-danger">{name} must be 11 digits.</span>;
}

export function BuyerDetailsForm({
  currency,
  value,
  onChange,
  remember,
  onRememberChange,
  saved,
}: {
  currency: string;
  value: BuyerDetails;
  onChange: (next: BuyerDetails) => void;
  /** Save these details in this browser for next time. */
  remember: boolean;
  onRememberChange: (remember: boolean) => void;
  /** The details were loaded from this device — start collapsed. */
  saved: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isNigeria = asksForNin(currency);
  const isKenya = needsKenyanPhone(currency);
  const isXof = currency.toUpperCase() === "XOF";
  const set = (patch: Partial<BuyerDetails>) => onChange({ ...value, ...patch });

  // Saved and still valid for this currency → one tidy row the buyer can open.
  // If something's missing (e.g. they switched currency) the form stays open.
  const complete = checkBuyerDetails(currency, value).length === 0;
  if (saved && complete && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-3 rounded-[14px] border border-edge bg-card px-3.5 py-3 text-left"
      >
        <span className="flex flex-col gap-0.5">
          <span className="text-[15px] font-medium">
            {buyerDetailsSummary(currency, value)}
          </span>
          <span className="text-[13px] text-muted">
            Saved on this device · View or change
          </span>
        </span>
        <ChevronDown />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {saved && complete && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="self-start text-[13px] font-semibold underline underline-offset-2"
        >
          Hide details
        </button>
      )}
      <p className="text-[13px] leading-[1.45] text-muted">
        {buyerDetailsNote(currency)}
      </p>

      <Field id="buyer-dob" label="Date of birth">
        <input
          id="buyer-dob"
          type="date"
          value={value.birthDate}
          onChange={(e) => set({ birthDate: e.target.value })}
          className={INPUT}
        />
      </Field>

      {isNigeria ? (
        <Field id="buyer-nin" label="NIN">
          <input
            id="buyer-nin"
            value={value.nin ?? ""}
            onChange={(e) => set({ nin: e.target.value })}
            placeholder="11-digit National Identification Number"
            inputMode="numeric"
            maxLength={13}
            autoComplete="off"
            className={INPUT}
          />
          {elevenDigitHint(value.nin, "NIN")}
        </Field>
      ) : (
        <>
          <Field id="buyer-id-type" label="ID type">
            <select
              id="buyer-id-type"
              value={value.idType ?? ""}
              onChange={(e) =>
                set({ idType: (e.target.value || undefined) as BuyerIdType })
              }
              className={`${INPUT} cursor-pointer`}
            >
              <option value="">Select an ID</option>
              {BUYER_ID_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="buyer-id-number" label="ID number">
            <input
              id="buyer-id-number"
              value={value.idNumber ?? ""}
              onChange={(e) => set({ idNumber: e.target.value })}
              placeholder="As shown on your ID"
              autoComplete="off"
              className={INPUT}
            />
          </Field>
          {isXof && (
            <Field id="buyer-id-country" label="Country that issued your ID">
              <select
                id="buyer-id-country"
                value={value.idCountry ?? ""}
                onChange={(e) => set({ idCountry: e.target.value })}
                className={`${INPUT} cursor-pointer`}
              >
                <option value="">Select a country</option>
                {XOF_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}

      {isKenya && (
        <Field id="buyer-phone" label="M-Pesa phone number">
          <input
            id="buyer-phone"
            value={value.phone ?? ""}
            onChange={(e) => set({ phone: e.target.value })}
            placeholder="0712 345 678"
            inputMode="tel"
            className={INPUT}
          />
        </Field>
      )}

      <label className="flex min-h-11 cursor-pointer select-none items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => onRememberChange(e.target.checked)}
          className="size-[18px] accent-ink"
        />
        <span className="flex flex-col">
          <span>Save my details for next time</span>
          <span className="text-[13px] text-muted">Kept only on this device</span>
        </span>
      </label>
    </div>
  );
}
