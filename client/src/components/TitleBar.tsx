import type { ReactNode } from 'react';

function TrafficLights() {
  return (
    <div className="tl">
      <span className="tl-dot tl-r" />
      <span className="tl-dot tl-y" />
      <span className="tl-dot tl-g" />
    </div>
  );
}

interface TitleBarProps {
  title: string;
  right?: ReactNode;
}

export function TitleBar({ title, right }: TitleBarProps) {
  return (
    <div className="win-titlebar" data-tauri-drag-region>
      <TrafficLights />
      <div className="win-title">{title}</div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
        {right}
      </div>
    </div>
  );
}
