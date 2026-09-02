import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ActivityLogRoot } from './activityLog/ActivityLogRoot';
import { ErrorBoundary } from './activityLog/ErrorBoundary';
import { installConsoleForwarding } from './activityLog/console';
import './styles.css';

// Mirror webview console output into the Rust Activity-log ring. Must run
// before render so early logs are captured. Installed in release builds too —
// the drawer (⌘`) is a shipped diagnostic, and a console row nobody opens the
// drawer to read costs one bounded ring slot.
installConsoleForwarding();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ActivityLogRoot>
        <App />
      </ActivityLogRoot>
    </ErrorBoundary>
  </React.StrictMode>,
);
