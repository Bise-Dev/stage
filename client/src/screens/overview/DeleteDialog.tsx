import { GitDialog } from '../../components/GitDialog';
import type { DeletePlan } from '../../generated/DeletePlan';
import type { DeletePlanOutcome } from '../../generated/DeletePlanOutcome';

/**
 * The "Delete branch…" dialog — both states `delete_plan` can return.
 *
 * Deleting is the one action here that destroys something, so the confirmation
 * does more work than the others: it names what is being deleted (the tip's
 * summary, not just a SHA), says what the delete discards and against which
 * ref, and shows the SHA that puts the branch back. That SHA is shown for every
 * delete, not only the unmerged ones — it is the whole recovery story, and the
 * moment after the delete is exactly when it stops being easy to find.
 *
 * Stage deliberately writes no backup tag or branch first: an unasked-for ref
 * left behind is clutter the author then has to clean up, and git's reflog
 * already holds the commits.
 */
export function DeleteDialog({
  outcome,
  branch,
  onConfirm,
  onClose,
}: {
  outcome: DeletePlanOutcome;
  branch: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  if (outcome.kind === 'checkedOut') {
    return (
      // Report only. git forbids deleting a checked-out branch, and Stage never
      // removes a worktree to make one possible (ADR-0016) — so the remedy is
      // named, not offered as a button.
      <GitDialog
        tone="blocked"
        icon="folder"
        title={
          <>
            Checked out — <span className="mono">{branch}</span>
          </>
        }
        body={
          outcome.isCurrent ? (
            <>
              This branch is checked out in the worktree Stage is focused on, so git won't delete
              it. Switch that worktree to another branch first.
            </>
          ) : (
            <>
              This branch is checked out in another worktree, so git won't delete it. Switch that
              worktree to another branch, or remove the worktree yourself — Stage never removes
              worktrees.
            </>
          )
        }
        details={[{ label: 'Worktree', value: outcome.worktreePath }]}
        onClose={onClose}
      />
    );
  }

  return <DeleteConfirm plan={outcome.plan} onConfirm={onConfirm} onClose={onClose} />;
}

function DeleteConfirm({
  plan,
  onConfirm,
  onClose,
}: {
  plan: DeletePlan;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const unmerged = plan.unmergedCount;
  // No upstream and no default branch: nothing local can vouch for the commits,
  // so the count is not a fact about them. Say that, rather than print a number
  // that looks like one.
  const unverified = plan.mergedInto === null;

  const details = [
    { label: 'Recover with', value: `git branch ${plan.branch} ${plan.tipSha}` },
    ...(plan.tipSummary ? [{ label: 'Last commit', value: plan.tipSummary }] : []),
  ];

  return (
    <GitDialog
      // `blocked` orange rather than `error` red: this is a legitimate action
      // the author asked for, not a failure — but it earns the warning colour
      // over the neutral `action` blue the switch and push use.
      tone={unmerged > 0 ? 'blocked' : 'action'}
      icon="trash"
      title={
        <>
          Delete <span className="mono">{plan.branch}</span>?
        </>
      }
      body={
        <>
          {unverified ? (
            <>
              This branch has no upstream and the repo has no default branch, so{' '}
              <span style={{ color: 'var(--orange)', fontWeight: 600 }}>
                nothing local can vouch for its commits
              </span>
              .
            </>
          ) : unmerged > 0 ? (
            <>
              <span style={{ color: 'var(--orange)', fontWeight: 600 }}>
                {unmerged} commit{unmerged === 1 ? '' : 's'}
              </span>{' '}
              on this branch {unmerged === 1 ? 'is' : 'are'} not in{' '}
              <span className="mono">{plan.mergedInto}</span> and will stop being reachable by any
              branch.
            </>
          ) : (
            <>
              Every commit on this branch is already in{' '}
              <span className="mono">{plan.mergedInto}</span>, so nothing is lost.
            </>
          )}{' '}
          The local branch only — the remote branch, if there is one, is untouched. Your Self-Review
          notes and the agent's Debrief for this branch are kept.
        </>
      }
      details={details}
      steps={plan.steps}
      confirmLabel={unmerged > 0 ? 'Delete anyway' : 'Delete branch'}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
