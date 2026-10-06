# x402Go — frontend

The marketing site and the merchant dashboard for **x402Go**, an
[x402](https://github.com/coinbase/x402) facilitator on Celo. x402Go lets
developers pay for transactions as they go instead of funding an account up
front: the facilitator fee is deducted from each payment, so there is no
pre-funding step and no separate top-up flow.

## Stack

| Concern | Choice |
| --- | --- |
| Build | [Vite](https://vite.dev) 8 (rolldown) |
| UI | React 19 |
| Routing | [react-router](https://reactrouter.com) 8 |
| Wallet | [wagmi](https://wagmi.sh) + [viem](https://viem.sh) + [RainbowKit](https://rainbowkit.com) |
| Server state | [@tanstack/react-query](https://tanstack.com/query) |
| Tests | [Vitest](https://vitest.dev) + Testing Library (jsdom) |

> JSX files use the `.jsx` extension. Vite 8 derives the parser language from
> the file extension, so JSX inside a `.js` file will not parse.

## Getting started

```bash
npm install
cp .env.example .env   # then fill in the values
npm run dev
```

### Environment

Only variables prefixed with `VITE_` reach the browser bundle, so never put a
secret in `.env`.

| Variable | Purpose |
| --- | --- |
| `VITE_API_URL` | Base URL of the Express backend. Defaults to `http://localhost:8000`. |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect Cloud project id. Injected wallets work without it; WalletConnect-based mobile wallets do not. |

### Scripts

| Script | Does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR (`npm start` is an alias). |
| `npm run build` | Production bundle into `dist/`. |
| `npm run preview` | Serve the built bundle locally. |
| `npm test` | Vitest, single run. |

## Design

`DESIGN.md` is the single source of truth for colour, type, spacing, borders,
radii and component behaviour — a dark, terminal-grade system with 1px radii, no
drop shadows, and Phosphor Green rationed to active state and accented
characters. Do not modify it; extend the tokens in `src/index.css` instead.

The dashboard reuses the landing page's primitives rather than restating them:
`src/components/ui/ui.css` and `src/components/ui/primitives.jsx` hold the card,
button, badge, notice, state-panel, field and copy-to-clipboard components, and
`src/theme/rainbowkitTheme.js` maps the same tokens onto RainbowKit so the
connect modal belongs to the same interface.

## Routes

| Path | Screen |
| --- | --- |
| `/` | Landing page |
| `/signup` | Redirects to `/dashboard/api-keys` — the landing page's CTAs land here |
| `/dashboard/overview` | Balances, fees, payment activity and transactions |
| `/dashboard/api-keys` | Current key, create and rotate |
| `/dashboard/settings` | Payout address |
| `*` | Redirects to `/` |

## Authentication

Sign-in is [SIWE / EIP-4361](https://eips.ethereum.org/EIPS/eip-4361), following
`backend/src/docs/auth.yaml` exactly — there are three endpoints and the frontend
calls all three and no others:

1. `GET /auth/nonce?address=` returns a nonce.
2. The wallet signs an EIP-4361 message built from that nonce
   (`src/auth/siwe.js`).
3. `POST /auth/verify` with `{ address, message, signature }` sets an httpOnly
   session cookie.

`src/auth/AuthContext.jsx` holds the state machine
(`disconnected → unauthenticated → awaiting_signature → verifying →
authenticated`, plus `expired`); `src/dashboard/AuthGate.jsx` decides what each
state looks like. Every request is sent with `credentials: 'include'`, and no
token or private key ever touches JavaScript — the only thing persisted
client-side is the public wallet address and the session start time, so a reload
can restore the UI optimistically until a real request returns 401.

## Backend integration status

`backend/src/docs/auth.yaml` is the only API specification in the backend and it
defines the three `/auth` endpoints above. There is currently **no** endpoint for
balances, transactions, API keys or payout addresses.

The dashboard does not paper over that gap with mock data. Each surface loads
through a single function in `src/api/dashboard.js`, and while its endpoint does
not exist that function throws `EndpointUnavailableError`; the screen then
renders a distinct "not available yet" panel — deliberately different from both
an empty state and a failed request. When an endpoint is added, implement the
`apiFetch` call inside `src/api/dashboard.js` and drop the throw. The page
components need no changes.

Payout changes are authorised by an EIP-712 `ChangePayout` signature that the
vault verifies, so the domain and nonce have to come from the backend. The form
validates the address (including its EIP-55 checksum) but stops short of asking
the wallet to sign a message the vault would reject.
