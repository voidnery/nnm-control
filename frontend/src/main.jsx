import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth.jsx';
import { ThemeProvider } from './theme.jsx';
import { I18nProvider } from './i18n.jsx';
import { ToastProvider } from './toast.jsx';
import { ConfirmProvider } from './confirm.jsx';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <I18nProvider>
              <ConfirmProvider>
                <App />
              </ConfirmProvider>
            </I18nProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
