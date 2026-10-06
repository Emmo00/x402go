import { Request, Response, NextFunction } from "express";
import HttpException from "../exceptions/HttpException";

// Express error handler middleware must have 4 arguments
function errorMiddleware(error: any, req: Request, res: Response, next: NextFunction) {
  let status = 500;
  let message = "Something went wrong";

  if (error instanceof HttpException) {
    status = error.status || 500;
    message = error.message || "Something went wrong";
  } else if (error && error.status && error.message) {
    status = error.status;
    message = error.message;
  }

  console.error("[ERROR]", status, message, error.stack || "");
  res.status(status).json({ message });
}

export default errorMiddleware;
