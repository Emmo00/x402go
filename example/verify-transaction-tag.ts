import { verifyTx } from "@gigahierz/builder-codes";
import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";

const hash = "0x08dccbf0e80d88f2e449194d203487047459d8c23ebfeafedd7c2b824b65a998"; // Replace with the actual transaction hash you want to verify
const client = createPublicClient({ chain: celo, transport: http() });

const result = await verifyTx({ client, hash });

console.log(result);