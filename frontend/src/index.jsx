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
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider theme={x402RainbowKitTheme} modalSize="compact">
            <AuthProvider>
              <App />
            </AuthProvider>
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

reportWebVitals();
