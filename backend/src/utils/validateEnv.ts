import { cleanEnv, str } from 'envalid';

function validateEnv() {
  cleanEnv(process.env, {
    NODE_ENV: str(),
    MONGO_CONNECTION_URL: str(),
    SESSION_SECRET: str(),
    OPERATOR_KEY: str(),
    // Pepper for API-key hashing. Optional so an existing deployment still
    // boots: `src/utils/apiKey.ts` falls back to SESSION_SECRET and documents
    // that the dedicated value is what should be set in any real environment.
    API_KEY_PEPPER: str({ default: '' }),
    // JSON-RPC endpoints. Optional with an empty default: `src/config/chains.ts`
    // falls back to the public Forno endpoint for each chain, which is enough
    // to develop against. Set these in any real deployment — Forno is
    // rate-limited and best-effort, and the account endpoint reads deployment
    // status from it on every dashboard load.
    CELO_RPC_URL: str({ default: '' }),
    CELO_SEPOLIA_RPC_URL: str({ default: '' }),
  });
}

export default validateEnv;
