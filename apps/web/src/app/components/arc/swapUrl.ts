import type { ChatMessage, ChatReply, FlowLaunch } from "@/assistant/types";
import type { FlowId } from "./Home";
import type { Intent, PayoutDetails, Quote } from "./SendScreen";

export type SwapView = "send" | "history" | "recipients";
export type FlowStep = "compose" | "review";

const FLOW_IDS = new Set<string>(["cashout", "buy", "bridge", "describe"]);
const VIEW_IDS = new Set<string>(["history", "recipients"]);

export const SWAP_INTENT_STORAGE_KEY = "railglide:intent";
export const SWAP_FLOW_DRAFT_KEY = "railglide:flow-draft";
export const PENDING_LAUNCH_KEY = "railglide:pending-launch";
export const CHAT_STATE_KEY = "railglide:chat-state";

/** Persisted chat transcript so the conversation survives a refresh. */
export type ChatState = { messages: ChatMessage[]; lastReply: ChatReply | null };

/** Persisted guided-flow state (cash out / buy) so review survives refresh. */
export type FlowDraft = {
  flow: "cashout" | "buy";
  amount: string;
  currency: string;
  token?: string;
  quote: Quote;
  label: string;
  payout?: PayoutDetails;
  /** When this draft was last persisted; used to re-fetch stale rates. */
  ts?: number;
};

/** True when a restored draft's rate is old enough to be worth re-fetching. */
export const RATE_STALE_MS = 60_000;

export function isDraftStale(draft: FlowDraft, now = Date.now()): boolean {
  return !draft.ts || now - draft.ts > RATE_STALE_MS;
}

export function parseFlow(
  raw: string | null
): FlowId | "describe" | null {
  if (raw && FLOW_IDS.has(raw)) return raw as FlowId | "describe";
  return null;
}

export function parseView(raw: string | null): SwapView {
  if (raw && VIEW_IDS.has(raw)) return raw as SwapView;
  return "send";
}

export function parseStep(raw: string | null): FlowStep {
  return raw === "review" ? "review" : "compose";
}

/** Apply a partial update to the current /swap query string. */
export function mergeSwapSearchParams(
  current: URLSearchParams,
  patch: {
    view?: SwapView | null;
    flow?: FlowId | "describe" | null;
    status?: boolean | null;
    step?: FlowStep | null;
    /** ChainRails Sell order being resumed — keeps refresh on the deposit screen. */
    crOrder?: string | null;
  }
): string {
  const params = new URLSearchParams(current.toString());

  if (patch.view !== undefined) {
    if (patch.view === null || patch.view === "send") params.delete("view");
    else params.set("view", patch.view);
  }
  if (patch.flow !== undefined) {
    if (patch.flow === null) params.delete("flow");
    else params.set("flow", patch.flow);
  }
  if (patch.status !== undefined) {
    if (patch.status) params.set("status", "1");
    else params.delete("status");
  }
  if (patch.step !== undefined) {
    if (patch.step === null || patch.step === "compose") params.delete("step");
    else params.set("step", patch.step);
  }
  if (patch.crOrder !== undefined) {
    if (patch.crOrder === null) params.delete("crOrder");
    else params.set("crOrder", patch.crOrder);
  }

  return params.toString();
}

export function loadStoredIntent(): Intent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SWAP_INTENT_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Intent;
  } catch {
    return null;
  }
}

export function storeIntent(intent: Intent): void {
  try {
    sessionStorage.setItem(SWAP_INTENT_STORAGE_KEY, JSON.stringify(intent));
  } catch {
    // sessionStorage unavailable — status won't survive refresh
  }
}

export function clearStoredIntent(): void {
  try {
    sessionStorage.removeItem(SWAP_INTENT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function loadFlowDraft(): FlowDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SWAP_FLOW_DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as FlowDraft;
  } catch {
    return null;
  }
}

export function storeFlowDraft(draft: FlowDraft): void {
  try {
    const stamped: FlowDraft = { ...draft, ts: Date.now() };
    sessionStorage.setItem(SWAP_FLOW_DRAFT_KEY, JSON.stringify(stamped));
  } catch {
    // ignore
  }
}

export function clearFlowDraft(): void {
  try {
    sessionStorage.removeItem(SWAP_FLOW_DRAFT_KEY);
  } catch {
    // ignore
  }
}

// --- compose-step inputs (survive refresh / back) -----------------------

/**
 * Raw compose-form inputs, persisted as the user types so a refresh — or a trip
 * back to Home and into the flow again — doesn't wipe a half-filled form. Kept
 * per flow, and cleared once the order is submitted. The richer {@link FlowDraft}
 * takes over on the review step (it carries the built quote); this is only the
 * lightweight "what they'd typed so far" before a quote exists.
 */
export type ComposeDraft = {
  amount?: string;
  currency?: string;
  token?: string;
  /** Buy: the receive network. Sell: the source chain. A ChainId. */
  chain?: string;
  /** ChainRails corridor chain, set when a non-Paycrest destination is picked. */
  crChain?: string;
  /** Country picked from "More countries" (ChainRails currency), e.g. "IN". */
  payCountry?: string;
};

type ComposeFlow = "buy" | "cashout";
const composeKey = (flow: ComposeFlow) => `railglide:compose:${flow}`;

export function loadComposeDraft(flow: ComposeFlow): ComposeDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(composeKey(flow));
    return raw ? (JSON.parse(raw) as ComposeDraft) : null;
  } catch {
    return null;
  }
}

export function storeComposeDraft(flow: ComposeFlow, draft: ComposeDraft): void {
  try {
    sessionStorage.setItem(composeKey(flow), JSON.stringify(draft));
  } catch {
    // sessionStorage unavailable — the form just won't survive refresh.
  }
}

export function clearComposeDraft(flow: ComposeFlow): void {
  try {
    sessionStorage.removeItem(composeKey(flow));
  } catch {
    // ignore
  }
}

/**
 * ChainRails ramp-panel inputs (the fiat amount, country, and dynamic provider
 * fields the panel collects for chains Paycrest can't reach). Kept per corridor
 * chain so switching destinations doesn't cross-contaminate, and cleared once a
 * quote is built. Survives refresh / back like {@link ComposeDraft}.
 */
export type ChainrailsRampDraft = {
  amount?: string;
  countryCode?: string;
  fields?: Record<string, string>;
};

const crRampKey = (chain: string) => `railglide:cr-ramp:${chain}`;

export function loadChainrailsRampDraft(
  chain: string
): ChainrailsRampDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(crRampKey(chain));
    return raw ? (JSON.parse(raw) as ChainrailsRampDraft) : null;
  } catch {
    return null;
  }
}

export function storeChainrailsRampDraft(
  chain: string,
  draft: ChainrailsRampDraft
): void {
  try {
    sessionStorage.setItem(crRampKey(chain), JSON.stringify(draft));
  } catch {
    // sessionStorage unavailable — the panel just won't survive refresh.
  }
}

export function clearChainrailsRampDraft(chain: string): void {
  try {
    sessionStorage.removeItem(crRampKey(chain));
  } catch {
    // ignore
  }
}

/** One-shot buffer while navigating chat → guided flow. */
export function savePendingLaunch(launch: FlowLaunch): void {
  try {
    sessionStorage.setItem(PENDING_LAUNCH_KEY, JSON.stringify(launch));
  } catch {
    // ignore
  }
}

export function loadPendingLaunch(): FlowLaunch | null {
  if (typeof window === "undefined") return null;
  try {
    const raw =
      sessionStorage.getItem(PENDING_LAUNCH_KEY) ??
      sessionStorage.getItem("railglide:flow-launch");
    return raw ? (JSON.parse(raw) as FlowLaunch) : null;
  } catch {
    return null;
  }
}

export function clearPendingLaunch(): void {
  try {
    sessionStorage.removeItem(PENDING_LAUNCH_KEY);
    sessionStorage.removeItem("railglide:flow-launch");
  } catch {
    // ignore
  }
}

// --- chat transcript (survives refresh) ---------------------------------

export function storeChatState(state: ChatState): void {
  try {
    sessionStorage.setItem(CHAT_STATE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function migrateChatReply(
  reply: ChatReply & {
    targetFlow?: FlowId | null;
    seed?: FlowLaunch;
  }
): ChatReply {
  if (reply.launch) return reply;
  if (reply.targetFlow) {
    return {
      ...reply,
      launch: { flow: reply.targetFlow, ...(reply.seed ?? {}) },
    };
  }
  return reply;
}

export function loadChatState(): ChatState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(CHAT_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChatState & { lastTurn?: ChatReply | null };
    const lastReply = parsed.lastReply ?? parsed.lastTurn ?? null;
    if (!parsed.messages) return null;
    return {
      messages: parsed.messages,
      lastReply: lastReply ? migrateChatReply(lastReply) : null,
    };
  } catch {
    return null;
  }
}

export function clearChatState(): void {
  try {
    sessionStorage.removeItem(CHAT_STATE_KEY);
  } catch {
    // ignore
  }
}
