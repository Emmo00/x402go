import { NextFunction, Request, Response } from "express";

class IndexController {
  public index = (req: Request, res: Response, next: NextFunction) => {
    try {
      return res.send({ message: "Hello World" });
    } catch (error) {
      next(error);
    }
  };
}

export default IndexController;
