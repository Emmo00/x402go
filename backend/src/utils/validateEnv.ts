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
  });
}

export default validateEnv;
