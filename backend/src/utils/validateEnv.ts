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
    // The credential x402Go presents to the Celo facilitator, and the only one
    // it ever presents there. Optional with an empty default so the rest of the
    // backend still boots without it — the vault lifecycle, sign-in and the
    // dashboard are all independent of the facilitator — but every call to
    // `/verify` and `/settle` will refuse until it is set, reporting
    // `facilitator-key-unusable` rather than attempting an unauthenticated
    // request. `/supported` refuses the same way, even though the hosted
    // facilitator happens to answer it without a credential: this proxy has one
    // rule for talking to Celo rather than one rule per endpoint, and a server
    // with no facilitator credential cannot settle anything regardless.
    //
    // It is never sent to a client and never logged.
    CELO_FACILITATOR_API_KEY: str({ default: '' }),
    // Facilitator endpoints. Optional: `src/config/chains.ts` falls back to the
    // hosted Celo facilitator for each network, which is what a normal
    // deployment wants. Set these to point at your own facilitator.
    CELO_FACILITATOR_URL: str({ default: '' }),
    CELO_SEPOLIA_FACILITATOR_URL: str({ default: '' }),
  });
}

export default validateEnv;
