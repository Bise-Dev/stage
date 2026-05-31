import { useCallback, useState } from 'react';

import { OpenRepository } from './screens/onboarding/OpenRepository';
import { SignIn } from './screens/onboarding/SignIn';
import { SelfReview } from './screens/selfReview/SelfReview';
import { Workspaces } from './screens/workspaces/Workspaces';
import type { User } from './tauri';

type View = 'signIn' | 'openRepo' | 'workspaces' | 'selfReview';

export function App() {
  const [view, setView] = useState<View>('signIn');
  const [user, setUser] = useState<User | null>(null);
  const [hasRepo, setHasRepo] = useState(false);

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
  return <Workspaces user={user} onChangeRepo={changeRepo} onStartSelfReview={startSelfReview} />;
}
