export const FEE_PER_TX = 0.0035; // 35
export const FEE_PER_TX_NGN = 4.800; // 48000
export const EXAMPLE_PAYMENTS = [0.01, 0.1, 1, 100];

export const TOKENS = [
  { symbol: 'USAT', name: 'Tether America USD', auth: 'ERC-3009' },
  { symbol: 'USDC', name: 'USD Coin', auth: 'ERC-3009' },
  { symbol: 'USDT', name: 'Tether USD', auth: 'ERC-3009' },
  {symbol: 'cNGN', name: 'Compliant Naira', auth: 'Permit2' },
];

export const SNIPPETS = [
  {
    id: 'server',
    file: 'server.js',
    lines: [
      "import { paymentMiddleware, x402ResourceServer } from '@x402/express';",
      "import { HTTPFacilitatorClient } from '@x402/core/server';",
      "import { ExactEvmScheme } from '@x402/evm/exact/server';",
      '',
      "const auth = { 'x-api-key': process.env.FACILITATOR_API_KEY }; // Get the API key from your x402Go dashboard.",
      '',
      'const facilitator = new HTTPFacilitatorClient({',
      '  url: "https://api.x402go.online",',
      '  createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),',
      '});',
      '',
      'const resourceServer = new x402ResourceServer(facilitator)',
      '  .register("eip155:42220", new ExactEvmScheme());',
      '',
      'const app = express();',
      '',
      'app.use(paymentMiddleware({',
      "  'GET /paid': {",
      '    accepts: [{',
      "      scheme: 'exact', network: 'eip155:42220', payTo: '0x...', // Use the payment address from your x402Go dashboard.",
      '      price: {',
      "        amount: '100000', // $0.10 in token units",
      "        asset: '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771', // USAT on Celo",
      "        extra: { name: 'Tether America USD', version: '1' },",
      '      },',
      '    }],',
      '  },',
      '}, resourceServer));',
      '',
      "app.get('/paid', (req, res) => res.json({ ok: true }));",
    ],
  },
  {
    id: 'client',
    file: 'client.js',
    lines: [
      "import { x402Client, wrapFetchWithPayment } from '@x402/fetch';",
      "import { ExactEvmScheme } from '@x402/evm/exact/client';",
      '',
      'const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);',
      '',
      'const client = x402Client.fromConfig({',
      "  schemes: [{ network: 'eip155:42220', client: new ExactEvmScheme(signer) }],",
      '  spendControls: { allowedAssets: true },',
      '});',
      '',
      'const pay = wrapFetchWithPayment(fetch, client);',
      "const res = await pay('https://example.com/paid');",
      'console.log(res.status, await res.json());',
    ],
  },
];

export const BENEFITS = [
  {
    title: 'No upfront funding',
    body: 'Start accepting payments without depositing money into a facilitator balance.',
  },
  {
    title: 'Pay as you go',
    body: 'Fees are deducted from each payment you receive. No manual top-ups.',
  },
  {
    title: 'One API key',
    body: 'Sign up, get your API key, and plug x402Go into your app.',
  },
  {
    title: 'Built for developers',
    body: 'Simple APIs and straightforward integration, so payments work on day one.',
  },
  {
    title: 'Payment analytics',
    body: 'See payments, revenue, fees, and usage from one dashboard.',
  },
  {
    title: 'Transparent history',
    body: "Know exactly what you've received and what you've paid in fees.",
  },
];

export const usd = (n) => `$${n.toFixed(4).replace(/0$/, '')}`;
