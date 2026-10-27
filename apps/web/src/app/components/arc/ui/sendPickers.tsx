"use client";

/**
 * The two pickers on the Buy/Sell amount screens, built on PickerSheet:
 *   - CurrencyPicker: one row per country (so each XAF/XOF country is its own
 *     row with its own flag), grouped Recent / Popular / All countries.
 *   - TokenChainPicker: USDC/USDT switch plus every chain with its logo.
 */

import React, { useMemo } from "react";
import { PickerSheet, type PickerGroup } from "./PickerSheet";
import { Flag } from "./sendKit";

export type CountryOption = {
  /** What the flow's chooser understands: a Paycrest code ("NGN") or "cr:CM". */
  value: string;
  countryCode: string;
  countryName: string;
  currencyCode: string;
  currencyName: string;
};

const RECENT_MAX = 3;
const recentKey = (key: string) => `railglide:recent-currency:${key}`;

function loadRecent(key: string): string[] {
  try {
    const raw = localStorage.getItem(recentKey(key));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecent(key: string, value: string): void {
  try {
    const next = [value, ...loadRecent(key).filter((v) => v !== value)];
    localStorage.setItem(
      recentKey(key),
      JSON.stringify(next.slice(0, RECENT_MAX))
    );
  } catch {
    // Storage unavailable — recents just won't stick.
  }
}

export function CurrencyPicker({
  open,
  onClose,
  title,
  value,
  popular,
  all,
  storageKey,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  value: string;
  /** Paycrest corridors, shown first. */
  popular: CountryOption[];
  /** Everything else (ChainRails countries), alphabetical. */
  all: CountryOption[];
  /** Keeps recents separate for Buy and Sell. */
  storageKey: string;
  onSelect: (option: CountryOption) => void;
}) {
  const groups = useMemo<PickerGroup[]>(() => {
    const byValue = new Map(
      [...popular, ...all].map((o) => [o.value, o] as const)
    );
    const toItem = (o: CountryOption) => ({
      value: o.value,
      title: o.countryName,
      subtitle: o.currencyName,
      trailing: o.currencyCode,
      keywords: o.countryCode,
      logo: <Flag countryCode={o.countryCode} className="h-[22px] w-8" />,
    });
    // Recent: what they used last, falling back to the current choice.
    const recentValues = open ? loadRecent(storageKey) : [];
    const recent = (recentValues.length ? recentValues : [value])
      .map((v) => byValue.get(v))
      .filter((o): o is CountryOption => !!o);
    const sortedAll = [...all].sort((a, b) =>
      a.countryName.localeCompare(b.countryName)
    );
    const recentSet = new Set(recent.map((o) => o.value));
    return [
      { label: "Recent", items: recent.map(toItem) },
      // Don't repeat a recent country under Popular (matches the design).
      {
        label: "Popular",
        items: popular.filter((o) => !recentSet.has(o.value)).map(toItem),
      },
      { label: "All countries", items: sortedAll.map(toItem) },
    ];
  }, [open, popular, all, storageKey, value]);

  return (
    <PickerSheet
      open={open}
      onClose={onClose}
      title={title}
      groups={groups}
      value={value}
      searchPlaceholder="Search country or currency"
      onSelect={(v) => {
        const option = [...popular, ...all].find((o) => o.value === v);
        if (!option) return;
        saveRecent(storageKey, v);
        onSelect(option);
      }}
    />
  );
}

export type ChainOption = {
  value: string;
  label: string;
  logo: React.ReactNode;
};

export function TokenChainPicker({
  open,
  onClose,
  title,
  hint,
  token,
  tokens,
  onTokenChange,
  tokenLogo,
  chains,
  value,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Short help line under the token switch. */
  hint?: string;
  token: string;
  tokens: readonly string[];
  onTokenChange: (token: string) => void;
  tokenLogo: (symbol: string) => React.ReactNode;
  chains: ChainOption[];
  value: string;
  onSelect: (value: string) => void;
}) {
  const groups = useMemo<PickerGroup[]>(
    () => [
      {
        label: "Chain",
        items: chains.map((c) => ({
          value: c.value,
          title: c.label,
          logo: (
            <span className="grid size-8 flex-none place-items-center">
              {c.logo}
            </span>
          ),
        })),
      },
    ],
    [chains]
  );

  const intro = (
    <div className="flex flex-col gap-2">
      {tokens.length > 1 && (
        <div
          role="radiogroup"
          aria-label="Token"
          className="flex gap-1 rounded-[14px] bg-page p-1"
        >
          {tokens.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={token === t}
              onClick={() => onTokenChange(t)}
              className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-[10px] text-sm font-semibold ${
                token === t ? "bg-card text-ink shadow-sm" : "text-muted"
              }`}
            >
              {tokenLogo(t)}
              {t}
            </button>
          ))}
        </div>
      )}
      {hint && <p className="text-[13px] leading-snug text-muted">{hint}</p>}
    </div>
  );

  return (
    <PickerSheet
      open={open}
      onClose={onClose}
      title={title}
      groups={groups}
      value={value}
      intro={intro}
      onSelect={onSelect}
    />
  );
}
