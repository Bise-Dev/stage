import { useCallback, useState } from 'react';

import { OpenRepository } from './screens/onboarding/OpenRepository';
import { SignIn } from './screens/onboarding/SignIn';
import { SelfReview } from './screens/selfReview/SelfReview';
import { Storyline, type StorylineCtx } from './screens/storyline/Storyline';
import { Workspaces } from './screens/workspaces/Workspaces';
import type { User } from './tauri';

type View = 'signIn' | 'openRepo' | 'workspaces' | 'selfReview' | 'storyline';

export function App() {
  const [view, setView] = useState<View>('signIn');
  const [user, setUser] = useState<User | null>(null);
  const [hasRepo, setHasRepo] = useState(false);
  const [storylineCtx, setStorylineCtx] = useState<StorylineCtx | null>(null);

  const onAuthenticated = useCallback((u: User) => {
    setUser(u);
    setView('openRepo');
  }, []);

  const onRepoOpened = useCallback(() => {
    setHasRepo(true);
    setView('workspaces');
  }, []);

  const changeRepo = useCallback(() => setView('openRepo'), []);
  const startSelfReview = useCallback(() => setView('selfReview'), []);
  const exitSelfReview = useCallback(() => setView('workspaces'), []);

  const openStoryline = useCallback((ctx: StorylineCtx) => {
    setStorylineCtx(ctx);
    setView('storyline');
  }, []);

  const backToWorkspaces = useCallback(() => {
    setStorylineCtx(null);
    setView('workspaces');
  }, []);

  if (view === 'signIn') return <SignIn onAuthenticated={onAuthenticated} />;
  if (view === 'openRepo') {
    // Offer Back only when a repo is already open (i.e. changing repos),
    // not during first-run onboarding where there's nothing to go back to.
    return (
      <OpenRepository
        onOpened={onRepoOpened}
        onBack={hasRepo ? () => setView('workspaces') : undefined}
      />
    );
  }
  if (view === 'selfReview') {
    return <SelfReview onExit={exitSelfReview} />;
  }
  if (!user) {
    // Defensive: should be unreachable, but biome wants explicit null guard.
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
    />
  );
}
