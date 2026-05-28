import type { ReactNode } from 'react';

interface TitleBarProps {
  title: string;
  right?: ReactNode;
}

// Traffic lights are the native macOS controls (titleBarStyle "Overlay"), not
// drawn here. The empty title bar is the window's drag region.
export function TitleBar({ title, right }: TitleBarProps) {
  return (
    <div className="win-titlebar" data-tauri-drag-region>
      <div className="win-title">{title}</div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
        {right}
      </div>
    </div>
  );
}
