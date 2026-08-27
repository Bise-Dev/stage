/**
 * The opt-in switch for the Claude Code sessions pill (Settings → "Claude Code
 * sessions"). A plain per-machine view preference, so it lives in localStorage
 * like the table/graph home choice — default OFF: Stage reads another tool's
 * files for this, and only does so once the user asks it to.
 */
const KEY = 'settings:agent-sessions';

export function agentSessionsEnabled(): boolean {
  return localStorage.getItem(KEY) === '1';
}

export function setAgentSessionsEnabled(on: boolean): void {
  localStorage.setItem(KEY, on ? '1' : '0');
}
