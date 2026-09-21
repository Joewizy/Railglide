# Architecture & roadmap

This document complements [`README.md`](README.md): the README describes **what runs in the repo today** (Paycrest fiat off-ramp on mainnet, plus Relay swaps and bridges). This file describes the **target multi-rail product** (Chainrails, CCTP, Relay, Paycrest), constraints, and phased rollout. Use both together—nothing here invalidates the README until corresponding code lands.

---

## How this fits the README

|                     | README (today)                     | This doc (target)                                              |
| ------------------- | ---------------------------------- | -------------------------------------------------------------- |
| **Bridge / quotes** | Relay API, EVM testnets + Starknet | Relay retained for outbound edges + quotes; CCTP for USDC↔USDC |
| **AI intent**       | `/api/chat`, multi-turn parsing    | Structured outputs + route planner                             |
| **Security stance** | Documents server-side key handling | Target: no server-held signing keys                            |

## Product vision

**Stablecoin in from anywhere, fiat or token out to anywhere.**

Users describe intent in plain language or a form (for example: send local fiat to mobile money, or move USDC across chains). The app picks a rail without exposing provider plumbing.

**Differentiator:** commoditized bridges/swaps plus **fiat payout to supported local corridors** (for example via Paycrest). That payout leg is not interchangeable with generic bridging.

### Who it serves

**Phase 1 — primary**

- Users receiving stablecoins (employer, family, clients) who want **NGN, KES, GHS, UGX, XOF**, etc., in bank or mobile-money accounts.
- Sources may be CEX balances, self-custody wallets, or other chains.

**Phase 2+ — secondary**

- Cross-chain DeFi users (USDC across major L1/L2 networks).
- SMB stablecoin payroll into local payout corridors.
- Merchants settling crypto receipts to fiat.

### Constraints (what we are not claiming)

- **Regulatory / KYC:** corridors and limits depend on providers; app-level KYC may be needed above thresholds (see backlog).
- **Chainrails testnet:** multi-token inbound funding and fiat on-ramp are **mainnet-only** for realistic testing; testnet sessions are effectively **USDC-only**.
- **Single-provider risk:** Paycrest is the first fiat payout rail; alternate rails belong in backlog, not in “already shipped.”

---

## The four rails

High-level roles:

| Rail               | Role                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Chainrails**     | Crypto **inbound** + fiat **on-ramp**; settles toward configured settlement chain (for example USDC on Base).                                    |
| **Circle CCTP v2** | **USDC ↔ USDC** across domains when destination token stays USDC.                                                                                |
| **Relay**          | Non-USDC outbound, Bitcoin, fast quotes, same-chain swaps, executor when wallet is already connected; optional fallback.                         |
| **Paycrest**       | **Fiat off-ramp** (USDC → bank / mobile money). Its existing on-ramp remains available only as a fallback for corridors Chainrails cannot quote. |

**Chainrails inbound scope (reference):** intent flows may fund from multiple assets (for example USDC, USDT, DAI, ETH, WETH, and chain-specific lists) across listed networks; internal bridge/swap lands as USDC on the settlement chain. Fiat on-ramp coverage is provider-defined (many countries). Exact lists live in provider docs—not duplicated here so this table stays readable.

### When Relay still wins (outbound)

After inbound settles to USDC on the app balance, **outbound** routing uses Relay where CCTP or Paycrest do not apply:

| Scenario                         | Why Relay                                                                   |
| -------------------------------- | --------------------------------------------------------------------------- |
| USDC → non-USDC on another chain | CCTP is USDC-only; Relay does bridge + swap in one intent.                  |
| Destination Bitcoin              | Relay supports BTC legs; others in this stack do not.                       |
| Starknet / Solana non-USDC       | Matches Relay executor + SDK wiring.                                        |
| Quote comparison                 | Fast granular quotes (fees, ETA, slippage) for “cheapest route” UX.         |
| Power users                      | Step executor can sign from connected wallet without intent-address bounce. |
| Same-chain swaps                 | Via Relay instead of a separate aggregator.                                 |
| Resilience                       | Optional fallback when another rail is degraded.                            |

**One-line summary:** Chainrails → inbound; CCTP → USDC↔USDC outbound; Paycrest → fiat outbound; Relay → other outbound + quotes + optional fallback.

### Route planner (decision sketch)

```javascript
intent direction?
├── fiat → USDC              → Chainrails ramp API
├── crypto → USDC (settlement) → Chainrails session + PaymentModal
├── USDC → fiat (bank / MoMo) → ensure Paycrest-supported chain → Paycrest order
└── outbound crypto
        ├── USDC && cross-chain → CCTP v2
        ├── destination Bitcoin → Relay
        ├── token ≠ USDC       → Relay
        └── same-chain swap    → Relay
```

---

## System architecture (target)

```javascript
┌──────────────────────────────────────────────────────────────┐
│  UI: Next.js + RainbowKit + Starknet React                   │
│  - Intent (NL) + structured form fallback                    │
│  - PaymentModal slot (Chainrails)                            │
│  - Status timeline (deposit → bridge → payout)               │
└──────────────────────┬───────────────────────────────────────┘
                       │
              ┌────────▼────────┐
              │ Intent layer    │   /api/chat
              │ (structured AI) │   strict JSON schema + alias map
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │ Route planner   │   /api/router
              │ Chainrails |    │   pure function over registry
              │ CCTP | Relay |  │   rail, legs[], fee estimates
              │ Paycrest        │
              └────────┬────────┘
                       │
   ┌───────────────────┼──────────────────┬───────────────────┐
   ▼                   ▼                  ▼                   ▼
Chainrails          CCTP v2             Relay              Paycrest
session +           burn+attest+mint    quote → execute    sender API
PaymentModal        (client signs)                       (server order +
                                                          client funds)
   │                   │                  │                   │
   └───────────────────┴───────┬──────────┴───────────────────┘
                               │
                       ┌───────▼────────┐
                       │ Status tracker │   websocket / polling
                       │ normalises    │   single user timeline
                       │ per-rail APIs │
                       └────────────────┘
```

### Signing & custody (target vs README today)

**Target:** remove server-held chain keys (`ARGENT_PRIVATE_KEY`-style paths). Signatures come from the user wallet (RainbowKit / Argent-Braavos / Phantom as applicable). Server keeps provider API keys and read-only RPC configuration only—aligned with README’s eventual security story once migration lands.

---

## Network mode (testnet ⇄ mainnet)

Single flag drives registry and helpers:

```javascript
NEXT_PUBLIC_NETWORK=testnet   # | mainnet
```

| Rail       | Testnet                                                         | Mainnet                                        |
| ---------- | --------------------------------------------------------------- | ---------------------------------------------- |
| Chainrails | Sessions + manual triggers; **USDC-only** funding               | Full token support + hosted fiat ramp          |
| CCTP       | Sepolia family / Fuji / Amoy-style domains                      | Production domains                             |
| Relay      | Via `@relayprotocol` SDK; config `apps/web/src/config/relay.ts` | Same module, network via `NEXT_PUBLIC_NETWORK` |
| Paycrest   | Sandbox + test beneficiaries                                    | Live API + provider KYC                        |
| Wallets    | Testnet chains in RainbowKit                                    | Mainnet chains                                 |

Centralise chain lists in something like `apps/web/src/config/network.ts` instead of scattering `SUPPORTED_CHAINS`. Default `testnet` until mainnet providers are funded and a small live path is verified.

---

## AI / intent layer

**Today (repo):**

- `apps/web/src/app/api/chat/route.ts` — multi-turn chat; each turn returns a `ChatReply` with optional `launch: FlowLaunch` when ready.
- `apps/web/src/assistant/productRules.ts` — product constraints (USDC/USDT settlement, swap-then-cashout, amount optional in chat).
- `apps/web/src/app/components/arc/AssistantChat.tsx` — describe-flow UI; `launchFlow()` saves `savePendingLaunch()` then navigates.

**Type progression:** `ChatMessage` → `ChatReply` → `FlowLaunch` (pending) → guided flow → `Intent` (quoted) → execution. `Intent` is never used for chat routing.

**Later — assistant scope:** chained swap→cashout auto-continuation, recurring sends, quote-only comparisons across rails, spend summaries.

---

## Environment variables (target)

```bash
# Universe
NEXT_PUBLIC_NETWORK=testnet

# Wallet
NEXT_PUBLIC_WALLET_CONNECT_ID=

# AI
GEMINI_API_KEY=

# Chainrails
CHAINRAILS_API_KEY=
CHAINRAILS_BASE_URL=

# Paycrest
PAYCREST_CLIENT_ID=
PAYCREST_CLIENT_SECRET=
PAYCREST_WEBHOOK_SECRET=

# Circle (CCTP attestation flows as needed)
CIRCLE_API_KEY=

# Relay (optional app / referrer id)
NEXT_PUBLIC_RELAY_APP_ID=

# Optional RPCs
NEXT_PUBLIC_BASE_RPC_URL=
NEXT_PUBLIC_STARKNET_RPC_URL=
```

---

## API routes (today)

Handler implementations live under `apps/web/src/app/api/`. This table is a reference for people hacking on the code — it is not a public API surface.

| Route                                | Purpose                                                         |
| ------------------------------------ | --------------------------------------------------------------- |
| `POST /api/chat`                     | Multi-turn assistant → structured flow handoff                  |
| `POST /api/intent`                   | Legacy single-shot NL → structured intent (dashboard / tooling) |
| `POST /api/router`                   | Rail selection + quote endpoint or inline CCTP fees             |
| `POST /api/quote`                    | Relay quote and execution steps                                 |
| `GET /api/cctp/attestation`          | Poll Circle Iris for CCTP attestation                           |
| `GET /api/cctp/fees`                 | CCTP burn-fee quote per chain pair                              |
| `POST /api/chainrails/quote`         | Chainrails best-across-bridges quote                            |
| `GET /api/chainrails/ramp/countries` | Live Chainrails country/currency catalogue                      |
| `POST /api/chainrails/ramp/quote`    | Live fiat-to-USDC provider quote                                |
| `POST /api/chainrails/ramp/orders`   | Create hosted Chainrails on-ramp checkout                       |
| `POST /api/paycrest/order`           | Create off-ramp or on-ramp order                                |
| `GET /api/paycrest/order/:id`        | Poll order status                                               |
| `GET /api/paycrest/orders`           | List orders by refund wallet address                            |
| `GET /api/paycrest/rate`             | Public unit rate estimate                                       |
| `GET /api/paycrest/institutions`     | Payout institutions for a fiat currency                         |
| `POST /api/paycrest/verify-account`  | Resolve account holder name                                     |

---

## Doc maintenance

When README and implementation diverge from this roadmap, update **either** the README **or** this file in the same PR so “today vs target” stays honest—especially API paths and security wording.
