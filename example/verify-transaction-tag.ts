import { verifyTx } from "@gigahierz/builder-codes";
import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";

const hash = "0x054a8ce932b242362c237d77628f6b1dfb3398aaaa994a8184a644982ce4f023"; // Replace with the actual transaction hash you want to verify
const client = createPublicClient({ chain: celo, transport: http() });

const result = await verifyTx({ client, hash });

console.log(result);