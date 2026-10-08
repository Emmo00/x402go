---
name: x402go
description: Integrate x402Go — a facilitator proxy and accounting layer over the Celo x402 facilitator. Charge for an API with x402 payments and get paid into a deterministic merchant vault.
license: MIT
---

# x402Go — integration skill

x402Go speaks the x402 protocol at the URLs a client already knows, so pointing an
x402 resource server at x402Go instead of at Celo is a one-line change to the
facilitator URL.

Everything below is x402Go's actual behaviour. Where it differs from Celo's
facilitator, this document is the one to follow.

## What x402Go is

- A **proxy and accounting layer** over the Celo facilitator. It does not
  implement x402 and it does not settle anything itself.
- A **merchant account system**. A merchant signs in with a wallet, gets an API
  key, and is given a deterministic **vault address** that is their `payTo`.
- An **accounting boundary**. `POST /settle` is the only endpoint that records a
  payment, and the record is written *before* Celo is called.

Request path:

```
x402 client → x402Go (authenticate merchant → resolve vault → validate → fee guard)
            → Celo facilitator → Celo → merchant vault
```

## Facts you must not get wrong

1. **`payTo` is the merchant's vault**, never the merchant's own wallet. Get it
   from `GET /account` (`vaults[].address`).
2. **The payment amount is the gross amount.** x402Go's fee and Celo's fee come
   *out of it*. `grossAmount = merchantAmount + x402GoFee + facilitatorFee`.
3. **The payment must be strictly greater than $0.002.** Equal is refused.
4. **Amounts are integer strings in the token's atomic units.** Never a decimal,
   never a float, never a JSON number. `"1002000"` is $1.002 in USDC (6
   decimals).
5. **`x402Version` must be `2`.** Version 1 is refused, not reinterpreted.
6. **`scheme` must be `exact`.** It is the only scheme Celo settles.
7. **The merchant is taken from the API key**, never from the request body.
   There is no merchant or vault field you can set.
8. **`POST /verify` changes nothing.** It writes no record and moves no money.
   Only `POST /settle` does.
9. **A `409` from `/settle` means do not retry.** Either the payment is already
   recorded, or its outcome is unknown.
10. **wARS, wBRL and wCOP will be refused** with `500
    fee-schedule-unavailable`. See "Supported networks and assets".

## Base URL

```
http://localhost:8000
```

Replace with your x402Go deployment's origin. Every path below is relative to it.

- `GET /` — liveness
- `GET /supported` — capabilities (public)
- `POST /verify` — check a payment (API key)
- `POST /settle` — settle and record (API key)

There is no `/api` prefix and no `/facilitator` prefix: the paths are the ones an
x402 client is already configured with.

## Authentication

Two credentials exist and they are not interchangeable.

**Your x402Go API key** — the merchant credential. Obtained from the dashboard
(`/dashboard/api-keys`), or with `POST /api-keys` and `POST /api-keys/rotate`.
It is shown exactly once, at issue. Send it on every `/verify` and `/settle`:

```
Authorization: Bearer x402go_...
```

`X-API-Key: x402go_...` is accepted as an equivalent header. If both are present
`Authorization` wins.

**x402Go's own Celo credential** — held by the x402Go server in
`CELO_FACILITATOR_API_KEY`. You never see it and never send it. x402Go presents
it to Celo on your behalf.

Failure modes, both `401`:

| Situation | Body |
|---|---|
| No credential at all | `{"message":"API key required"}` |
| Unknown, malformed, or rotated-away key | `{"message":"Invalid API key"}` |

A missing key and an invalid one are deliberately distinguishable; an unknown key
and a rotated-away one are not.

> Never send your x402Go API key to `api.x402.celo.org`. It is not a Celo
> credential and Celo does not know it.

## Supported networks and assets

Two networks, addressed in **CAIP-2** form:

| Network | CAIP-2 | chainId | Facilitator |
|---|---|---|---|
| Celo Mainnet | `eip155:42220` | 42220 | `https://api.x402.celo.org` |
| Celo Sepolia | `eip155:11142220` | 11142220 | `https://api.x402.sepolia.celo.org` |

The bare keys `celo` and `celoSepolia`, and the legacy spellings `celo` /
`celo-sepolia`, are also accepted inside `paymentRequirements.network`. Anything
else is `400 unsupported-network`.

Assets x402Go will settle today:

| Asset | Network | Address | Decimals | Transfer | EIP-712 `extra` |
|---|---|---|---|---|---|
| USDC | `eip155:42220` | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` | 6 | `eip3009` | `{ "name": "USDC", "version": "2" }` |
| USDT | `eip155:42220` | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | 6 | `eip3009` | `{ "name": "Tether USD", "version": "1" }` |
| USAT | `eip155:42220` | `0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771` | 6 | `eip3009` | `{ "name": "Tether America USD", "version": "1" }` |
| USDC | `eip155:11142220` | `0x01C5C0122039549AD1493B8220cABEdD739BC44E` | 6 | `eip3009` | `{ "name": "USDC", "version": "2" }` |

Assets Celo lists and x402Go has **enabled but cannot price** — these are refused
with `500 fee-schedule-unavailable` until a dollar rate is configured for them,
because the fee guard cannot be computed without one:

| Asset | Network | Address | Decimals | Transfer |
|---|---|---|---|---|
| wARS | `eip155:42220` | `0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D` | 18 | `permit2` |
| wBRL | `eip155:42220` | `0xD76f5Faf6888e24D9F04Bf92a0C8B921FE4390e0` | 18 | `permit2` |
| wCOP | `eip155:42220` | `0x8a1D45e102e886510e891d2Ec656a708991e2D76` | 18 | `permit2` |

Also listed by Celo, not enabled anywhere: wMXN (`0x337E7456B420bD3481e7FA61fA9850343d610d34`),
wPEN (`0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE`), wCLP
(`0x61D450a098b6a7f69fC4b98CE68198fe59768651`).

**Launch against USDC.** `extra.name` is the authoritative EIP-712 domain name —
the symbol will not verify. USDT has no on-chain `version()`; its domain is
`name: "Tether USD"`, `version: "1"`, and those exact strings must be used.

`GET /supported` is the live answer, and Celo is the authority behind it. Read it
rather than trusting this table, which is a snapshot.

## GET /supported

Public. No credential. Proxied from Celo **unmodified** — x402Go does not add,
remove or reorder anything.

```bash
curl 'http://localhost:8000/supported?network=celo'
```

Query parameter `network` is optional and accepts `celo`, `celoSepolia`,
`eip155:42220` or `eip155:11142220`. It defaults to Celo Mainnet, so an
unqualified request is never answered from a testnet. An unknown value is a
`400`, not a silent fallback.

Response (abridged — the real body is Celo's, passed through whole):

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:42220",
      "extra": {
        "extensions": ["eip2612GasSponsoring"],
        "defaultAsset": {
          "asset": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
          "symbol": "USDC",
          "decimals": 6,
          "name": "USDC",
          "version": "2",
          "assetTransferMethod": "eip3009"
        },
        "supportedAssets": [ "... one entry per settleable asset ..." ]
      }
    },
    { "x402Version": 1, "scheme": "exact", "network": "celo" }
  ],
  "extensions": ["eip2612GasSponsoring"],
  "signers": {
    "eip155:42220": ["0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48"]
  }
}
```

Celo advertises a **version 2** kind (CAIP-2 network, with `supportedAssets`) and
a legacy **version 1** kind (network `celo`, no asset list). x402Go settles the
version 2 kind only.

Read `extra.supportedAssets[].assetTransferMethod` to know whether a payer signs
a `TransferWithAuthorization` (`eip3009`) or grants a Permit2 allowance
(`permit2`).

Errors: `400` unknown network, `502` Celo answered unusably, `503` Celo
unreachable, `500` x402Go has no facilitator credential.

Responses are cached briefly per network, so a burst of callers costs one Celo
call.

## POST /verify

Authenticated. **Changes nothing** — no record, no balance, no transaction.

Validates the payment locally, then asks Celo whether it is well-formed and
correctly signed.

```bash
curl -X POST http://localhost:8000/verify \
  -H 'Authorization: Bearer x402go_...' \
  -H 'Content-Type: application/json' \
  -d '{
    "x402Version": 2,
    "paymentRequirements": {
      "scheme": "exact",
      "network": "eip155:42220",
      "amount": "1002000",
      "asset": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      "payTo": "0x59f3d0c53bc46a35a81e478b080cc8afa2fc88de",
      "maxTimeoutSeconds": 300,
      "extra": { "name": "USDC", "version": "2" }
    },
    "paymentPayload": {
      "x402Version": 2,
      "accepted": { "...": "the requirements the payer agreed to" },
      "payload": {
        "signature": "0xcdcd...cdcd",
        "authorization": {
          "from": "0x4f3Edf983aC636A65A842Ce7c78D9Aa706D3b113",
          "to": "0x59f3d0c53bc46a35a81e478b080cc8afa2fc88de",
          "value": "1002000",
          "validAfter": "0",
          "validBefore": "9999999999",
          "nonce": "0x1111111111111111111111111111111111111111111111111111111111111111"
        }
      }
    }
  }'
```

Response `200`:

```json
{ "isValid": true, "payer": "0x4f3Edf983aC636A65A842Ce7c78D9Aa706D3b113" }
```

**A well-formed but invalid payment is a `200`.** Read `isValid`, not the status
code:

```json
{ "isValid": false, "invalidReason": "insufficient_funds", "invalidMessage": "..." }
```

`invalidReason` is one of the x402 error codes — `insufficient_funds`,
`invalid_exact_evm_payload_signature`, `invalid_network`, `invalid_scheme`, and
so on.

### What is checked before Celo is called

Every one of these is a local refusal, so a payment that was never going to be
accepted never spends a Celo call:

- `x402Version` is exactly `2`
- `scheme` is `exact`
- `network` is a supported chain
- `asset` is an address the facilitator lists and x402Go has enabled
- `paymentRequirements.payTo` **and** `paymentPayload.payload.authorization.to`
  both equal the authenticated merchant's vault
- `authorization.value` equals `paymentRequirements.amount`
- `authorization.value` is greater than the total fee

The recipient is checked in both places on purpose. `payTo` is what the merchant
advertised; `authorization.to` is what the payer actually signed. Letting them
disagree is how a payment is verified against one vault and settled into another.

## POST /settle

Authenticated. **The only endpoint that moves money and the only one that writes
an accounting record.**

It performs every check `/verify` performs, then submits the payment to Celo.

Same request body as `/verify`. The signed `paymentPayload` is forwarded to Celo
**byte for byte** — it is never rebuilt, re-encoded or tidied, because its bytes
are what the payer's signature covers.

Response `200`:

```json
{
  "success": true,
  "transaction": "0x9c1f0e6f1d2a4b7c8e5f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f",
  "network": "eip155:42220",
  "payer": "0x4f3Edf983aC636A65A842Ce7c78D9Aa706D3b113",
  "amount": "1002000",
  "duplicate": false,
  "settlement": {
    "settlementId": "3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a",
    "status": "settled",
    "network": "celo",
    "chainId": 42220,
    "asset": "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    "payer": "0x4f3Edf983aC636A65A842Ce7c78D9Aa706D3b113",
    "payTo": "0x59f3d0c53bc46a35a81e478b080cc8afa2fc88de",
    "grossAmount": "1002000",
    "merchantAmount": "1000000",
    "x402GoFee": "1000",
    "facilitatorFee": "1000",
    "totalFee": "2000",
    "x402Version": 2,
    "scheme": "exact",
    "nonce": "0x1111...1111",
    "transactionHash": "0x9c1f...e5f",
    "createdAt": "2026-10-07T09:41:07.412Z",
    "settledAt": "2026-10-07T09:41:09.006Z"
  }
}
```

**`transaction` is always present and is `""` when nothing moved.** Read
`success`, never the presence of a hash.

### Status codes

| Status | Meaning | What to do |
|---|---|---|
| `200` | A settlement that happened, or one that definitively did not. Read `success`. | Nothing. |
| `400` | Malformed request. Nothing was submitted and nothing was recorded. | Fix the request. |
| `401` | Bad or missing API key. | Fix the credential. |
| `402` | Amount does not clear $0.002. Refused before Celo was contacted. | Charge more. |
| `403` | `payTo` is not this merchant's vault. | Use the vault from `GET /account`. |
| `404` | This merchant has no vault on that network. | Use a supported network. |
| `409` | **Do not retry.** Already recorded, or outcome unknown. | See below. |
| `500` | x402Go is misconfigured (no Celo credential, or no rate for the asset). | Nothing — it is not your request. |
| `502` / `503` / `504` | Celo refused, was unreachable, or timed out. | Outcome recorded as `pending_reconciliation`. Do not resubmit. |

### The 409

Two different situations, and neither is safe to retry blindly:

- `settlement_pending_reconciliation` — the payment **was submitted** and x402Go
  never learned whether it landed. It has *not* been retried and the merchant has
  **not** been credited. Resubmitting could settle the same payment twice.
- A duplicate of a settlement that is still in flight, or a recorded settlement
  that could not be reused. The existing record is returned instead of a second
  settlement being attempted.

```json
{
  "success": false,
  "errorReason": "settlement_pending_reconciliation",
  "errorMessage": "The settlement was submitted but its outcome is unknown. It has not been retried. Do not resubmit this payment; check its status before acting.",
  "transaction": "",
  "network": "eip155:42220",
  "payer": "0x4f3Edf983aC636A65A842Ce7c78D9Aa706D3b113",
  "duplicate": false
}
```

Only one failure proves nothing was sent — a missing Celo credential — and that
one is recorded as `failed`, not left for reconciliation.

## Fee model

| Component | Amount |
|---|---|
| x402Go fee | $0.001 |
| Celo facilitator fee | $0.001 |
| **Total** | **$0.002** |

The guard is `paymentAmount > totalFee`, in the asset's own atomic units, as
integers. **Equal is refused**, because it would leave the merchant with nothing.

In USDC (6 decimals): `1000 + 1000 = 2000`. A payment of `2000` or less is
`402`. `2001` settles, and the merchant receives `1`.

Accounting is computed **server-side**, from the signed amount. Fee values in the
request body are ignored entirely.

```
grossAmount = merchantAmount + x402GoFee + facilitatorFee
merchantAmount > 0
```

`GET /account` does not expose a balance, and there is no balance field to read:
a merchant's balance is the sum of `merchantAmount` over their `settled`
settlements. Settlements are only ever written by `/settle`.

Fees are not collected per payment. They accumulate in the vault and are swept to
the factory when a withdrawal runs — see "Payout and withdrawal".

## payTo and deterministic vaults

Each merchant has **one vault address per supported network**, derived
deterministically from their wallet and the deployed factory:

```
vault = factory.vaultOf(merchantWallet)
```

- The **same merchant always derives the same vault**. It is final from the first
  moment it exists.
- **Two merchants never share one.**
- It is **not the merchant's wallet address**. Paying the wallet directly will be
  refused with `403`.
- Derivation is a pure function of the merchant and the factory, so the address is
  correct **before any contract is deployed at it**.

Get it from `GET /account`:

```json
{
  "address": "0xc0b0e77000aa0826b7db9d1fe3760d26559643bb",
  "vaults": [
    {
      "network": "celo",
      "networkName": "Celo Mainnet",
      "chainId": 42220,
      "address": "0x59f3d0c53bc46a35a81e478b080cc8afa2fc88de",
      "deployed": false,
      "explorerUrl": "https://celoscan.io/address/0x59f3d0c53bc46a35a81e478b080cc8afa2fc88de"
    }
  ]
}
```

### Vaults may be undeployed

`deployed: false` is the **normal state for a new merchant** and does not make the
address any less correct or less usable. Deployment is **lazy** and happens when
something actually needs a contract: a withdrawal, or setting a payout wallet.

`deployed: null` means the chain could not be reached, so the state is *unknown* —
it is not a synonym for `false`.

For a seller this distinction is invisible: configure `payTo` as the vault address
and it works whether or not a contract is there yet.

## Payout and withdrawal

### Payout wallet

Settled funds belong to the merchant but sit in the vault. They are released to
the merchant's **payout address**, which defaults to the merchant's own wallet.

Set or read it over the session-authenticated (browser) API:

```
GET /payout   → { "payTo": "0x4f3e...b113" }   // null until one is set
PUT /payout   → { "payTo": "0x4f3Edf983aC636A65A842Ce7c78D9Aa706D3b113" }
```

`PUT /payout` records an address. It does **not** move the on-chain payout by
itself, and it requires a signed-in session, not an API key.

The on-chain change goes through `X402Vault.changePayout`, which requires an
EIP-712 signature from the **vault's merchant**, not from the payout address and
not from the x402Go operator. The operator can never redirect merchant funds.

```
ChangePayout(address newPayout, uint256 nonce, uint256 deadline)
```

When a vault is deployed the payout is set in the *same* transaction that creates
it, so the payout is safe from the moment the vault exists.

### Withdrawal flow

Withdrawal is an **operator action on the vault contract**, not a public HTTP
endpoint. `X402Vault.withdraw` is callable only by the factory's operator:

```solidity
function withdraw(
  address[] calldata tokens,
  uint256[] calldata merchantAmounts,
  uint256[] calldata feeAmounts
) external
```

- **Withdrawals aggregate across tokens.** One call carries a list of token
  addresses, so every supported asset in a vault is swept in a single
  transaction.
- Two legs run in the same transaction and both must succeed: **merchant funds go
  to `payout()`**, and **accumulated fees go to the factory** (the fee recipient).
  A failure anywhere reverts the whole withdrawal.
- The vault must be **deployed** first. If it is not, the withdrawal is what
  triggers the lazy deployment.
- A vault whose payout is not the one expected is **refused rather than paid**,
  because a mismatch means either a stale record or a payout that was pointed
  somewhere the merchant did not intend, and the two cannot be told apart. It is
  reported for reconciliation instead of being guessed at.

## Error responses

Every error is `{"message": "..."}`. No `code` and no `details` are sent to
clients — those exist for x402Go's own logs.

| Status | `message` |
|---|---|
| `400` | `The request is not a valid x402 payment request.` |
| `400` | `That x402 version is not supported.` |
| `400` | `That payment scheme is not supported.` |
| `400` | `That network is not supported.` |
| `400` | `That asset is not supported for settlement.` |
| `400` | `The signed payment does not match the payment requirements it was sent with.` |
| `401` | `API key required` / `Invalid API key` |
| `402` | `The payment does not cover the x402Go and network fees, so it cannot be settled.` |
| `403` | `The payment is not addressed to this merchant's vault.` |
| `404` | `No vault is available for this account on that network.` |
| `409` | `The settlement was submitted but its outcome is unknown. It has not been retried; check again before trying it a second time.` |
| `500` | `This server is not configured to reach the payment facilitator.` |
| `500` | `This server cannot price a fee in that asset, so it cannot settle it.` |
| `502` | `The payment facilitator returned an unexpected response.` |
| `503` | `The payment facilitator could not be reached. Try again in a moment.` |
| `504` | `The payment facilitator did not respond in time, so the outcome is unknown.` |

## Example — seller server (TypeScript)

The seller side is a standard x402 resource server. The only two things that make
it x402Go are the facilitator URL and the `payTo` address.

```ts
// facilitator.ts
import { HTTPFacilitatorClient } from '@x402/core/server';

export const facilitator = new HTTPFacilitatorClient({
  url: 'http://localhost:8000',                 // x402Go, not api.x402.celo.org
  createAuthHeaders: async () => {
    const h = { 'X-API-Key': process.env.X402GO_API_KEY! };
    return { verify: h, settle: h, supported: h };
  },
});
```

```ts
// routes.ts
import type { RoutesConfig } from '@x402/express';

// From GET /account, per network. Never the merchant's own wallet.
const VAULT = '0x59f3d0c53bc46a35a81e478b080cc8afa2fc88de';

export const routes: RoutesConfig = {
  'GET /weather': {
    accepts: {
      scheme: 'exact',
      network: 'eip155:42220',
      payTo: VAULT,
      price: {
        amount: '1002000',                       // $1.002 gross
        asset: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
        extra: { name: 'USDC', version: '2' },   // exact domain, not the symbol
      },
    },
  },
};
```

```ts
// server.ts
import express from 'express';
import { paymentMiddleware } from '@x402/express';

const app = express();

// routes FIRST, then server.
app.use(paymentMiddleware(routes, facilitator));

app.get('/weather', (_req, res) => res.json({ tempC: 21 }));
app.listen(3000);
```

Price at **`amount > 2000`** — $0.002 plus at least one atomic unit. `1002000`
is $1.002 gross, of which the merchant keeps $1.000.

## Example — client and agent (TypeScript)

```ts
import { wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';   // register 'exact' for the network

const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch('http://localhost:3000/weather');
console.log(await res.json());
```

A buyer needs **no x402Go API key**. Only the seller's server holds one, and it
never leaves that server.

## Verify your integration

```bash
# 1. x402Go is up and can reach Celo
curl 'http://localhost:8000/supported?network=celo' | jq '.kinds[0].network'

# 2. Your key authenticates
curl -i -X POST http://localhost:8000/verify \
  -H 'Authorization: Bearer x402go_...' -H 'Content-Type: application/json' -d '{}'
# -> 400 "The request is not a valid x402 payment request."
#    (401 means the key is wrong; 400 means the key works)

# 3. payTo matches your vault
curl http://localhost:8000/account   # session cookie required
```

Test on **Celo Sepolia** (`eip155:11142220`, USDC
`0x01C5C0122039549AD1493B8220cABEdD739BC44E`) before mainnet.

## Common mistakes

- Using the merchant wallet as `payTo` instead of the vault → `403`.
- `amount` as a JSON number (`1002000`) instead of a string (`"1002000"`).
- `amount` in whole tokens (`"1.002"`) instead of atomic units.
- Pricing at exactly `2000` → `402`, because the guard is strict.
- Sending `x402Version: 1` → `400`.
- Using the token symbol as the EIP-712 name, or guessing USDT's domain.
- Sending `X-API-Key` to Celo instead of to x402Go.
- Retrying a `409`, which risks settling the same payment twice.
- Reading `transaction` instead of `success` to decide whether money moved.
- Reading `invalidReason` from the HTTP status instead of from `isValid`.
- Expecting an `X-PAYMENT` / `X-PAYMENT-RESPONSE` header to be exchanged with
  x402Go: those are between the client and the **seller's** server. x402Go only
  ever sees the JSON envelope.

## References

- Full API reference (Swagger UI): `/api-docs` on the same origin
- Celo x402 integration guide: https://x402.celo.org/skill.md
- Celo x402 documentation: https://docs.celo.org/build/agents/x402
- x402 protocol specification (v2): https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
- Celo facilitator (mainnet): https://api.x402.celo.org
- Celo facilitator (Sepolia): https://api.x402.sepolia.celo.org
