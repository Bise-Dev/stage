/**
 * The review shell's mode registry (v6-light L5, design `V6_MODES`).
 *
 * Debrief, Self-Review — and later Review (full v6 step 7) — are the same
 * interface: one shell, one timeline-and-diff layout, with the mode config
 * carrying everything that differs (accent, who authored the walkthrough,
 * what the timeline is called, what the primary action does). Adding a mode
 * is a new entry here plus a body component in `ReviewShell`'s registry —
 * no restructuring.
 */
export type ShellMode = 'selfreview' | 'debrief';

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
  /** The mode's primary action label + icon (v6-light variants). */
  primary: { label: string; icon: import('../../components/Icon').IconName };
};

/** The prop contract every mode body accepts — the registry (`ReviewShell`'s
 *  `MODE_BODIES`) mounts bodies interchangeably, so they share one shape and
 *  ignore what they don't use. A future `review` mode adds fields here. */
export type ShellModeBodyProps = {
  shell: import('./useShellBootstrap').ShellBootstrap;
  debriefState: import('../selfReview/useSelfReviewDebrief').UseSelfReviewDebrief;
  onExit: () => void;
  /** Enter the storyline composer ("Ready to share", flag F5). */
  onEnterStoryline: () => void;
  /** Swap the shell into Self-Review mode (Debrief's primary). */
  onStartSelfReview: () => void;
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
    primary: { label: 'Mark reviewed', icon: 'check' },
  },
  debrief: {
    key: 'debrief',
    label: 'Debrief',
    icon: 'sparkle',
    accent: 'var(--purple)',
    press: '#7b2cab',
    tint: 'rgba(175,82,222,0.10)',
    tintBd: 'rgba(175,82,222,0.24)',
    timelineLabel: 'Storyline',
    primary: { label: 'Start self-review', icon: 'eye' },
  },
};
