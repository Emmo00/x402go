import { Link, NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Button, cx } from '../components/ui/primitives';
import { DASHBOARD_ROUTES } from '../routes';
import WalletButton from './WalletButton';

/**
 * Shell for every authenticated screen: a hairline sidebar, the section nav,
 * and the wallet control. Page content renders through the outlet.
 */

const NAV_ITEMS = [
  { to: DASHBOARD_ROUTES.overview, label: 'Overview' },
  { to: DASHBOARD_ROUTES.apiKeys, label: 'API keys' },
  { to: DASHBOARD_ROUTES.settings, label: 'Settings' },
];

export default function DashboardLayout() {
  const { signOut } = useAuth();

  return (
    <div className="dash">
      <aside className="dash__sidebar">
        <div className="dash__brand">
          <Link className="logo" to="/" aria-label="x402Go home">
            x402G<span className="logo__accent">o</span>
          </Link>
        </div>

        <nav className="dash__nav" aria-label="Dashboard sections">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cx('dash__nav-link', isActive && 'dash__nav-link--active')
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="dash__account">
          <p className="dash__account-label">Wallet</p>
          <WalletButton className="dash__wallet" />
          <Button variant="link" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </aside>

      <main className="dash__main">
        <Outlet />
      </main>
    </div>
  );
}
