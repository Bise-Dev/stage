import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { DevRoot } from './activityLog/DevRoot';
import { ErrorBoundary } from './activityLog/ErrorBoundary';
import { installConsoleForwarding } from './activityLog/console';
import './styles.css';

// Dev-only: mirror webview console output into the Rust Activity-log ring. Must
// run before render so early logs are captured. No-op in production.
if (import.meta.env.DEV) installConsoleForwarding();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <DevRoot>
        <App />
      </DevRoot>
    </ErrorBoundary>
  </React.StrictMode>,
);
