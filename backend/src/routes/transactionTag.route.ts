import { Router } from 'express';
import TransactionTagController from '../controllers/transactionTag.controller';
import requireAuth from '../middlewares/requireAuth.middleware';

class TransactionTagRoute implements IAppRoute {
  public path = '/transaction-tag';
  public router = Router();
  public transactionTagController = new TransactionTagController();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.get(`/`, requireAuth, (req, res, next) =>
      this.transactionTagController.getTransactionTag(req, res, next),
    );
    this.router.put(`/`, requireAuth, (req, res, next) =>
      this.transactionTagController.setTransactionTag(req, res, next),
    );
  }
}

export default TransactionTagRoute;
