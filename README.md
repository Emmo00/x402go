# x402go

x402 payment infrastructure for Celo: a merchant account layer, deterministic
vaults, and an independently operated facilitator for payment verification and
settlement.

## Repository

- [`backend/`](./backend/) — merchant API and application backend
- [`backend/facilitator/`](./backend/facilitator/) — forked facilitator package
- [`contracts/`](./contracts/) — payment relayer and vault contracts
- [`frontend/`](./frontend/) — marketing site and merchant dashboard

## Documentation

- [Documentation](https://docs.x402go.online/)
- [Full documentation for agents](https://docs.x402go.online/llms-full.txt)
- [Quickstart](https://docs.x402go.online/quickstart.md)
- [API reference](https://docs.x402go.online/api-reference/overview.md)
- [Security and contracts](https://docs.x402go.online/guides/security.md)

## Run locally in demo mode

Demo mode starts the backend without MongoDB, wallet secrets, or public RPC
access. It is intended for local UI and health-check smoke tests, not for
settling real payments.

```powershell
cd backend
cp .env.example .env
export DEMO_MODE = "true"
bun install
bun run dev
```

The readiness endpoint is available at `http://localhost:3000/health/ready`.
For a production-like run, configure the secrets listed in
[`backend/.env.example`](./backend/.env.example) and leave `DEMO_MODE=false`.

## Deployed contracts

The same deployment addresses are used on Celo mainnet and Celo Sepolia.
Customers should pay the generated payment address (`payTo`), not the factory,
implementation, or operator address.

### Celo Mainnet

| Contract | Address |
| --- | --- |
| Operator | [`0x402001B3fbf1462939657eb7f64EE3743eAdf35E`](https://celoscan.io/address/0x402001B3fbf1462939657eb7f64EE3743eAdf35E) |
| Payment relayer factory | [`0xdfBB7b9F9449024A36E34539f94e1ca14f404ef6`](https://celoscan.io/address/0xdfBB7b9F9449024A36E34539f94e1ca14f404ef6) |
| Payment relayer implementation | [`0x2A081D94C3bA4183bBFd907A39Ad1597DD9261a1`](https://celoscan.io/address/0x2A081D94C3bA4183bBFd907A39Ad1597DD9261a1) |


### Celo Sepolia

| Contract | Address |
| --- | --- |
| Operator | [`0x402001B3fbf1462939657eb7f64EE3743eAdf35E`](https://sepolia.celoscan.io/address/0x402001B3fbf1462939657eb7f64EE3743eAdf35E) |
| Payment relayer factory | [`0xdfBB7b9F9449024A36E34539f94e1ca14f404ef6`](https://sepolia.celoscan.io/address/0xdfBB7b9F9449024A36E34539f94e1ca14f404ef6) |
| Payment relayer implementation | [`0x2A081D94C3bA4183bBFd907A39Ad1597DD9261a1`](https://sepolia.celoscan.io/address/0x2A081D94C3bA4183bBFd907A39Ad1597DD9261a1) |
