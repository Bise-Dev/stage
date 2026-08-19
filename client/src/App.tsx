import { useCallback, useEffect, useRef, useState } from 'react';

import { OpenRepository } from './screens/onboarding/OpenRepository';
import { Overview } from './screens/overview/Overview';
import { LocalReview } from './screens/review/LocalReview';
import { Settings } from './screens/settings/Settings';
import { ReviewShell } from './screens/shell/ReviewShell';
import type { ShellMode } from './screens/shell/modes';
import { Storyline } from './screens/storyline/Storyline';
import {
  type OpenIntent,
  type PrRef,
  onOpenIntent,
  onOpenSettings,
  setActiveRepo,
  takeOpenIntent,
} from './tauri';

// The single-mode, no-backend app (ADR-0022): there is no Stage account, session,
// or sign-in (§5) — identity is the local `gh` user, resolved lazily where needed.
// A repo is opened onto ONE home screen — the branch-table Overview (v6-light
// L4) — from which the author works locally in the review shell (Debrief /
// Self-Review modes, v6-light L5) and the Storyline → Publish flow, or reviews
// a PR read-only (LocalReview), all via `gh`/`git`.
type View = 'openRepo' | 'overview' | 'shell' | 'localStoryline' | 'localReview' | 'settings';

export function App() {
  // `booting` covers draining this launch's `stage open` intent before we pick a
  // first screen, so a deep-link lands directly instead of flashing the picker.
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<View>('openRepo');
  const [hasRepo, setHasRepo] = useState(false);
  // The PR opened for local-first read-only review via `stage open <pr-url>`
  // (ADR-0022 §6) or an overview row.
  const [localReviewPr, setLocalReviewPr] = useState<PrRef | null>(null);
  // True when Self-Review was reached via `stage open`: seed its base from the
  // Debrief's base, overriding the per-repo localStorage default (ADR-0014).
  const [seedBase, setSeedBase] = useState(false);
  // Which review-shell mode the navigation intent asked for (v6-light L5):
  // the table's Self-review action vs its View-agent-debrief action.
  const [shellMode, setShellMode] = useState<ShellMode>('selfreview');
  // The view to return to when Settings is dismissed. Settings is reachable from
  // any screen (native ⌘, menu item, or the RepoMenu), so we stash where it was
  // opened from rather than assume a fixed home.
  const [returnView, setReturnView] = useState<View>('overview');
  const viewRef = useRef(view);
  viewRef.current = view;

  // Set the active repo and route per the `stage open` intent's mode (ADR-0014,
  // ADR-0022 §6): `Review` opens the carried PR read-only; otherwise Self-Review.
  // Fail-loud (CLAUDE.md): a bad repo path surfaces and falls back to the picker.
  const routeToIntent = useCallback(async (intent: OpenIntent) => {
    try {
      await setActiveRepo(intent.repo);
      setHasRepo(true);
      if (intent.mode === 'review' && intent.pr) {
        setLocalReviewPr(intent.pr);
        setView('localReview');
      } else {
        setSeedBase(true);
        setShellMode('selfreview');
        setView('shell');
      }
    } catch (e) {
      console.warn('open_intent_set_repo_failed', e);
      setView('openRepo');
    }
  }, []);

  // Boot: drain any `stage open` intent for this (cold) launch and route to it;
  // a plain launch lands on the repo picker. No session to validate (§5).
  useEffect(() => {
    (async () => {
      let intent: OpenIntent | null = null;
      try {
        intent = await takeOpenIntent();
      } catch (e) {
        console.warn('take_open_intent_failed', e);
      }
      if (intent) {
        await routeToIntent(intent);
      } else {
        setView('openRepo');
      }
      setBooting(false);
    })();
  }, [routeToIntent]);

  // Warm start: a later `stage open` forwards its intent to this running app.
  useEffect(() => {
    const unlisten = onOpenIntent((intent) => {
      void routeToIntent(intent);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [routeToIntent]);

  const onRepoOpened = useCallback(() => {
    setHasRepo(true);
    setView('overview');
  }, []);

  const changeRepo = useCallback(() => setView('openRepo'), []);

  // Manual entry from the Overview: respect the author's persisted base (don't
  // seed from the Debrief — that's only for the `stage open` path, ADR-0014).
  const startSelfReview = useCallback(() => {
    setSeedBase(false);
    setShellMode('selfreview');
    setView('shell');
  }, []);
  // The table's "View agent debrief" action — same shell, debrief mode.
  const startDebrief = useCallback(() => {
    setSeedBase(false);
    setShellMode('debrief');
    setView('shell');
  }, []);
  const exitShell = useCallback(() => setView('overview'), []);

  const enterLocalStoryline = useCallback(() => setView('localStoryline'), []);
  const exitLocalStoryline = useCallback(() => setView('overview'), []);

  // Open a PR in the local-first reviewer (from an overview row, or `stage open`).
  const openLocalReview = useCallback((pr: PrRef) => {
    setLocalReviewPr(pr);
    setView('localReview');
  }, []);
  const backFromLocalReview = useCallback(
    () => setView(hasRepo ? 'overview' : 'openRepo'),
    [hasRepo],
  );

  // Open Settings, stashing the current screen to return to. No-op if already
  // there (so re-firing ⌘, doesn't lose the original return target).
  const openSettings = useCallback(() => {
    if (viewRef.current === 'settings') return;
    setReturnView(viewRef.current);
    setView('settings');
  }, []);
  const closeSettings = useCallback(() => setView(returnView), [returnView]);

  // The native app menu's "Settings…" item (⌘,) emits `open-settings`.
  useEffect(() => {
    const unlisten = onOpenSettings(() => openSettings());
    return () => {
      void unlisten.then((f) => f());
    };
  }, [openSettings]);

  if (booting) return null;

  if (view === 'settings') {
    return <Settings onClose={closeSettings} />;
  }
  if (view === 'openRepo') {
    // Offer Back only when a repo is already open (i.e. changing repos), not
    // during first-run onboarding where there's nothing to go back to.
    return (
      <OpenRepository
        onOpened={onRepoOpened}
        onBack={hasRepo ? () => setView('overview') : undefined}
      />
    );
  }
  if (view === 'localReview' && localReviewPr) {
    return <LocalReview pr={localReviewPr} onBack={backFromLocalReview} />;
  }
  if (view === 'shell') {
    return (
      <ReviewShell
        initialMode={shellMode}
        onExit={exitShell}
        onEnterStoryline={enterLocalStoryline}
        seedBaseFromDebrief={seedBase}
      />
    );
  }
  if (view === 'localStoryline') {
    return <Storyline onBack={exitLocalStoryline} />;
  }
  return (
    <Overview
      onChangeRepo={changeRepo}
      onStartSelfReview={startSelfReview}
      onViewDebrief={startDebrief}
      onOpenStoryline={enterLocalStoryline}
      onOpenReview={openLocalReview}
      onOpenSettings={openSettings}
    />
  );
}
