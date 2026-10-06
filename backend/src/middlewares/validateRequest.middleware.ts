import { validationResult } from 'express-validator';
import { Request, Response, NextFunction } from 'express';

function validateRequest(validations: any[]) {
  validations.forEach((validation) => {
    if (typeof validation === 'function') {
      validation();
    }
  });

  return (req: Request, res: Response, next: NextFunction) => {
    const errors = validationResult(req);
    
    if (!errors.isEmpty()) {
      return res.status(422).json({
        message: 'The given data was invalid.',
        errors: errors.mapped(), // Or errors.array()
      });
    }
    next();
  };
}
