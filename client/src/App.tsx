import { useCallback, useEffect, useRef, useState } from 'react';

import { OpenRepository } from './screens/onboarding/OpenRepository';
import { Overview } from './screens/overview/Overview';
import { Settings } from './screens/settings/Settings';
import { ReviewShell } from './screens/shell/ReviewShell';
// import { LocalReview } from './screens/review/LocalReview';
// import { Storyline } from './screens/storyline/Storyline';
import {
  type OpenIntent,
  onOpenIntent,
  onOpenSettings,
  setActiveRepo,
  takeOpenIntent,
} from './tauri';

// The single-mode, no-backend app (ADR-0022): there is no Stage account, session,
// or sign-in (§5) — identity is the local `gh` user, resolved lazily where needed.
// A repo is opened onto ONE home screen — the branch-table Overview (v6-light
// L4) — from which the author works locally in the review shell (Self-Review,
// with the agent's Debrief folded in — v6-light L7).
//
// COMMENTED OUT: this version of Stage supports local Self-Review + the agent's
// Debrief only. Everything downstream of "Ready to share" — the Review artifact,
// storyline composition, Publish, and reviewer entry — works in stage-core but
// isn't good enough to show yet, so its routes are commented out rather than
// deleted. Uncomment `localStoryline` / `localReview` here and in Overview to
// bring it back.
type View = 'openRepo' | 'overview' | 'shell' | 'settings';

export function App() {
  // `booting` covers draining this launch's `stage open` intent before we pick a
  // first screen, so a deep-link lands directly instead of flashing the picker.
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<View>('openRepo');
  const [hasRepo, setHasRepo] = useState(false);
  // True when Self-Review was reached via `stage open`: seed its base from the
  // Debrief's base, overriding the per-repo localStorage default (ADR-0014).
  const [seedBase, setSeedBase] = useState(false);
  // The view to return to when Settings is dismissed. Settings is reachable from
  // any screen (native ⌘, menu item, or the RepoMenu), so we stash where it was
  // opened from rather than assume a fixed home.
  const [returnView, setReturnView] = useState<View>('overview');
  const viewRef = useRef(view);
  viewRef.current = view;

  // Set the active repo and route the `stage open` intent (ADR-0014). Every
  // intent lands in Self-Review now: the CLI refuses a PR target, so the
  // `Review` mode branch (commented out below) can't be reached.
  // Fail-loud (CLAUDE.md): a bad repo path surfaces and falls back to the picker.
  const routeToIntent = useCallback(async (intent: OpenIntent) => {
    try {
      await setActiveRepo(intent.repo);
      setHasRepo(true);
      // if (intent.mode === 'review' && intent.pr) {
      //   setLocalReviewPr(intent.pr);
      //   setView('localReview');
      //   return;
      // }
      setSeedBase(true);
      setView('shell');
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
  // The table's "View agent debrief" action lands here too — one surface (M1);
  // the Debrief shows as the rail + inline chapter banners.
  const startSelfReview = useCallback(() => {
    setSeedBase(false);
    setView('shell');
  }, []);
  const exitShell = useCallback(() => setView('overview'), []);

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
  if (view === 'shell') {
    return <ReviewShell onExit={exitShell} seedBaseFromDebrief={seedBase} />;
  }
  // The reviewer + storyline routes, commented out with the rest of the review
  // surface (see the note at the top of this file):
  //
  // if (view === 'localReview' && localReviewPr) {
  //   return <LocalReview pr={localReviewPr} onBack={backFromLocalReview} />;
  // }
  // if (view === 'localStoryline') {
  //   return <Storyline onBack={exitLocalStoryline} />;
  // }
  return (
    <Overview
      onChangeRepo={changeRepo}
      onStartSelfReview={startSelfReview}
      onOpenSettings={openSettings}
    />
  );
}
