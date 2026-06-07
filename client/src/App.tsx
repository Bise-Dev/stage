import { useCallback, useEffect, useState } from 'react';

import { OpenRepository } from './screens/onboarding/OpenRepository';
import { SignIn } from './screens/onboarding/SignIn';
import { RepoHome } from './screens/repo/RepoHome';
import { ReviewStoryline } from './screens/review/ReviewStoryline';
import { SelfReview } from './screens/selfReview/SelfReview';
import { Storyline, type StorylineCtx } from './screens/storyline/Storyline';
import { Workspaces } from './screens/workspaces/Workspaces';
import {
  type OpenIntent,
  type ReviewCtx,
  type User,
  authBootstrap,
  authLogout,
  onOpenIntent,
  setActiveRepo,
  takeOpenIntent,
} from './tauri';

type View =
  | 'signIn'
  | 'openRepo'
  | 'repoHome'
  | 'workspaces'
  | 'selfReview'
  | 'storyline'
  | 'review';

export function App() {
  // `booting` covers the async session validation at startup (ADR-0013). We
  // render nothing until it resolves so a returning, already-signed-in author
  // never sees a flash of the SignIn screen.
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<View>('signIn');
  const [user, setUser] = useState<User | null>(null);
  // Local-only mode (ADR-0013): the author chose "Stay offline", so the app
  // runs with no Stage session — repo picker + Self-Review only, backend
  // features disabled. Never persisted: it means "not signed in *yet*", is
  // re-evaluated every launch, and upgrades to signed-in the moment a sign-in
  // succeeds (any successful `onAuthenticated` clears it).
  const [localOnly, setLocalOnly] = useState(false);
  const [hasRepo, setHasRepo] = useState(false);
  const [storylineCtx, setStorylineCtx] = useState<StorylineCtx | null>(null);
  // The published workspace being reviewed read-only (Step 2 reviewer flow).
  const [reviewCtx, setReviewCtx] = useState<ReviewCtx | null>(null);
  // A `stage open` intent that arrived with no valid session (ADR-0013/0014):
  // we show SignIn first and retain it here so the author's auth choice — sign
  // in *or* "Stay offline" — then lands directly in Self-Review for the repo.
  const [pendingOpen, setPendingOpen] = useState<OpenIntent | null>(null);
  // True when Self-Review was reached via `stage open`: seed its base from the
  // Debrief's base, overriding the per-repo localStorage default (ADR-0014).
  const [seedBase, setSeedBase] = useState(false);

  // Set the active repo and route to Self-Review for a `stage open` intent.
  // Fail-loud (CLAUDE.md): a bad repo path surfaces and falls back to the repo
  // picker rather than wedging on a blank screen.
  const routeToIntent = useCallback(async (intent: OpenIntent) => {
    try {
      await setActiveRepo(intent.repo);
      setHasRepo(true);
      setSeedBase(true);
      setView('selfReview');
    } catch (e) {
      console.warn('open_intent_set_repo_failed', e);
      setView('openRepo');
    }
  }, []);

  // Boot: validate any persisted session token, and drain any `stage open`
  // intent for this (cold) launch. With a valid session an intent goes straight
  // to Self-Review; with no session we land on SignIn and retain the intent
  // (ADR-0013's boot table), honoring it after the auth choice. A plain launch
  // with a valid token skips SignIn to the repo picker.
  useEffect(() => {
    (async () => {
      let u: User | null = null;
      try {
        u = await authBootstrap();
      } catch (e) {
        // A connectivity failure at boot is the network axis, explicitly out of
        // scope for local-only (the auth axis). Surface it for visibility and
        // fall back to SignIn; the token stays on disk (only a 401 clears it,
        // on the Rust side), so a later launch can still validate it.
        console.warn('auth_bootstrap_failed', e);
      }
      let intent: OpenIntent | null = null;
      try {
        intent = await takeOpenIntent();
      } catch (e) {
        console.warn('take_open_intent_failed', e);
      }
      if (u) setUser(u);
      if (intent) {
        if (u) {
          await routeToIntent(intent);
        } else {
          // No session: SignIn is shown (its "Stay offline" path included); the
          // intent waits to be honored once the author picks.
          setPendingOpen(intent);
        }
      } else if (u) {
        setView('openRepo');
      }
      setBooting(false);
    })();
  }, [routeToIntent]);

  // Warm start: a later `stage open` forwards its intent to this running app.
  // If the author has already chosen (signed-in or local-only), focus+navigate
  // straight to Self-Review; if they're still on SignIn, retain it like a cold
  // no-session launch.
  useEffect(() => {
    const unlisten = onOpenIntent((intent) => {
      if (user || localOnly) {
        void routeToIntent(intent);
      } else {
        setPendingOpen(intent);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [user, localOnly, routeToIntent]);

  const onAuthenticated = useCallback(
    (u: User) => {
      setUser(u);
      setLocalOnly(false);
      if (pendingOpen) {
        const intent = pendingOpen;
        setPendingOpen(null);
        void routeToIntent(intent);
      } else {
        setView('openRepo');
      }
    },
    [pendingOpen, routeToIntent],
  );

  // "Stay offline" from SignIn → local-only mode. A retained `stage open` intent
  // routes straight to Self-Review; otherwise the home is the repo picker.
  const enterLocalOnly = useCallback(() => {
    setLocalOnly(true);
    if (pendingOpen) {
      const intent = pendingOpen;
      setPendingOpen(null);
      void routeToIntent(intent);
    } else {
      setView('openRepo');
    }
  }, [pendingOpen, routeToIntent]);

  const onRepoOpened = useCallback(() => {
    setHasRepo(true);
    // Signed-in home is Workspaces; local-only lands on the Repo-home branch
    // list (ADR-0016). `stage open` still deep-links straight to Self-Review.
    setView(localOnly ? 'repoHome' : 'workspaces');
  }, [localOnly]);

  const changeRepo = useCallback(() => setView('openRepo'), []);
  // Manual entry from Workspaces: respect the author's persisted base (don't
  // seed from the Debrief — that's only for the `stage open` path, ADR-0014).
  const startSelfReview = useCallback(() => {
    setSeedBase(false);
    setView('selfReview');
  }, []);
  // Exit Self-Review: signed-in → Workspaces; local-only → repo picker (its home).
  const exitSelfReview = useCallback(
    () => setView(localOnly ? 'repoHome' : 'workspaces'),
    [localOnly],
  );

  const openStoryline = useCallback((ctx: StorylineCtx) => {
    setStorylineCtx(ctx);
    setView('storyline');
  }, []);

  const backToWorkspaces = useCallback(() => {
    setStorylineCtx(null);
    setView('workspaces');
  }, []);

  const openReview = useCallback((ctx: ReviewCtx) => {
    setReviewCtx(ctx);
    setView('review');
  }, []);

  const backFromReview = useCallback(() => {
    setReviewCtx(null);
    setView('workspaces');
  }, []);

  // Sign out: `auth_logout` revokes the session server-side and clears the
  // persisted token (ADR-0013). It clears memory + disk even if the server call
  // fails, so the author is locally signed out regardless; route back to SignIn
  // either way and log a server-side failure for visibility.
  const signOut = useCallback(async () => {
    try {
      await authLogout();
    } catch (e) {
      console.warn('auth_logout_failed', e);
    }
    setUser(null);
    setHasRepo(false);
    setStorylineCtx(null);
    setReviewCtx(null);
    setView('signIn');
  }, []);

  if (booting) return null;
  if (view === 'signIn')
    return <SignIn onAuthenticated={onAuthenticated} onStayOffline={enterLocalOnly} />;
  if (view === 'openRepo') {
    // Offer Back only when a repo is already open (i.e. changing repos),
    // not during first-run onboarding where there's nothing to go back to.
    return (
      <OpenRepository
        onOpened={onRepoOpened}
        onBack={hasRepo ? () => setView(localOnly ? 'repoHome' : 'workspaces') : undefined}
      />
    );
  }
  if (view === 'repoHome') {
    return <RepoHome onEnterSelfReview={startSelfReview} onChangeRepo={changeRepo} />;
  }
  if (view === 'selfReview') {
    return <SelfReview onExit={exitSelfReview} seedBaseFromDebrief={seedBase} />;
  }
  if (!user) {
    // Defensive: should be unreachable (storyline/workspaces are signed-in
    // only; local-only never routes here), but biome wants the null guard.
    return null;
  }
  if (view === 'storyline' && storylineCtx) {
    return <Storyline ctx={storylineCtx} onBack={backToWorkspaces} />;
  }
  if (view === 'review' && reviewCtx) {
    return <ReviewStoryline ctx={reviewCtx} onBack={backFromReview} />;
  }
  return (
    <Workspaces
      user={user}
      onChangeRepo={changeRepo}
      onStartSelfReview={startSelfReview}
      onOpenStoryline={openStoryline}
      onOpenReview={openReview}
      onSignOut={signOut}
    />
  );
}
