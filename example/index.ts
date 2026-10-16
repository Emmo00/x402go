import 'dotenv/config';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme as ServerScheme } from '@x402/evm/exact/server';
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme as ClientScheme } from '@x402/evm/exact/client';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const FACILITATOR_URL = need('FACILITATOR_URL').replace(/\/$/, '');
const API_KEY = need('FACILITATOR_API_KEY');
const PAY_TO = need('PAY_TO'); // your vault address from the dashboard
const signer = privateKeyToAccount(need('EVM_PRIVATE_KEY') as `0x${string}`);

const NETWORK = (process.env.NETWORK ?? 'eip155:11142220') as `${string}:${string}`;
const ASSET = process.env.ASSET ?? '0x01C5C0122039549AD1493B8220cABEdD739BC44E'; // default USDC
const ASSET_NAME = process.env.ASSET_NAME ?? 'USDC';
const ASSET_VERSION = process.env.ASSET_VERSION ?? '2';
const AMOUNT = process.env.AMOUNT ?? '10000'; // atomic units of ($0.01); must exceed the token's fee
const METHOD = process.env.METHOD ?? 'eip3009'; // or "permit2"

async function main() {
  console.log(`payer ${signer.address}\npayTo ${PAY_TO}\n${NETWORK} asset ${ASSET} amount ${AMOUNT} (${METHOD})\n`);

  // 1. facilitator advertises this network and asset?
  const supported = await fetch(`${FACILITATOR_URL}/supported`, { headers: { 'x-api-key': API_KEY } }).then((r) =>
    r.json(),
  );
  const kind = supported.kinds?.find((k: any) => k.x402Version === 2 && k.network === NETWORK);
  const listed = kind?.extra?.supportedAssets?.find((a: any) => a.asset.toLowerCase() === ASSET.toLowerCase());
  if (!listed) throw new Error(`/supported does not list ${ASSET} on ${NETWORK}`);
  if (listed.assetTransferMethod !== METHOD)
    console.warn(`warning: facilitator lists ${listed.assetTransferMethod}, script uses ${METHOD}`);
  console.log('supported ok:', listed.symbol, listed.assetTransferMethod);

  // 2. resource server wired to the facilitator
  const facilitator = new HTTPFacilitatorClient({
    url: FACILITATOR_URL,
    createAuthHeaders: async () => {
      const h = { 'x-api-key': API_KEY };
      return { verify: h, settle: h, supported: h };
    },
  });
  const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ServerScheme());

  const app = express();
  app.use(
    paymentMiddleware(
      {
        'GET /paid': {
          accepts: [
            {
              scheme: 'exact',
              network: NETWORK,
              payTo: PAY_TO,
              price: {
                amount: AMOUNT,
                asset: ASSET,
                extra: {
                  name: ASSET_NAME,
                  version: ASSET_VERSION,
                  ...(METHOD === 'permit2' ? { assetTransferMethod: 'permit2' } : {}),
                },
              },
            },
          ],
          description: 'x402 test endpoint',
          mimeType: 'application/json',
        },
      },
      resourceServer,
    ),
  );
  app.get('/paid', (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

  const server = app.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    // 3. unpaid request must be rejected with a challenge
    const unpaid = await fetch(`${base}/paid`);
    console.log('unpaid:', unpaid.status, 'payment-required header:', unpaid.headers.has('payment-required'));
    if (unpaid.status !== 402) throw new Error('expected 402 for the unpaid request');

    // 4. paid request: client signs, server verifies and settles through your facilitator
    const client = x402Client.fromConfig({
      schemes: [
        {
          network: NETWORK,
          client: new ClientScheme(signer),
        },
      ],
      spendControls: {
        allowedAssets: true,
      },
    });
    const res = await wrapFetchWithPayment(fetch, client)(`${base}/paid`);
    const settle = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n));

    console.log('paid:', res.status, await res.text());
    console.log('settle:', settle);
    if (res.status !== 200 || !settle?.success) process.exitCode = 1;
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
