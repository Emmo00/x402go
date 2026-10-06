import { Navigate, Route, Routes } from 'react-router';

import './App.css';
import './dashboard/dashboard.css';

import Benefits from './components/Benefits';
import FinalCta from './components/FinalCta';
import Hero from './components/Hero';
import SiteFooter from './components/SiteFooter';
import SiteHeader from './components/SiteHeader';

import ApiKeys from './dashboard/ApiKeys';
import AuthGate from './dashboard/AuthGate';
import DashboardLayout from './dashboard/DashboardLayout';
import OnboardingGate from './dashboard/OnboardingGate';
import Overview from './dashboard/Overview';
import Settings from './dashboard/Settings';
import { API_KEY_ROUTE, DASHBOARD_ROUTES } from './routes';

function Landing() {
  return (
    <div className="page">
      <SiteHeader />
      <main>
        <Hero />
        <Benefits />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />

      {/* The landing page's calls to action land on the API-key screen, which
          the sign-in gate protects. */}
      <Route
        path={API_KEY_ROUTE}
        element={<Navigate to={DASHBOARD_ROUTES.apiKeys} replace />}
      />

      {/* AuthGate wraps the layout, so an unauthenticated visitor never sees
          the dashboard chrome at all. OnboardingGate sits inside it and holds
          the dashboard back until the account has a payout wallet, which the
          backend requires before it will issue an API key. */}
      <Route
        path={DASHBOARD_ROUTES.root}
        element={
          <AuthGate>
            <OnboardingGate>
              <DashboardLayout />
            </OnboardingGate>
          </AuthGate>
        }
      >
        <Route index element={<Navigate to={DASHBOARD_ROUTES.overview} replace />} />
        <Route path="overview" element={<Overview />} />
        <Route path="api-keys" element={<ApiKeys />} />
        <Route path="settings" element={<Settings />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
