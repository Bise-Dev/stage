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

export type DiffStats = { added: number; removed: number };
export const gitDiffStats = (baseRef: string, headRef: string) =>
  invoke<DiffStats>('git_diff_stats', { baseRef, headRef });

export const gitFetch = () => invoke<FetchOutcome>('git_fetch');

// --- Repo overview (Stage + GitHub aggregation; see docs/adr/0009) ---
export type WorkspaceState =
  | 'draft'
  | 'ready_to_publish'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'frozen';

export type OverviewWorkspaceRow = {
  kind: 'workspace';
  id: string;
  title: string;
  repo_owner: string;
  repo_name: string;
  head_ref: string;
  base_ref: string;
  pr_number: number | null;
  created_by: { id: number; github_login: string };
  last_active_at: string;
  storyline_count: number;
  state: WorkspaceState;
  added: number | null;
  removed: number | null;
  comment_count: number | null;
};

export type OverviewOpenPrRow = {
  kind: 'open_pr';
  number: number;
  title: string;
  html_url: string;
  repo_owner: string;
  repo_name: string;
  head_ref: string | null;
  author: { login: string | null; avatar_url: string | null };
  role: 'author' | 'reviewer';
  updated_at: string | null;
  added: number | null;
  removed: number | null;
};

export type OverviewRow = OverviewWorkspaceRow | OverviewOpenPrRow;

export const repoOverview = (owner: string, repo: string) =>
  invoke<OverviewRow[]>('repo_overview', { owner, repo });

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
