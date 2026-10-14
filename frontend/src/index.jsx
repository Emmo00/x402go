import React from 'react';
import ReactDOM from 'react-dom/client';
import { RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { WagmiProvider } from 'wagmi';

import '@rainbow-me/rainbowkit/styles.css';
import './index.css';

import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { AppErrorBoundary } from './components/ErrorBoundary';
import { wagmiConfig } from './auth/wagmi';
import { x402RainbowKitTheme } from './theme/rainbowkitTheme';
import reportWebVitals from './reportWebVitals';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <BrowserRouter>
      {/* Inside the router, so the current location can clear a caught error
          when the user navigates away from the screen that broke. */}
      <AppErrorBoundary>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <RainbowKitProvider theme={x402RainbowKitTheme} modalSize="compact">
              <AuthProvider>
                <App />
              </AuthProvider>
            </RainbowKitProvider>
          </QueryClientProvider>
        </WagmiProvider>
      </AppErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>,
);

reportWebVitals();
