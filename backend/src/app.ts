import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import hpp from 'hpp';
import mongoose from 'mongoose';
import logger from 'morgan';
import errorMiddleware from './middlewares/error.middleware';
import swaggerIgnite from './utils/swaggerIgnite';
import session from 'express-session';
import MongoStore from 'connect-mongo'

class App {
  public app: express.Application;
  public port: string | number;
  public env: boolean;

  constructor(routes: IAppRoute[]) {
    this.app = express();
    this.port = process.env.PORT || 3033;
    this.env = process.env.NODE_ENV === 'production' ? true : false;

    this.connectToDatabase();
    this.initializeMiddlewares();
    this.initSession();
    this.initSwaggerDocs();
    this.initializeRoutes(routes);
    this.initializeErrorHandling();
  }

  public listen() {
    this.app.listen(this.port, () => {
      console.log(`App listening on the port ${this.port}`);
    });
  }

  public getServer() {
    return this.app;
  }

  public initSession() {
    // `secure: 'auto'` relies on req.secure, which only sees the original
    // protocol once the proxy is trusted.
    this.app.set('trust proxy', 1);

    this.app.use(
      session({
        secret: process.env.SESSION_SECRET || 'default_secret',
        store: MongoStore.create({
          mongoUrl: process.env.MONGO_CONNECTION_URL as string,
          collectionName: 'sessions',
        }),
        resave: false,
        saveUninitialized: false,
        cookie: {
          httpOnly: true,
          sameSite: 'lax',
          secure: 'auto',
          maxAge: 3600000, // 1 hour — mirrored by SESSION_TTL_MS in the frontend
        },
      }),
    );
  }

  public initSwaggerDocs() {
    swaggerIgnite(this.app);
  }

  private initializeMiddlewares() {
    if (this.env) {
      this.app.use(hpp());
      this.app.use(helmet());
      this.app.use(logger('combined'));
      this.app.use(cors({ origin: 'your.domain.com', credentials: true }));
    } else {
      this.app.use(logger('dev'));
      this.app.use(cors({ origin: true, credentials: true }));
    }

    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(express.static('public')); // to serve static files from public folder
  }

  private initializeRoutes(routes: IAppRoute[]) {
    routes.forEach((route) => {
      this.app.use(route.path, route.router);
    });
  }

  private initializeErrorHandling() {
    this.app.use(errorMiddleware);
  }

  private connectToDatabase() {
    const { MONGO_CONNECTION_URL } = process.env;
    mongoose.set('strictQuery', false);
    mongoose.connect(MONGO_CONNECTION_URL as string);

    mongoose.connection.on('error', (error) => {
      console.error('MongoDB connection error:', error);
    });

    mongoose.connection.on('connected', () => {
      console.log('MongoDB connected successfully');
    });
  }
}

export default App;
