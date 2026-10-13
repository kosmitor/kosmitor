import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import { captureException } from './analytics.ts';
import { ToastProvider } from './ui.tsx';
import './index.css';

createRoot(document.getElementById('root')!, { onUncaughtError: captureException }).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
