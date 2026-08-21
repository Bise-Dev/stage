import { useEffect, useRef } from 'react';
import { TitleBar } from '../../components/TitleBar';
import { useSelfReviewDebrief } from '../selfReview/useSelfReviewDebrief';
import { SelfReviewMode } from './SelfReviewMode';
import { SHELL_MODES, type ShellMode, type ShellModeBodyProps } from './modes';
import { useShellBootstrap } from './useShellBootstrap';

/**
 * The unified review shell (v6-light L5; trimmed in L7 §3b M1): Self-Review is
 * the one review surface, with the agent's Debrief rendered inside it (rail +
 * inline chapter banners) rather than as a separate mode. The full-v6 Review
 * mode (step 7) slots in as a second registry entry + body — no restructuring.
 *
 * The shell owns what every mode shares: the repo/base bootstrap and the
 * Debrief + Review-notes state.
 */
const MODE_BODIES: Record<ShellMode, (props: ShellModeBodyProps) => React.ReactNode> = {
  selfreview: SelfReviewMode,
};

export function ReviewShell({
  onExit,
  seedBaseFromDebrief = false,
}: {
  onExit: () => void;
  /** The `stage open` path (ADR-0014): seed the base from the Debrief's
   *  stored base, overriding the per-repo persisted default. */
  seedBaseFromDebrief?: boolean;
}) {
  const mode: ShellMode = 'selfreview';

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
        <Body shell={shell} debriefState={debriefState} onExit={onExit} />
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
