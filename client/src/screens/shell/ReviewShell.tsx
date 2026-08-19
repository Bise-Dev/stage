import { useEffect, useRef, useState } from 'react';
import { TitleBar } from '../../components/TitleBar';
import { useSelfReviewDebrief } from '../selfReview/useSelfReviewDebrief';
import { DebriefMode } from './DebriefMode';
import { SelfReviewMode } from './SelfReviewMode';
import { SHELL_MODES, type ShellMode, type ShellModeBodyProps } from './modes';
import { useShellBootstrap } from './useShellBootstrap';

/**
 * The unified review shell (v6-light L5, design `V6_ReviewShell`): Debrief and
 * Self-Review are the same interface, differing only in the mode config
 * (`SHELL_MODES`) and the mode body mounted below the title bar. The full-v6
 * Review mode (step 7) slots in as a third registry entry + body — no
 * restructuring.
 *
 * The shell owns what every mode shares: the repo/base bootstrap, the Debrief
 * + Review-notes state, and the mode swap (Debrief's "Start self-review"
 * primary lands here).
 */
const MODE_BODIES: Record<ShellMode, (props: ShellModeBodyProps) => React.ReactNode> = {
  selfreview: SelfReviewMode,
  debrief: DebriefMode,
};

export function ReviewShell({
  initialMode,
  onExit,
  onEnterStoryline,
  seedBaseFromDebrief = false,
}: {
  initialMode: ShellMode;
  onExit: () => void;
  /** Enter the storyline composer after "Ready to share" creates the draft. */
  onEnterStoryline: () => void;
  /** The `stage open` path (ADR-0014): seed the base from the Debrief's
   *  stored base, overriding the per-repo persisted default. */
  seedBaseFromDebrief?: boolean;
}) {
  const [mode, setMode] = useState<ShellMode>(initialMode);
  // Re-entering the shell from navigation (e.g. table → View debrief while
  // already mounted on Self-Review) re-applies the requested mode.
  useEffect(() => setMode(initialMode), [initialMode]);

  const shell = useShellBootstrap();
  const debriefState = useSelfReviewDebrief(shell.repoPath);

  // `stage open` (ADR-0014): seed the base from the Debrief's stored base so
  // the author sees the same Base-scope diff the agent narrated. Applied once,
  // when the Debrief first loads; non-persisting.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seedBaseFromDebrief && debriefState.debrief && !seededRef.current) {
      seededRef.current = true;
      shell.seedBaseRef(debriefState.debrief.base);
    }
  }, [seedBaseFromDebrief, debriefState.debrief, shell.seedBaseRef]);

  const cfg = SHELL_MODES[mode];
  const Body = MODE_BODIES[mode];

  return (
    <div className="stage">
      <div className="win">
        <TitleBar title={`Stage — ${cfg.label}`} />
        {shell.error && <div style={errorBanner}>{shell.error}</div>}
        <Body
          shell={shell}
          debriefState={debriefState}
          onExit={onExit}
          onEnterStoryline={onEnterStoryline}
          onStartSelfReview={() => setMode('selfreview')}
        />
      </div>
    </div>
  );
}

const errorBanner: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--red-d)',
  background: 'rgba(255,59,48,0.08)',
  border: '1px solid rgba(255,59,48,0.20)',
  borderRadius: 'var(--r-sm)',
  padding: '6px 10px',
  margin: '8px 16px 0',
};
