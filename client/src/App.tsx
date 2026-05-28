import { useCallback, useState } from 'react';

import { OpenRepository } from './screens/onboarding/OpenRepository';
import { SignIn } from './screens/onboarding/SignIn';
import { Workspaces } from './screens/workspaces/Workspaces';
import type { User } from './tauri';

type View = 'signIn' | 'openRepo' | 'workspace';

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
    setView('workspace');
  }, []);

  const changeRepo = useCallback(() => setView('openRepo'), []);

  if (view === 'signIn') return <SignIn onAuthenticated={onAuthenticated} />;
  if (view === 'openRepo') {
    // Offer Back only when a repo is already open (i.e. changing repos),
    // not during first-run onboarding where there's nothing to go back to.
    return (
      <OpenRepository
        onOpened={onRepoOpened}
        onBack={hasRepo ? () => setView('workspace') : undefined}
      />
    );
  }
  if (!user) {
    // Defensive: should be unreachable, but biome wants explicit null guard.
    return null;
  }
  return <Workspaces user={user} onChangeRepo={changeRepo} />;
}
