import type { ReactNode } from 'react';

import { AuthStatus } from './AuthStatus';

interface TitleBarProps {
  title: string;
  right?: ReactNode;
}

// Traffic lights are the native macOS controls (titleBarStyle "Overlay"), not
// drawn here. The empty title bar is the window's drag region. `AuthStatus`
// (ADR-0017) renders on the far right of every screen; it self-hides on the
// boot SignIn screen.
export function TitleBar({ title, right }: TitleBarProps) {
  return (
    <div className="win-titlebar" data-tauri-drag-region>
      <div className="win-title">{title}</div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
        {right}
        <AuthStatus />
      </div>
    </div>
  );
}
