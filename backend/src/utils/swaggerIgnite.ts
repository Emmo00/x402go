import swaggerUi from 'swagger-ui-express';
import swaggerJSDoc from 'swagger-jsdoc';
import { Application } from 'express';

function swaggerIgnite(applicationInstance: Application) {
  const { PORT } = process.env;
  // Swagger definition
  const swaggerDefinition = {
    info: {
      title: 'REST API for my App', // Title of the documentation
      version: '1.0.0', // Version of the app
      description: 'This is the REST API for my product', // short description of the app
    },
    host: "0.0.0.0:" + PORT, // the host or url of the app
    basePath: '/', // the basepath of your endpoint
    schemes: ['https', 'http'],
    // The two ways a caller can prove who it is. Declared once here rather than
    // per-operation so every path references the same schemes.
    securityDefinitions: {
      sessionCookie: {
        type: 'apiKey',
        in: 'header',
        name: 'Cookie',
        description:
          'SIWE session cookie (`connect.sid`) issued by `POST /auth/verify`. ' +
          'This is the browser credential: the wallet signs a nonce, the session ' +
          'is established, and it is sent automatically with every request.',
      },
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description:
          'API key issued by `POST /api-keys` or `POST /api-keys/rotate`, given as ' +
          '`Bearer x402go_...`. The key is shown exactly once, at the moment it is ' +
          'issued, and cannot be retrieved afterwards. `X-API-Key: x402go_...` is ' +
          'accepted as an equivalent header. This is the machine credential, for ' +
          'server-to-server calls.',
      },
    },
  };

  // options for the swagger docs
  const options = {
    // import swaggerDefinitions
    swaggerDefinition,
    // path to the API docs
    apis: ['./src/docs/**/*.yaml'],
  };
  // initialize swagger-jsdoc
  const swaggerSpec = swaggerJSDoc(options);

  // use swagger-Ui-express for your app documentation endpoint
  applicationInstance.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

export default swaggerIgnite;
