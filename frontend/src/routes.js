/**
 * Route table.
 *
 * The landing page's calls to action point at `API_KEY_ROUTE`. That resolves to
 * the dashboard's API-key screen — protected by the sign-in gate — which is the
 * real destination for "get your API key".
 */
export const API_KEY_ROUTE = '/signup';

export const DASHBOARD_ROUTES = {
  root: '/dashboard',
  overview: '/dashboard/overview',
  apiKeys: '/dashboard/api-keys',
  settings: '/dashboard/settings',
};
