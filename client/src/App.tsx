import { useCallback, useEffect, useState } from 'react';
import { isOnboarded, markOnboarded } from './lib/onboardingFlag';
import { OpenRepository } from './screens/onboarding/OpenRepository';
import { SignIn } from './screens/onboarding/SignIn';
import { WorkspaceScaffold } from './screens/workspace/WorkspaceScaffold';

type View = 'loading' | 'signIn' | 'openRepo' | 'workspace';

export function App() {
  const [view, setView] = useState<View>('loading');
  const [cameFromSignIn, setCameFromSignIn] = useState(false);

  useEffect(() => {
    (async () => {
      const onboarded = await isOnboarded();
      setView(onboarded ? 'openRepo' : 'signIn');
    })();
  }, []);

  const onSignInContinue = useCallback(async () => {
    await markOnboarded();
    setCameFromSignIn(true);
    setView('openRepo');
  }, []);

  const onRepoOpened = useCallback(() => {
    setView('workspace');
  }, []);

  const onBackToSignIn = useCallback(() => {
    setView('signIn');
    setCameFromSignIn(false);
  }, []);

  if (view === 'loading') return null;
  if (view === 'signIn') return <SignIn onContinue={onSignInContinue} />;
  if (view === 'openRepo') {
    return (
      <OpenRepository
        onOpened={onRepoOpened}
        onBack={cameFromSignIn ? onBackToSignIn : undefined}
      />
    );
  }
  return <WorkspaceScaffold />;
}
