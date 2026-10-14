import type { Request, Response, NextFunction } from 'express';
import { supported, verify, settle } from '@facilitator/facilitator';
import { OPERATOR_ADDRESS, getPublicClient, getSignerClient } from '@/utils/chainClient';
import { Network } from '@facilitator/types/shared';
import { CHAINS, EvmSigner } from '@facilitator/types/shared/evm';
import { buildContext } from '@/utils/context';
import { Address } from 'viem';

class FacilitatorController {
  async supported(req: Request, res: Response, next: NextFunction) {
    const { network } = req.params;

    const result = await supported(OPERATOR_ADDRESS!, network as string);

    if (!result) {
      return res.status(400).json({
        success: false,
        error: 'unknown_network',
        supported: CHAINS.map((c) => c.v1Network),
      });
    }

    return res.json(result);
  }

  async verify(req: Request, res: Response, next: NextFunction) {
    const merchant = req.user!;

    try {
      const merchantAddress = merchant.address as Address;
      const merchantPayout = merchant.payTo as Address;
      const ctx = await buildContext('verify', req, {
        merchant: merchantAddress,
        payout: merchantPayout,
      });

      if ('reason' in ctx) {
        return res
          .status(ctx.status)
          .json({ isValid: false, invalidReason: ctx.reason, payer: ctx.payer });
      }

      const result = await verify(ctx.client, ctx.payload, ctx.requirements, {
        deploymentContext: ctx.deployment,
        operatorAddress: OPERATOR_ADDRESS! as Address,
      });
      return res.json(result); // 200 whether valid or not: an invalid payment is a result, not an HTTP error
    } catch (err) {
      return res.status(500).json({ isValid: false, invalidReason: 'unexpected_verify_error' });
    }
  }

  async settle(req: Request, res: Response, next: NextFunction) {
    const merchant = req.user!;
    const merchantAddress = merchant.address as Address;
    const merchantPayout = merchant.payTo as Address;
    const fallbackNetwork = req.params.network ?? '';
    try {
      const ctx = await buildContext('settle', req, {
        merchant: merchantAddress,
        payout: merchantPayout,
      });
      if ('reason' in ctx) {
        return res.status(ctx.status).json({
          success: false,
          errorReason: ctx.reason,
          transaction: '',
          network: fallbackNetwork,
          payer: ctx.payer,
        });
      }

      const result = settle(ctx.client as EvmSigner, ctx.payload, ctx.requirements, {
        deploymentContext: ctx.deployment,
      });

      return res.json(result); // 200 for success and for protocol-level failures
    } catch (err) {
      return res.status(500).json({
        success: false,
        errorReason: 'unexpected_settle_error',
        transaction: '',
        network: fallbackNetwork,
      });
    }
  }
}

export default FacilitatorController;
