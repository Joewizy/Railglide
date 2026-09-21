"use client";

/**
 * AssistantChat — multi-turn conversational entry for the describe flow.
 * Parses via POST /api/chat; when ready, hands off to guided flows (no
 * Details/Route cards — those live in CashoutFlow, BuyFlow, RelaySwapPanel).
 */

import React, { useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatReply, FlowLaunch } from "@/assistant/types";
import type { FlowId } from "./Home";
import { Icon } from "./icons";
import { clearChatState, loadChatState, storeChatState } from "./swapUrl";

const FLOW_CTA: Record<FlowId, string> = {
  cashout: "Continue to sell",
  buy: "Buy crypto",
  bridge: "Open swap",
};

type Props = {
  onLaunch: (launch: FlowLaunch) => void;
};

export function AssistantChat({ onLaunch }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReply, setLastReply] = useState<ChatReply | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Rehydrate the conversation after a refresh (same sessionStorage pattern as
  // the flow drafts), so the chat isn't the one thing that resets.
  useEffect(() => {
    const saved = loadChatState();
    if (saved) {
      setMessages(saved.messages);
      setLastReply(saved.lastReply);
    }
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, lastReply, thinking]);

  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  }, [input]);

  const send = async () => {
    const text = input.trim();
    if (!text || thinking) return;

    const nextMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: text },
    ];
    setMessages(nextMessages);
    setInput("");
    setError(null);
    setThinking(true);
    setLastReply(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || `Assistant error (${res.status})`);
        setThinking(false);
        return;
      }

      const reply = data as ChatReply;
      const withReply: ChatMessage[] = [
        ...nextMessages,
        { role: "assistant", content: reply.message },
      ];
      setLastReply(reply);
      setMessages(withReply);
      storeChatState({ messages: withReply, lastReply: reply });
    } catch {
      setError("Couldn't reach the assistant — check your connection.");
    } finally {
      setThinking(false);
    }
  };

  const startOver = () => {
    setMessages([]);
    setLastReply(null);
    setError(null);
    setInput("");
    clearChatState();
  };

  const handleLaunch = () => {
    if (!lastReply?.launch) return;
    const firstUser = messages.find((m) => m.role === "user")?.content;
    onLaunch({
      ...lastReply.launch,
      plan: lastReply.plan.length ? lastReply.plan : lastReply.launch.plan,
      chatSummary: firstUser,
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="col gap-4" style={{ minHeight: 360 }}>
      {messages.length > 0 && (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button
            className="btn btn-quiet btn-sm"
            onClick={startOver}
            style={{ padding: "0 8px" }}
          >
            Start over
          </button>
        </div>
      )}
      <div
        className="col gap-3"
        aria-live="polite"
        style={{
          flex: 1,
          maxHeight: "min(52vh, 480px)",
          overflowY: "auto",
          padding: "4px 2px",
        }}
      >
        {messages.length === 0 && !thinking && (
          <div
            className="col gap-2"
            style={{
              padding: "20px 16px",
              borderRadius: 12,
              background: "var(--bg-soft)",
              border: "1px solid var(--line)",
            }}
          >
            <span className="row center gap-2" style={{ color: "var(--accent)" }}>
              <Icon.Sparkle size={14} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>Try saying</span>
            </span>
            <span className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
              &ldquo;Sell my meme token for naira&rdquo; · &ldquo;Sell 200 USDC to
              my bank account&rdquo; · &ldquo;Swap ETH to USDC on Base&rdquo;
            </span>
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "88%",
            }}
          >
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 14,
                fontSize: 14,
                lineHeight: 1.5,
                background:
                  m.role === "user" ? "var(--accent)" : "var(--bg-soft)",
                color: m.role === "user" ? "var(--btn-fg)" : "var(--fg)",
                border:
                  m.role === "assistant"
                    ? "1px solid var(--line)"
                    : "1px solid transparent",
              }}
            >
              {m.content}
            </div>
          </div>
        ))}

        {thinking && (
          <div style={{ alignSelf: "flex-start" }}>
            <span
              className="row center gap-2 muted"
              style={{ fontSize: 13, padding: "8px 4px" }}
            >
              <Icon.Spinner size={14} /> Thinking…
            </span>
          </div>
        )}

        {error && (
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 12,
              background: "var(--err-soft)",
              border: "1px solid var(--err)",
              fontSize: 13,
              color: "var(--err)",
            }}
          >
            {error}
          </div>
        )}

        {lastReply?.launch && (
          <div
            className="col gap-3"
            style={{
              padding: 16,
              borderRadius: 12,
              border: "1px solid var(--line-2)",
              background: "var(--bg-elev)",
            }}
          >
            {lastReply.plan.length > 0 && (
              <ol
                className="col gap-1"
                style={{
                  margin: 0,
                  paddingLeft: 18,
                  fontSize: 13,
                  color: "var(--fg-soft)",
                }}
              >
                {lastReply.plan.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            )}
            <button
              className="btn btn-primary btn-fat"
              onClick={handleLaunch}
            >
              {FLOW_CTA[lastReply.launch.flow]} <Icon.ArrowRight />
            </button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div
        className="card row center gap-2"
        style={{ padding: "10px 12px", flex: "0 0 auto" }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Describe what you want to do…"
          disabled={thinking}
          style={{
            flex: 1,
            resize: "none",
            border: 0,
            outline: "none",
            background: "transparent",
            color: "var(--fg)",
            fontSize: 15,
            lineHeight: 1.35,
            minHeight: 24,
          }}
        />
        <button
          className="btn btn-primary btn-sm"
          onClick={() => void send()}
          disabled={!input.trim() || thinking}
          aria-label="Send message"
        >
          <Icon.ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}
