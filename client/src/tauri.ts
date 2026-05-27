import { invoke } from '@tauri-apps/api/core';

export type RepoInfo = { path: string };
export type RecentRepo = { path: string; lastOpenedAt: number };
export type RepoSummary = {
  defaultBranch: string | null;
  branchesCount: number;
  remoteUrl: string | null;
};
export type BranchInfo = {
  name: string;
  isHead: boolean;
  /** Last-commit time, epoch seconds (UTC). */
  updatedAt: number;
  lastCommit: string | null;
};
export type FetchOutcome = {
  remote: string;
};

export const setActiveRepo = (path: string) => invoke<RepoInfo>('set_active_repo', { path });

export const getActiveRepo = () => invoke<RepoInfo | null>('get_active_repo');

export const listRecentRepos = () => invoke<RecentRepo[]>('list_recent_repos');

export const forgetRecentRepo = (path: string) => invoke<void>('forget_recent_repo', { path });

export const gitCurrentBranch = () => invoke<string>('git_current_branch');

export const repoSummary = (path: string) => invoke<RepoSummary>('repo_summary', { path });

export const gitLocalBranches = () => invoke<BranchInfo[]>('git_local_branches');

export const gitFetch = () => invoke<FetchOutcome>('git_fetch');

export const openInFinder = (path: string) => invoke<void>('open_in_finder', { path });

// --- Auth types ---
export type User = {
  id: number;
  github_login: string;
  display_name: string;
  avatar_url: string;
};

// --- GitHub PR types ---
export type GithubUserRef = {
  login: string;
  avatar_url: string | null;
};

export type GithubPrSearchItem = {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  updated_at: string;
  user: GithubUserRef;
};

// --- Auth wrappers ---
export const authSignIn = () => invoke<User>('auth_sign_in');
export const authSignInCancel = () => invoke<void>('auth_sign_in_cancel');
export const authMe = () => invoke<User>('auth_me');
export const authLogout = () => invoke<void>('auth_logout');

// --- GitHub proxy ---
export const githubPrs = (role: 'author' | 'reviewer') =>
  invoke<GithubPrSearchItem[]>('github_prs', { role });
