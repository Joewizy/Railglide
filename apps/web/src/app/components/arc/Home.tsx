"use client";

/**
 * Home.tsx — the "what do you want to do?" entry chooser.
 *
 * The single front door for the Send experience. Instead of dropping the
 * user into a crypto swap form, it frames three plain-language goals and a
 * natural-language box. Both paths converge on the same quote → confirm →
 * execute flow downstream (today: the existing SendScreen; the per-goal
 * guided flows replace its body in Phase 2).
 *
 * Rails (CCTP / Paycrest / Relay / Chainrails) are never named here.
 */

import React from "react";
import { Icon } from "./icons";
import type { FlowId } from "@/assistant/types";

// Canonical FlowId now lives in @railglide/shared; re-export it here so the
// existing `./Home` importers (AppShell, AssistantChat, swapUrl) keep working.
export type { FlowId };

type Goal = {
  id: FlowId;
  title: string;
  sub: string;
  glyph: React.ReactNode;
};

const GOALS: Goal[] = [
  {
    id: "cashout",
    title: "Sell",
    sub: "Paid out to your bank or mobile money",
    glyph: (
      <svg viewBox="0 0 32 32" width="24" height="24" fill="none" aria-hidden>
        <path
          d="M4 13L16 6l12 7M6 13v11h20V13M10 24v-6M16 24v-6M22 24v-6M3 26h26"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    id: "buy",
    title: "Buy crypto",
    sub: "With your local currency (fiat)",
    glyph: (
      <svg viewBox="0 0 32 32" width="24" height="24" fill="none" aria-hidden>
        <circle cx="16" cy="16" r="11" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M16 9v14M12 12.5h6.5a2.5 2.5 0 0 1 0 5H13a2.5 2.5 0 0 0 0 5h7"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    id: "bridge",
    title: "Bridge/Swap",
    sub: "Swap tokens or move to another chain",
    glyph: (
      <svg viewBox="0 0 32 32" width="24" height="24" fill="none" aria-hidden>
        <path
          d="M6 11h18l-4-4M26 21H8l4 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

export function Home({
  onPick,
}: {
  /** flow = a chosen goal card; "describe" = the natural-language path. */
  onPick: (flow: FlowId | "describe") => void;
}) {
  return (
    <div className="col gap-6">
      <header style={{ marginBottom: 4 }}>
        <h1
          style={{
            fontSize: 30,
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
            fontWeight: 500,
          }}
        >
          What would you like to do?
        </h1>
        <span className="muted" style={{ fontSize: 14, marginTop: 2 }}>
          Pick a goal, or just describe it in your own words.
        </span>
      </header>

      {/* goal grid — auto-fit reflows from 1 col (phone) to 2 (wider) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 12,
        }}
      >
        {GOALS.map((g) => (
          <button
            key={g.id}
            onClick={() => onPick(g.id)}
            className="card row center gap-3"
            style={{
              padding: 18,
              textAlign: "left",
              cursor: "pointer",
              border: "1px solid var(--line)",
              transition: "border-color .12s, background .12s",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.borderColor = "var(--line-2)";
              e.currentTarget.style.background = "var(--bg-soft)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.borderColor = "var(--line)";
              e.currentTarget.style.background = "";
            }}
          >
            <span
              style={{
                width: 44,
                height: 44,
                flex: "0 0 44px",
                borderRadius: 12,
                background: "var(--accent-soft)",
                color: "var(--accent)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {g.glyph}
            </span>
            <span className="col" style={{ gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 16, fontWeight: 500 }}>{g.title}</span>
              <span className="muted" style={{ fontSize: 13 }}>
                {g.sub}
              </span>
            </span>
            <Icon.ArrowRight size={14} />
          </button>
        ))}
      </div>

      {/* natural-language path */}
      <button
        onClick={() => onPick("describe")}
        className="card row center gap-3"
        style={{
          padding: 16,
          cursor: "pointer",
          border: "1px dashed var(--line-2)",
          background: "var(--bg-soft)",
        }}
        onMouseOver={(e) =>
          (e.currentTarget.style.borderColor = "var(--accent)")
        }
        onMouseOut={(e) =>
          (e.currentTarget.style.borderColor = "var(--line-2)")
        }
      >
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: "50%",
            background: "var(--accent)",
            color: "var(--accent-fg, #fff)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "0 0 30px",
          }}
        >
          <Icon.Sparkle size={13} />
        </span>
        <span className="col" style={{ gap: 2, textAlign: "left", flex: 1 }}>
          <span style={{ fontSize: 15, fontWeight: 500 }}>
            Tell us what you want to do
          </span>
          <span className="muted" style={{ fontSize: 13 }}>
            Try “cash out 100 USDC to my bank account.”
          </span>
        </span>
        <Icon.ArrowRight size={14} />
      </button>
    </div>
  );
}
