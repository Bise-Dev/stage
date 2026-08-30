import { GitDialog } from '../../components/GitDialog';
import type { PushPlan } from '../../generated/PushPlan';
import type { PushPlanOutcome } from '../../generated/PushPlanOutcome';

/**
 * The "Push branch…" dialog — every state `push_plan` can return, in one place.
 *
 * The engine decides *whether* a push is possible; this decides only how to say
 * so. Keeping the three states together is the point: they are one gesture's
 * three answers, and splitting them across the overview is how the copy for
 * "nothing to push" and "diverged" drifts out of step with the confirm.
 *
 * Only the `plan` state carries a confirm button. "Nothing to push" and
 * "diverged" are reports: there is no command to authorise, and for a
 * divergence the resolution (rebase, merge, or a force-push) is the author's
 * to make in their terminal — Stage never force-pushes (ADR-0029).
 */
export function PushDialog({
  outcome,
  branch,
  onConfirm,
  onClose,
}: {
  outcome: PushPlanOutcome;
  /** The branch the menu was raised on — the plan echoes it, but the report
   *  states are keyed to it too, so it is passed once for all three. */
  branch: string;
  /** Runs the confirmed push. A rejection renders verbatim in the dialog's own
   *  banner and the dialog stays open (fail loud, CLAUDE.md). */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  switch (outcome.kind) {
    case 'plan':
      return <PushConfirm plan={outcome.plan} onConfirm={onConfirm} onClose={onClose} />;

    case 'nothingToPush':
      return (
        <GitDialog
          tone="info"
          icon="push"
          title={
            <>
              Nothing to push on <span className="mono">{branch}</span>
            </>
          }
          body={
            outcome.behind > 0 ? (
              <>
                <span className="mono">{outcome.upstream}</span> already has every commit on this
                branch, and is{' '}
                <span style={{ color: 'var(--orange)', fontWeight: 600 }}>
                  {outcome.behind} commit{outcome.behind === 1 ? '' : 's'} ahead
                </span>{' '}
                of it. Fetch to bring those down.
              </>
            ) : (
              <>
                <span className="mono">{outcome.upstream}</span> is already up to date with this
                branch.
              </>
            )
          }
          onClose={onClose}
        />
      );

    case 'diverged':
      return (
        <GitDialog
          tone="blocked"
          icon="push"
          title={
            <>
              Diverged from <span className="mono">{outcome.upstream}</span>
            </>
          }
          body={
            <>
              <span className="mono">{branch}</span> has <Count n={outcome.ahead} /> the remote
              doesn't, and the remote has <Count n={outcome.behind} /> this branch doesn't — git
              would reject a plain push. Stage never force-pushes, so rebase or merge the remote
              work in yourself, then push.
            </>
          }
          onClose={onClose}
        />
      );
  }
}

/** The confirmation: what the push will do, what it leaves behind, and the
 *  exact command (ADR-0027). */
function PushConfirm({
  plan,
  onConfirm,
  onClose,
}: {
  plan: PushPlan;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const isNewRemoteBranch = plan.upstream === null;
  const dirty = plan.uncommittedCount ?? 0;

  return (
    <GitDialog
      icon="push"
      title={
        <>
          Push <span className="mono">{plan.branch}</span> to{' '}
          <span className="mono">{plan.remote}</span>?
        </>
      }
      body={
        <>
          {isNewRemoteBranch ? (
            <>
              <span className="mono">{plan.remote}</span> has never seen this branch — the push
              creates it there and sets it as the branch's upstream.
            </>
          ) : (
            <>
              This puts{' '}
              <span style={{ color: 'var(--green-d)', fontWeight: 600 }}>
                <Count n={plan.ahead ?? 0} />
              </span>{' '}
              onto <span className="mono">{plan.upstream}</span>.
            </>
          )}{' '}
          {dirty > 0 && (
            <>
              Your{' '}
              <span style={{ color: 'var(--orange)', fontWeight: 600 }}>
                {dirty} uncommitted {dirty === 1 ? 'file' : 'files'}
              </span>{' '}
              stay local — a push sends commits, and nothing here is committed.
            </>
          )}
        </>
      }
      // The directory is worth naming: for a branch living in a linked worktree
      // this is *not* the worktree the app is focused on, and the author should
      // see the command they'd have typed themselves, in the place they'd have
      // typed it (ADR-0029).
      details={[{ label: 'Runs in', value: plan.runIn }]}
      steps={plan.steps}
      confirmLabel="Push branch"
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

/** `1 commit` / `3 commits` — the count appears four times across the states. */
function Count({ n }: { n: number }) {
  return (
    <>
      {n} commit{n === 1 ? '' : 's'}
    </>
  );
}
