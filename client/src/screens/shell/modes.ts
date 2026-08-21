/**
 * The review shell's mode registry (v6-light L5, design `V6_MODES`; trimmed in
 * L7 §3b M1: the Debrief is no longer a mode — it renders *inside* Self-Review
 * as the rail plus inline chapter banners).
 *
 * Self-Review — and later Review (full v6 step 7) — are the same interface:
 * one shell, one layout, with the mode config carrying everything that
 * differs (accent, who authored the walkthrough, what the timeline is
 * called, what the primary action does). Adding a mode is a new entry here
 * plus a body component in `ReviewShell`'s registry — no restructuring.
 */
export type ShellMode = 'selfreview';

export type ShellModeConfig = {
  key: ShellMode;
  /** Header chip text. */
  label: string;
  /** Header chip icon (see `components/Icon`). */
  icon: import('../../components/Icon').IconName;
  /** Accent color tokens, per the design's `V6_MODES`. */
  accent: string;
  press: string;
  tint: string;
  tintBd: string;
  /** What the left rail is called in this mode. */
  timelineLabel: string;
};

/** The prop contract every mode body accepts — the registry (`ReviewShell`'s
 *  `MODE_BODIES`) mounts bodies interchangeably, so they share one shape and
 *  ignore what they don't use. A future `review` mode adds fields here. */
export type ShellModeBodyProps = {
  shell: import('./useShellBootstrap').ShellBootstrap;
  debriefState: import('../selfReview/useSelfReviewDebrief').UseSelfReviewDebrief;
  onExit: () => void;
};

export const SHELL_MODES: Record<ShellMode, ShellModeConfig> = {
  selfreview: {
    key: 'selfreview',
    label: 'Self-review',
    icon: 'eye',
    accent: 'var(--blue)',
    press: 'var(--blue-press)',
    tint: 'var(--blue-tint)',
    tintBd: 'rgba(0,122,255,0.22)',
    timelineLabel: 'Changed files',
  },
};
