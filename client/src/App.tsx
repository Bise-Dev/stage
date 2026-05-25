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

  const onRepoOpened = useCallback(() => setView('workspace'), []);

  const onLogout = useCallback(() => {
    setUser(null);
    setView('signIn');
  }, []);

  if (view === 'signIn') return <SignIn onAuthenticated={onAuthenticated} />;
  if (view === 'openRepo') return <OpenRepository onOpened={onRepoOpened} />;
  if (!user) return null;
  return <WorkspaceScaffold user={user} onLogout={onLogout} />;
}
