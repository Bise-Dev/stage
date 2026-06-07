import { type ReactNode, createContext, useContext } from 'react';

import type { User } from '../tauri';

export type AuthContextValue = {
  /** The signed-in Stage user, or null in local-only / pre-decision states. */
  user: User | null;
  /**
   * True when the author chose "Stay offline" (ADR-0013): no session, local
   * features only. Note the pre-decision boot state has BOTH `user === null`
   * and `localOnly === false` — that is the SignIn screen, where the chip
   * self-hides (see AuthStatus).
   */
  localOnly: boolean;
  /**
   * Promote local-only to signed-in IN PLACE (no navigation, ADR-0017). The
   * boot SignIn screen does NOT use this — it keeps its own `onAuthenticated`,
   * which also advances to the repo picker. The chip is hidden on the SignIn
   * screen, so this only ever fires from a local-capable screen and must not
   * navigate.
   */
  markAuthenticated: (user: User) => void;
  /** Revoke the session and drop to local-only in place (ADR-0017). */
  signOut: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  value,
  children,
}: {
  value: AuthContextValue;
  children: ReactNode;
}) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Read the auth context. Throws if used outside `<AuthProvider>` — a wiring
 * bug, surfaced loud rather than silently returning a default (CLAUDE.md
 * fail-loud).
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within <AuthProvider>');
  }
  return ctx;
}
