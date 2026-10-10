"use client";

/**
 * "Your details" on the Buy review step: date of birth plus NIN for
 * Nigeria, or an ID document elsewhere (and an M-Pesa number for Kenya).
 * Every Buy order needs these. If "Remember" is on (the default) they're saved
 * in this browser, so a returning buyer sees them already filled in.
 */

import React, { useState } from "react";
import { Icon } from "./icons";
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

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  background: "var(--bg-soft)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  color: "var(--fg)",
  fontSize: 14,
  outline: "none",
};

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-mono"
      style={{
        fontSize: 10,
        letterSpacing: 0.06,
        color: "var(--fg-mute)",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}

/** Small red hint once an 11-digit number has been typed but is the wrong length. */
function elevenDigitHint(value: string | undefined, name: string) {
  const digits = (value ?? "").replace(/[\s-]/g, "");
  if (!digits || /^\d{11}$/.test(digits)) return null;
  return (
    <span style={{ fontSize: 12, color: "var(--err)" }}>
      {name} must be 11 digits.
    </span>
  );
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
        className="row between center"
        style={{
          ...inputStyle,
          cursor: "pointer",
          textAlign: "left",
          gap: 12,
        }}
      >
        <span className="col" style={{ gap: 2 }}>
          <span style={{ fontSize: 14 }}>
            {buyerDetailsSummary(currency, value)}
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            Saved on this device · View or change
          </span>
        </span>
        <Icon.ChevDown />
      </button>
    );
  }

  return (
    <div className="col gap-3">
      {saved && complete && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="row center gap-1"
          style={{
            alignSelf: "flex-start",
            background: "none",
            border: "none",
            padding: 0,
            color: "var(--accent)",
            cursor: "pointer",
            fontSize: 12.5,
          }}
        >
          Hide details
          <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
            <Icon.ChevDown />
          </span>
        </button>
      )}
      <span className="muted" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
        {buyerDetailsNote(currency)}
      </span>

      <label className="col gap-1">
        <FieldLabel>Date of birth</FieldLabel>
        <input
          type="date"
          value={value.birthDate}
          onChange={(e) => set({ birthDate: e.target.value })}
          style={inputStyle}
        />
      </label>

      {isNigeria ? (
        <>
          <label className="col gap-1">
            <FieldLabel>NIN</FieldLabel>
            <input
              value={value.nin ?? ""}
              onChange={(e) => set({ nin: e.target.value })}
              placeholder="11-digit National Identification Number"
              inputMode="numeric"
              maxLength={13}
              autoComplete="off"
              style={inputStyle}
            />
            {elevenDigitHint(value.nin, "NIN")}
          </label>
        </>
      ) : (
        <>
          <label className="col gap-1">
            <FieldLabel>ID type</FieldLabel>
            <select
              value={value.idType ?? ""}
              onChange={(e) =>
                set({ idType: (e.target.value || undefined) as BuyerIdType })
              }
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              <option value="">Select an ID</option>
              {BUYER_ID_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="col gap-1">
            <FieldLabel>ID number</FieldLabel>
            <input
              value={value.idNumber ?? ""}
              onChange={(e) => set({ idNumber: e.target.value })}
              placeholder="As shown on your ID"
              autoComplete="off"
              style={inputStyle}
            />
          </label>
          {isXof && (
            <label className="col gap-1">
              <FieldLabel>Country that issued your ID</FieldLabel>
              <select
                value={value.idCountry ?? ""}
                onChange={(e) => set({ idCountry: e.target.value })}
                style={{ ...inputStyle, cursor: "pointer" }}
              >
                <option value="">Select a country</option>
                {XOF_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}

      {isKenya && (
        <label className="col gap-1">
          <FieldLabel>M-Pesa phone number</FieldLabel>
          <input
            value={value.phone ?? ""}
            onChange={(e) => set({ phone: e.target.value })}
            placeholder="0712 345 678"
            inputMode="tel"
            style={inputStyle}
          />
        </label>
      )}

      <label
        className="row center gap-2"
        style={{ fontSize: 13, cursor: "pointer", userSelect: "none" }}
      >
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => onRememberChange(e.target.checked)}
          style={{ accentColor: "var(--accent)", width: 16, height: 16 }}
        />
        <span className="col">
          <span>Save my details for next time</span>
          <span className="muted" style={{ fontSize: 12 }}>
            Kept only on this device
          </span>
        </span>
      </label>
    </div>
  );
}
