import express, {Router} from 'express';
import FacilitatorController from '../controllers/facilitator.controller';
import apiKeyAuth from '../middlewares/apiKeyAuth.middleware';

class FacilitatorRoute implements IAppRoute {
    public path = '/';
    public router = Router();
    public facilitatorController: FacilitatorController;

    constructor(facilitatorController: FacilitatorController = new FacilitatorController()) {
        this.facilitatorController = facilitatorController;
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.get(`/supported`, (req, res, next) => {
            this.facilitatorController.supported(req, res, next);
        });

        this.router.get(`/:network/supported`, (req, res, next) => {
            this.facilitatorController.supported(req, res, next);
        });

        this.router.post(`/:network/verify`,express.json({ limit: "100kb" }), apiKeyAuth, (req, res, next) => {
            this.facilitatorController.verify(req, res, next);
        });

        this.router.post(`/:network/settle`,express.json({ limit: "100kb" }), apiKeyAuth, (req, res, next) => {
            this.facilitatorController.settle(req, res, next);
        });
    }
}

export default FacilitatorRoute;