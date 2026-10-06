import { body, query } from 'express-validator';

export const GetNonceRequest = [
  query('address').isString().trim().withMessage('Address must be a string'),
];

export const VerifySignatureRequest = [
  body('address').isString().withMessage('Address must be a string'),
  body('message').isString().withMessage('Message must be a string'),
  body('signature').isString().withMessage('Signature must be a string'),
];
