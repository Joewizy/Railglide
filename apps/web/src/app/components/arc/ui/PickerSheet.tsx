"use client";

/**
 * Picker shell from the design: a popover under its trigger on desktop, a
 * bottom sheet under 640px. Optional search, grouped rows, full keyboard
 * support (arrows, Enter, Escape, type to search) and combobox/listbox ARIA.
 *
 * The trigger lives outside; render this inside a `relative` wrapper so the
 * desktop popover can anchor to it.
 */

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Under 640px the picker is a bottom sheet. */
function useIsPhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setPhone(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return phone;
}

export type PickerItem = {
  value: string;
  /** Main line, e.g. "Nigeria" or "Base". */
  title: string;
  /** Second line, e.g. "Nigerian Naira". */
  subtitle?: string;
  /** Right-hand text, e.g. "NGN". */
  trailing?: string;
  logo: React.ReactNode;
  /** Extra words the search should match (codes, other names). */
  keywords?: string;
};

export type PickerGroup = { label: string; items: PickerItem[] };

export function PickerSheet({
  open,
  onClose,
  title,
  groups,
  value,
  onSelect,
  searchPlaceholder,
  intro,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  groups: PickerGroup[];
  value: string;
  onSelect: (value: string) => void;
  /** Shows a search box when set. */
  searchPlaceholder?: string;
  /** Content above the list (e.g. a token switch or a short hint). */
  intro?: React.ReactNode;
}) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const phone = useIsPhone();

  // Filter by title, subtitle, code and keywords; drop empty groups. When
  // searching, show one flat result list (no duplicate "Recent" rows).
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups.filter((g) => g.items.length);
    const seen = new Set<string>();
    const hits = groups
      .flatMap((g) => g.items)
      .filter((item) => {
        if (seen.has(item.value)) return false;
        const text = [item.title, item.subtitle, item.trailing, item.keywords]
          .join(" ")
          .toLowerCase();
        if (!text.includes(q)) return false;
        seen.add(item.value);
        return true;
      });
    return hits.length ? [{ label: "Results", items: hits }] : [];
  }, [groups, query]);

  const flat = visible.flatMap((g) => g.items);

  // Fresh state each time it opens; focus the search (or the list).
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const start = groups
      .flatMap((g) => g.items)
      .findIndex((i) => i.value === value);
    setActive(Math.max(0, start));
    requestAnimationFrame(() =>
      (searchRef.current ?? listRef.current)?.focus()
    );
    // Only on open — groups is a fresh array each render and would reset the
    // search while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // Desktop: close on a click outside the popover.
  useEffect(() => {
    if (!open) return;
    // On desktop the trigger sits beside the popover in the same wrapper, so
    // count it as inside — otherwise its own click would close then reopen.
    const onDown = (e: MouseEvent) => {
      const inside = phone
        ? panelRef.current
        : panelRef.current?.parentElement;
      if (!inside?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose, phone]);

  if (!open) return null;

  const pick = (v: string) => {
    onSelect(v);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && flat[active]) {
      e.preventDefault();
      pick(flat[active].value);
    } else if (
      !searchPlaceholder &&
      e.key.length === 1 &&
      /\S/.test(e.key)
    ) {
      // No search box: jump to the first row starting with the typed letter.
      const i = flat.findIndex((item) =>
        item.title.toLowerCase().startsWith(e.key.toLowerCase())
      );
      if (i >= 0) setActive(i);
    }
  };

  const optionId = (i: number) => `${uid}-opt-${i}`;
  let index = -1;

  const sheet = (
    <>
      {/* Mobile backdrop */}
      <div
        aria-hidden
        className="fixed inset-0 z-40 bg-[rgba(23,23,26,0.45)] sm:hidden"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        onKeyDown={onKeyDown}
        className="fixed inset-x-0 bottom-0 z-50 flex h-[88vh] flex-col sm:h-auto rounded-t-[24px] bg-card font-inter text-ink shadow-[0_-8px_32px_rgba(0,0,0,0.12)] sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-[calc(100%+8px)] sm:max-h-[440px] sm:w-[380px] sm:rounded-2xl sm:border sm:border-edge sm:shadow-[0_12px_32px_rgba(0,0,0,0.14)]"
      >
        <div
          aria-hidden
          className="mx-auto mt-2 h-1 w-9 rounded-sm bg-[#d8d3c8] sm:hidden"
        />
        <div className="flex items-center justify-between pl-5 pr-2 pt-1.5 sm:pt-2">
          <h2 id={`${uid}-title`} className="text-lg font-semibold sm:text-base">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-11 place-items-center rounded-xl text-ink hover:bg-pill"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {intro && <div className="px-5 pb-1 pt-1">{intro}</div>}

        {searchPlaceholder && (
          <div className="px-5 pb-1 pt-2">
            <label htmlFor={`${uid}-search`} className="sr-only">
              {searchPlaceholder}
            </label>
            <div className="flex h-12 items-center gap-2.5 rounded-[14px] border border-edge bg-page px-3.5 focus-within:border-ink focus-within:shadow-[0_0_0_3px_rgba(23,23,26,0.08)]">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#5F5C55"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                ref={searchRef}
                id={`${uid}-search`}
                type="search"
                role="combobox"
                aria-expanded="true"
                aria-controls={`${uid}-list`}
                aria-activedescendant={
                  flat[active] ? optionId(active) : undefined
                }
                autoComplete="off"
                placeholder={searchPlaceholder}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[15px] text-ink outline-none placeholder:text-muted"
              />
            </div>
          </div>
        )}

        <div
          ref={listRef}
          id={`${uid}-list`}
          role="listbox"
          aria-label={title}
          tabIndex={searchPlaceholder ? -1 : 0}
          aria-activedescendant={
            !searchPlaceholder && flat[active] ? optionId(active) : undefined
          }
          className="flex-1 overflow-y-auto overscroll-contain pb-6 outline-none sm:pb-2"
        >
          {visible.length === 0 && (
            <p className="px-5 py-6 text-sm text-muted">
              No matches for &ldquo;{query}&rdquo;.
            </p>
          )}
          {visible.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <h3 className="px-5 pb-1 pt-3.5 text-[13px] font-semibold text-muted">
                {group.label}
              </h3>
              {group.items.map((item) => {
                index += 1;
                const i = index;
                const selected = item.value === value;
                return (
                  <div
                    key={`${group.label}-${item.value}`}
                    id={optionId(i)}
                    data-index={i}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(item.value)}
                    className={`flex h-[60px] cursor-pointer items-center gap-3.5 px-5 ${
                      i === active || selected ? "bg-page" : ""
                    }`}
                  >
                    {item.logo}
                    <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                      <span className="truncate text-[15px] font-semibold">
                        {item.title}
                      </span>
                      {item.subtitle && (
                        <span className="truncate text-[13px] text-muted">
                          {item.subtitle}
                        </span>
                      )}
                    </span>
                    {item.trailing && (
                      <span className="text-sm font-semibold text-muted">
                        {item.trailing}
                      </span>
                    )}
                    {selected && (
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M5 12l5 5L20 7" />
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );

  // Phones: render into <body>. Each screen fades in with a CSS transform,
  // and a transformed parent breaks position: fixed for the sheet.
  return phone ? createPortal(sheet, document.body) : sheet;
}
