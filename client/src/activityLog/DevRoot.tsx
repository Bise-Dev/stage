import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Group, Panel, type PanelSize, Separator } from 'react-resizable-panels';

import { ActivityLogDrawer } from './ActivityLogDrawer';
import { loadDrawerSizePct, saveDrawerSizePct } from './store';

/**
 * Hosts the dev-only Activity-log drawer beneath the app. The whole app lives in
 * the top panel; the drawer is a bottom panel mounted only while open, toggled
 * with ⌘` (macOS) / Ctrl+` (cross-platform). No visible affordance — it's a
 * developer shortcut (decision #5). In production this is a passthrough.
 */
export function DevRoot({ children }: { children: ReactNode }) {
  return import.meta.env.DEV ? <DevRootWithDrawer>{children}</DevRootWithDrawer> : <>{children}</>;
}

function DevRootWithDrawer({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [sizePct, setSizePct] = useState<number | null>(null);

  // Load the persisted drawer height once.
  useEffect(() => {
    loadDrawerSizePct().then(setSizePct);
  }, []);

  // ⌘` / Ctrl+` toggles the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onDrawerResize = useCallback((size: PanelSize) => {
    setSizePct(size.asPercentage);
    void saveDrawerSizePct(size.asPercentage).catch((e) =>
      console.warn('save drawer size failed', e),
    );
  }, []);

  // Defer the first paint until the persisted size resolves, so the drawer never
  // flashes at the default height before settling.
  if (sizePct == null) return <>{children}</>;

  // The app lives in the top panel and MUST stay mounted across drawer toggles:
  // never key/remount the Group, or the whole app subtree (`children`) remounts
  // and loses its state — it snaps back to the repo picker on every open/close.
  // The library re-normalizes the app panel to 100% when the drawer panel
  // unmounts, and the drawer restores the saved split via its `defaultSize`.
  return (
    <Group orientation="vertical" style={{ height: '100%' }}>
      <Panel id="app" minSize="20%">
        {children}
      </Panel>
      {open && (
        <>
          <Separator style={{ height: 3, background: 'var(--divider)', cursor: 'row-resize' }} />
          <Panel
            id="activity-log"
            defaultSize={`${sizePct}%`}
            minSize="10%"
            maxSize="80%"
            onResize={onDrawerResize}
          >
            <ActivityLogDrawer onClose={() => setOpen(false)} />
          </Panel>
        </>
      )}
    </Group>
  );
}
