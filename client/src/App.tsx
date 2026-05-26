import { useCallback, useState } from 'react';

import { OpenRepository } from './screens/onboarding/OpenRepository';
import { SignIn } from './screens/onboarding/SignIn';
import { WorkspaceScaffold } from './screens/workspace/WorkspaceScaffold';
import type { User } from './tauri';

type View = 'signIn' | 'openRepo' | 'workspace';

export function App() {
  const [view, setView] = useState<View>('signIn');
  const [user, setUser] = useState<User | null>(null);

  const onAuthenticated = useCallback((u: User) => {
    setUser(u);
    setView('openRepo');
  }, []);

  const onRepoOpened = useCallback(() => {
    setView('workspace');
  }, []);

  if (view === 'signIn') return <SignIn onAuthenticated={onAuthenticated} />;
  if (view === 'openRepo') return <OpenRepository onOpened={onRepoOpened} />;
  if (!user) {
    // Defensive: should be unreachable, but biome wants explicit null guard.
    return null;
  }
  return <WorkspaceScaffold />;
}
