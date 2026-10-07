import 'dotenv/config';
import App from './app';
import IndexRoute from './routes/index.route';
import UsersRoute from './routes/users.route';
import AuthRoute from './routes/auth.route';
import AccountRoute from './routes/account.route';
import ApiKeysRoute from './routes/apiKeys.route';
import PayoutRoute from './routes/payout.route';
import validateEnv from './utils/validateEnv';

validateEnv();

const app = new App([
  new IndexRoute(),
  new UsersRoute(),
  new AuthRoute(),
  new AccountRoute(),
  new ApiKeysRoute(),
  new PayoutRoute(),
]);

app.listen();
