import { cleanEnv, str } from 'envalid';

function validateEnv() {
  const demoMode = process.env.DEMO_MODE === 'true';

  cleanEnv(process.env, {
    NODE_ENV: str(),
    DEMO_MODE: str({ default: 'false' }),
    MONGO_CONNECTION_URL: str({ default: demoMode ? 'mongodb://127.0.0.1:27017/x402go-demo' : undefined }),
    SESSION_SECRET: str({ default: demoMode ? 'x402go-demo-session' : undefined }),
    OPERATOR_KEY: str({ default: demoMode ? '0x0000000000000000000000000000000000000000000000000000000000000001' : undefined }),
    OPERATOR_ADDRESS: str({ default: demoMode ? '0x0000000000000000000000000000000000000000' : undefined }),
    // Pepper for API-key hashing. Optional so an existing deployment still
    // boots: `src/utils/apiKey.ts` falls back to SESSION_SECRET and documents
    // that the dedicated value is what should be set in any real environment.
    API_KEY_PEPPER: str({ default: '' }),
    // JSON-RPC endpoints. Optional with an empty default: `src/config/chains.ts`
    // falls back to the public Forno endpoint for each chain, which is enough
    // to develop against. Set these in any real deployment — Forno is
    // rate-limited and best-effort, and the account endpoint reads deployment
    // status from it on every dashboard load.
    CELO_RPC_URL: str({ default: 'https://forno.celo.org' }),
    CELO_SEPOLIA_RPC_URL: str({ default: 'https://forno.celo-sepolia.celo-testnet.org' }),
  });
}

export default validateEnv;
