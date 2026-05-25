import { invoke } from '@tauri-apps/api/core';

export type RepoInfo = { path: string };
export type RecentRepo = { path: string; lastOpenedAt: number };
export type RepoSummary = {
  defaultBranch: string | null;
  branchesCount: number;
  remoteUrl: string | null;
};

export const setActiveRepo = (path: string) => invoke<RepoInfo>('set_active_repo', { path });

export const getActiveRepo = () => invoke<RepoInfo | null>('get_active_repo');

export const listRecentRepos = () => invoke<RecentRepo[]>('list_recent_repos');

export const forgetRecentRepo = (path: string) => invoke<void>('forget_recent_repo', { path });

export const gitCurrentBranch = () => invoke<string>('git_current_branch');

export const repoSummary = (path: string) => invoke<RepoSummary>('repo_summary', { path });

export type DeviceCode = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
};

export type User = {
  id: number;
  github_login: string;
  github_user_id: number;
  display_name: string | null;
  avatar_url: string | null;
};

export type AuthPollResult =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'authorized'; user: User }
  | { kind: 'expired' }
  | { kind: 'denied' };

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

export const authDeviceStart = () => invoke<DeviceCode>('auth_device_start');

export const authDevicePoll = (deviceCode: string) =>
  invoke<AuthPollResult>('auth_device_poll', { deviceCode });

export const authMe = () => invoke<User>('auth_me');

export const authLogout = () => invoke<void>('auth_logout');

export const githubPrs = (role: 'author' | 'reviewer') =>
  invoke<GithubPrSearchItem[]>('github_prs', { role });
