import { useCallback, useEffect, useState } from 'react';

import { OpenRepository } from './screens/onboarding/OpenRepository';
import { SignIn } from './screens/onboarding/SignIn';
import { SelfReview } from './screens/selfReview/SelfReview';
import { Storyline, type StorylineCtx } from './screens/storyline/Storyline';
import { Workspaces } from './screens/workspaces/Workspaces';
import { type User, authBootstrap, authLogout } from './tauri';

type View = 'signIn' | 'openRepo' | 'workspaces' | 'selfReview' | 'storyline';

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

  // Boot: validate any persisted session token. A valid token skips SignIn;
  // anything else (no token / dead session) lands on SignIn, which offers the
  // "Stay offline" path into local-only mode.
  useEffect(() => {
    authBootstrap()
      .then((u) => {
        if (u) {
          setUser(u);
          setView('openRepo');
        }
      })
      .catch((e) => {
        // A connectivity failure at boot is the network axis, explicitly out of
        // scope for local-only (the auth axis). Surface it for visibility and
        // fall back to SignIn; the token stays on disk (only a 401 clears it,
        // on the Rust side), so a later launch can still validate it.
        console.warn('auth_bootstrap_failed', e);
      })
      .finally(() => setBooting(false));
  }, []);

  const onAuthenticated = useCallback((u: User) => {
    setUser(u);
    setLocalOnly(false);
    setView('openRepo');
  }, []);

  // "Stay offline" from SignIn → local-only mode, home is the repo picker.
  const enterLocalOnly = useCallback(() => {
    setLocalOnly(true);
    setView('openRepo');
  }, []);

  const onRepoOpened = useCallback(() => {
    setHasRepo(true);
    // Signed-in home is Workspaces; local-only routes straight to Self-Review
    // (Workspaces requires a session).
    setView(localOnly ? 'selfReview' : 'workspaces');
  }, [localOnly]);

  const changeRepo = useCallback(() => setView('openRepo'), []);
  const startSelfReview = useCallback(() => setView('selfReview'), []);
  // Exit Self-Review: signed-in → Workspaces; local-only → repo picker (its home).
  const exitSelfReview = useCallback(
    () => setView(localOnly ? 'openRepo' : 'workspaces'),
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
        onBack={hasRepo ? () => setView(localOnly ? 'selfReview' : 'workspaces') : undefined}
      />
    );
  }
  if (view === 'selfReview') {
    return <SelfReview onExit={exitSelfReview} />;
  }
  if (!user) {
    // Defensive: should be unreachable (storyline/workspaces are signed-in
    // only; local-only never routes here), but biome wants the null guard.
    return null;
  }
  if (view === 'storyline' && storylineCtx) {
    return <Storyline ctx={storylineCtx} onBack={backToWorkspaces} />;
  }
  return (
    <Workspaces
      user={user}
      onChangeRepo={changeRepo}
      onStartSelfReview={startSelfReview}
      onOpenStoryline={openStoryline}
      onSignOut={signOut}
    />
  );
}
