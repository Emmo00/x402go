import { NextFunction, Request, Response } from 'express';
import TransactionTagService, { ITransactionTagOutcome } from '../services/transactionTag.service';

function transactionTagBody(outcome: Extract<ITransactionTagOutcome, { status: 'ok' }>) {
  return { transactionTag: outcome.transactionTag };
}

class TransactionTagController {
  private transactionTagService = new TransactionTagService();

  async getTransactionTag(req: Request, res: Response, next: NextFunction) {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const outcome: ITransactionTagOutcome = await this.transactionTagService.getTransactionTag(
      String(user._id),
    );

    if (outcome.status === 'no-account') {
      return res.status(404).json({ message: 'Account not found' });
    }

    return res.status(200).json(transactionTagBody(outcome));
  }

  async setTransactionTag(req: Request, res: Response, next: NextFunction) {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const { transactionTag } = req.body ?? {};

    const outcome: ITransactionTagOutcome = await this.transactionTagService.setTransactionTag(
      String(user._id),
      (transactionTag as string).trim(),
    );

    if (outcome.status === 'no-account') {
      return res.status(404).json({ message: 'Account not found' });
    }

    return res.status(200).json(transactionTagBody(outcome));
  }
}

export default TransactionTagController;
