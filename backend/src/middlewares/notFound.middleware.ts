import { Request, Response } from 'express';

function notFoundMiddleware(req: Request, res: Response) {
  res.status(404).json({
    message: 'Route not found',
    path: req.originalUrl,
  });
}

export default notFoundMiddleware;
