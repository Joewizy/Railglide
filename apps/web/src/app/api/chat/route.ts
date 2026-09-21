import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import type { ChatMessage, ChatReply, FlowLaunch, FlowSeed } from "@/assistant/types";
import {
  buildAssistantSystemPrompt,
  isSettlementToken,
} from "@/assistant/productRules";
import { fetchPaycrestUnitRate, type PaycrestFiat } from "@/rails/paycrest";

const apiKey = process.env.GEMINI_API_KEY;
const primaryModel = "gemini-3.6-flash";
const fallbackModel = "gemini-3.5-flash";

if (!apiKey) {
  console.error("[chat] GEMINI_API_KEY is not configured; chat requests will be unavailable.");
}

const client = apiKey ? new GoogleGenAI({ apiKey }) : null;

const seedSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    amount: { type: ["string", "null"] },
    token: { type: ["string", "null"] },
    fromToken: { type: ["string", "null"] },
    toToken: { type: ["string", "null"] },
    currency: { type: ["string", "null"] },
    chain: { type: ["string", "null"] },
    recipientHint: { type: ["string", "null"] },
    institutionHint: { type: ["string", "null"] },
  },
  required: [
    "amount",
    "token",
    "fromToken",
    "toToken",
    "currency",
    "chain",
    "recipientHint",
    "institutionHint",
  ],
} as const;

const chatSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: {
      type: "string",
      description: "User-facing assistant reply — warm, specific, conversational.",
    },
    status: {
      type: "string",
      enum: ["clarifying", "ready", "unsupported"],
    },
    launch: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        flow: {
          type: "string",
          enum: ["cashout", "buy", "bridge"],
        },
        seed: seedSchema,
      },
      required: ["flow", "seed"],
    },
    plan: {
      type: "array",
      items: { type: "string" },
    },
    missing: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["message", "status", "launch", "plan", "missing"],
} as const;

type RawSeed = {
  amount: string | null;
  token: string | null;
  fromToken: string | null;
  toToken: string | null;
  currency: string | null;
  chain: string | null;
  recipientHint: string | null;
  institutionHint: string | null;
};

type RawReply = {
  message: string;
  status: "clarifying" | "ready" | "unsupported";
  launch: { flow: "cashout" | "buy" | "bridge"; seed: RawSeed } | null;
  plan: string[];
  missing: string[];
};

function normaliseSeed(raw: RawSeed): FlowSeed {
  const pick = (v: string | null) => (v && v.trim() ? v.trim() : undefined);
  return {
    amount: pick(raw.amount),
    token: pick(raw.token)?.toUpperCase(),
    fromToken: pick(raw.fromToken)?.toUpperCase(),
    toToken: pick(raw.toToken)?.toUpperCase(),
    currency: pick(raw.currency)?.toUpperCase(),
    chain: pick(raw.chain)?.toLowerCase(),
    recipientHint: pick(raw.recipientHint),
    institutionHint: pick(raw.institutionHint)?.toLowerCase(),
  };
}

function normaliseReply(raw: RawReply): ChatReply {
  let launch: FlowLaunch | undefined;
  let message = raw.message;
  let plan = raw.plan ?? [];

  if (raw.status === "ready" && raw.launch?.flow) {
    launch = { flow: raw.launch.flow, ...normaliseSeed(raw.launch.seed) };

    // Safety net over the prompt: the model sometimes invents a USDC↔USDT
    // "swap" when the user just wants to cash out a stablecoin. Two settlement
    // tokens is never a real swap — reroute straight to cashout and drop the
    // bogus swap step and message.
    if (
      launch.flow === "bridge" &&
      isSettlementToken(launch.fromToken) &&
      isSettlementToken(launch.toToken)
    ) {
      const token = launch.fromToken;
      launch = { ...launch, flow: "cashout", token, fromToken: undefined, toToken: undefined };
      plan = [];
      message = `You can cash out your ${token} directly — no swap needed. Let's set it up.`;
    }
  }

  return {
    message,
    status: raw.status,
    launch,
    plan,
    missing: raw.missing ?? [],
  };
}

// Map fiat codes + common names/providers to a supported currency.
const FIAT_ALIASES: Record<string, PaycrestFiat> = {
  ngn: "NGN",
  naira: "NGN",
  kes: "KES",
  shilling: "KES",
  shillings: "KES",
  mpesa: "KES",
  "m-pesa": "KES",
  ghs: "GHS",
  cedi: "GHS",
  cedis: "GHS",
  ugx: "UGX",
  xof: "XOF",
  cfa: "XOF",
  zmw: "ZMW",
  kwacha: "ZMW",
  tzs: "TZS",
  zar: "ZAR",
  rand: "ZAR",
};

const RATE_INTENT =
  /\b(rate|rates|worth|how much|price|convert|exchange|equal|value)\b|[=≈]/i;

/**
 * If the latest user message is a rate / "how much" question naming a
 * supported fiat, returns the fiat + token(s) to price so the route can fetch
 * and inject a real number — otherwise the model has no rate data and refuses.
 */
function detectRateQuery(
  text: string
): { fiat: PaycrestFiat; tokens: ("USDC" | "USDT")[] } | null {
  const lower = text.toLowerCase();
  if (!RATE_INTENT.test(lower)) return null;
  let fiat: PaycrestFiat | null = null;
  for (const [alias, code] of Object.entries(FIAT_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(lower)) {
      fiat = code;
      break;
    }
  }
  if (!fiat) return null;
  const tokens: ("USDC" | "USDT")[] = [];
  if (/\busdt\b/.test(lower)) tokens.push("USDT");
  if (/\busdc\b/.test(lower)) tokens.push("USDC");
  if (!tokens.length) tokens.push("USDT", "USDC");
  return { fiat, tokens };
}

/**
 * For a rate question, fetches live rate(s) and returns both a `modelNote`
 * (context for the LLM) and a deterministic `fallback` reply we can serve
 * verbatim if the model flakes — so a rate answer never depends on the LLM.
 * Null when it isn't a rate question.
 */
async function resolveRates(
  text: string
): Promise<{ modelNote: string; fallback: string } | null> {
  const q = detectRateQuery(text);
  if (!q) return null;
  const lines: string[] = [];
  for (const token of q.tokens) {
    const rate = await fetchPaycrestUnitRate(q.fiat, token);
    if (rate) {
      lines.push(
        `1 ${token} ≈ ${rate.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${q.fiat}`
      );
    }
  }
  if (!lines.length) return null;
  return {
    modelNote: `LIVE RATES (estimates; the exact rate locks when an order is created):\n${lines.join("\n")}`,
    fallback: `${lines.join(". ")}. These are estimates that lock when the order is created. Want me to cash some out?`,
  };
}

/** A graceful, schema-valid reply for when the model output can't be used. */
function fallbackReply(message: string): ChatReply {
  return { message, status: "clarifying", launch: undefined, plan: [], missing: [] };
}

function isTransientProviderError(error: unknown) {
  const candidate = error as { status?: number; code?: number; message?: string };
  return (
    candidate.status === 429 ||
    candidate.status === 500 ||
    candidate.status === 503 ||
    candidate.code === 429 ||
    candidate.code === 500 ||
    candidate.code === 503 ||
    /\b(429|500|503)\b|UNAVAILABLE|overloaded|capacity/i.test(candidate.message || "")
  );
}

export async function POST(req: NextRequest) {
  if (!client) {
    console.error("[chat] Request rejected because GEMINI_API_KEY is not configured.");
    return NextResponse.json(
      {
        error:
          "The assistant is taking a quick break. Please try again in a moment.",
      },
      { status: 503 }
    );
  }

  // Declared out here so the catch can still answer a rate question from the
  // live rate even if the model call itself errors or times out.
  let rates: { modelNote: string; fallback: string } | null = null;

  try {
    const body = (await req.json()) as { messages?: ChatMessage[] };
    const messages = body.messages;
    if (!messages?.length) {
      return NextResponse.json(
        { error: "No messages provided" },
        { status: 400 }
      );
    }
    // Cap input size so a single request can't run up an unbounded token bill.
    if (messages.length > 40 || JSON.stringify(messages).length > 12_000) {
      return NextResponse.json(
        { error: "Conversation is too long. Please start a new chat." },
        { status: 413 }
      );
    }

    // If the user is asking a rate/"how much" question, fetch the live rate and
    // give it to the model so it can answer with a real number, not a refusal.
    const lastUser =
      [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    rates = await resolveRates(lastUser);

    const systemInstruction = rates
      ? `${buildAssistantSystemPrompt()}\n\n${rates.modelNote}`
      : buildAssistantSystemPrompt();
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }],
    }));

    // Try the primary model, then the fallback, each with a few retries on
    // transient errors (rate limits, overload) — never on a real rejection.
    let response: Awaited<ReturnType<typeof client.models.generateContent>> | undefined;
    let lastError: unknown;
    for (const modelName of [primaryModel, fallbackModel].filter(
      (value, index, all) => all.indexOf(value) === index
    )) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          response = await client.models.generateContent({
            model: modelName,
            config: {
              systemInstruction,
              temperature: 0.2,
              maxOutputTokens: 800,
              responseMimeType: "application/json",
              responseJsonSchema: chatSchema,
            },
            contents,
          });
          break;
        } catch (error) {
          lastError = error;
          if (!isTransientProviderError(error) || attempt === 3) break;
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
        }
      }
      if (response) break;
    }

    const content = response?.text;
    if (!response) {
      console.error("[chat] Gemini request failed after retries:", lastError);
    }

    // Model output can be empty/non-JSON, or the request can fail outright —
    // never 500 on it; a rate question still gets a real answer from the
    // live rate we already fetched.
    let raw: RawReply | null = null;
    if (content) {
      try {
        raw = JSON.parse(content) as RawReply;
      } catch {
        console.error("[chat] non-JSON model output:", content.slice(0, 200));
      }
    }
    if (!raw) {
      return NextResponse.json(
        rates
          ? fallbackReply(rates.fallback)
          : fallbackReply(
              "Sorry, I didn't quite catch that — could you say it again?"
            )
      );
    }
    return NextResponse.json(normaliseReply(raw));
  } catch (err) {
    // Full detail (status, host, message) stays in the server log for us;
    // the user only ever sees the calm, non-leaky copy below.
    console.error("[chat] error:", err);

    // A rate question can still be answered from the live rate we fetched,
    // even if something above threw (e.g. malformed request body).
    if (rates) {
      return NextResponse.json(fallbackReply(rates.fallback));
    }

    return NextResponse.json(
      { error: "Couldn't process that — please try again." },
      { status: 500 }
    );
  }
}
