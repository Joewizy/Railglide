# Railglide

**Stablecoin in from anywhere — local fiat or another chain out.**

Railglide is an open-source Next.js app that routes transfers across multiple liquidity rails: Circle CCTP, Chainrails, Relay, and Paycrest. Describe a transfer in plain language, follow guided cash-out / buy / bridge flows, or execute USDC ↔ USDC bridges with a connected wallet.

This is source-available so you can **run your own instance**: clone the repo, bring your own API keys, and self-host. It is not a hosted service and there is no shared account — nobody transacts on anyone else's keys. The keys you configure are yours, and they stay on your server.

## Features

- **App at** `/swap` — landing page, conversational send, guided cash-out and buy flows, order status, history, and recipients
- **Multi-rail router** — `POST /api/router` picks CCTP (USDC↔USDC), Chainrails, Relay, or Paycrest from intent shape and corridor
- **Conversational assistant** — `POST /api/chat` multi-turn routing into cash-out, buy, or bridge flows (replaces the older single-shot intent UI on the main path)
- **Paycrest fiat legs** — off-ramp and on-ramp via Sender API; card-based order screen with deposit window, timeline, and transfer renewal
- **CCTP v2** — wallet-signed approve → burn → attestation → mint across supported domains
- **Relay** — quotes and execution for non-USDC and long-tail routes
- **Token + chain registry** — LiFi catalog filtered to supported chains; local fallback on testnet
- **Wallet** — RainbowKit + wagmi; connect required before signing



## Quick start

```bash
git clone https://github.com/Joewizy/Railglide.git
cd railglide
npm install
cp env.example .env.local   # then fill in your own API keys
npm run dev
```

Open [http://localhost:3000/swap](http://localhost:3000/swap).

The app does nothing until you add your own keys to `.env.local`. See the tables below for what each one enables.

### Required environment


| Variable                        | Purpose                                |
| ------------------------------- | -------------------------------------- |
| `NEXT_PUBLIC_WALLET_CONNECT_ID` | WalletConnect project ID (RainbowKit)  |
| `GEMINI_API_KEY`                | Conversational assistant (`/api/chat`) — Gemini Flash |

### Rail API keys (enable as you integrate)


| Variable                   | Rail                                  |
| -------------------------- | ------------------------------------- |
| `PAYCREST_API_KEY`         | Fiat off-ramp / on-ramp (mainnet)     |
| `CHAINRAILS_API_KEY`       | Fiat on-ramp + inbound crypto routing |
| `NEXT_PUBLIC_RELAY_APP_ID` | Optional Relay volume attribution     |


Set `NEXT_PUBLIC_NETWORK=testnet` or `mainnet` to switch the chain registry app-wide.

## Scripts

This is an npm-workspaces monorepo (`apps/web`, `apps/mobile`, `packages/*`). Run all scripts from the repo root.

**Web** (`apps/web`):

```bash
npm run dev            # local Next.js dev server (alias for web:dev)
npm run web:build      # production build
npm run web:lint       # ESLint
npm run web:typecheck  # TypeScript
npm run web:check      # format + lint + typecheck
```

**Mobile** (`apps/mobile`, Expo):

```bash
npm run mobile         # start the Expo dev server
npm run android        # run on Android
npm run ios            # run on iOS
```



## API routes

API handlers live under `apps/web/src/app/api/` — chat/intent, router, quote, CCTP, Chainrails, and Paycrest routes. The code is the source of truth; see [ARCHITECTURE.md](./ARCHITECTURE.md#api-routes-today) for the full route reference.

## Architecture

High-level rail roles:


| Rail           | Role                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- |
| **Chainrails** | Crypto inbound + fiat on-ramp (provider checkout; destination-chain bridging when needed) |
| **CCTP v2**    | USDC ↔ USDC cross-chain                                                                   |
| **Relay**      | Non-USDC outbound, swaps, long-tail chains                                                |
| **Paycrest**   | Fiat payout to bank / mobile money                                                        |


See [ARCHITECTURE.md](./ARCHITECTURE.md) for phased rollout, constraints, and file-level map.

## Running your own copy

Railglide is maintained as a personal project. You're free to clone, fork, and run it under the MIT license — just bring your own keys. A few things to keep in mind if you hack on your copy:

- Keep provider keys server-side; do not commit `.env` or local API scratch files
- Run `npm run web:check` before you rely on a build
- If you change a route or rail, update the README and `ARCHITECTURE.md` so your copy stays accurate

This isn't a hosted service and there's no shared instance to submit work to. Issues and PRs may or may not be reviewed — fork it and make it yours.

## Security

This app moves real funds on mainnet when configured with production API keys. If you self-host, you are responsible for your own keys and any funds moved through your instance. Review Paycrest and Relay docs, test with small amounts, and never commit secrets.

## License

[MIT](./LICENSE) — Copyright (c) 2026 Railglide contributors.