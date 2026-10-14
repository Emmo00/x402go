import { isAddressEqual, type Address } from "viem";
import type { Request } from "express";
import { getPayloadNetwork } from "@facilitator/schemes/utils";
import { VerifyRequestSchema, type PaymentPayload, type PaymentRequirements, type ErrorReasons } from "@facilitator/types/verify";
import { resolveChain, type ChainConfig } from "@facilitator/types/shared/evm";
import { getPublicClient, getSignerClient } from "@/utils/chainClient";
import type { VaultDeploymentContext } from "@facilitator/types/config";

export interface Ctx {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  chain: ChainConfig;
  client: ReturnType<typeof getSignerClient> | ReturnType<typeof getPublicClient>;
  deployment: VaultDeploymentContext;
  deployer?: Address;
}
export interface Rejection { status: number; reason: typeof ErrorReasons[number]; payer?: Address }

export async function buildContext(type: "verify" | "settle", req: Request, merchant: VaultDeploymentContext): Promise<Ctx | Rejection> {
  // /verify and /settle share a body shape, so one schema serves both
  const parsed = VerifyRequestSchema.safeParse(req.body);
  if (!parsed.success) return { status: 400, reason: "invalid_payload" };
  const { paymentPayload: payload, paymentRequirements: requirements } = parsed.data;

  const chain = resolveChain(getPayloadNetwork(payload));
  if (!chain) return { status: 200, reason: "invalid_network" };

  // If the route names a network, it must agree with the payload
  const routeNetwork = req.params.network as string;
  if (routeNetwork && resolveChain(routeNetwork) !== chain) return { status: 200, reason: "invalid_network" };

  // Use the signer client even for verify: simulation needs the facilitator account as sender
  const client = type == "settle" ? getSignerClient(chain.network) : getPublicClient(chain.network);

  return {
    payload, requirements, chain, client,
    deployment: merchant,
  };
}