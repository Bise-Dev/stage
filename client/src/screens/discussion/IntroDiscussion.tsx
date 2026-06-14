import { useCallback, useEffect, useMemo, useState } from 'react';

import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import {
  type IntroComment,
  introCommentCreate,
  introCommentDelete,
  introCommentResolve,
  introCommentUnresolve,
  introCommentUpdate,
  introCommentsList,
} from '../../tauri';
import { relativeTime } from '../../time';
import { Composer } from '../selfReview/Composer';

/** Purple is Stage's accent for IntroComments — deliberately *not* the gray
 *  "GitHub" badge of `GithubThread`, so a reader can tell narrative discussion
 *  (Stage-only, never written to GitHub) from code review (on GitHub) at a
 *  glance. See the glossary: IntroComment vs Comment.
 *
 *  The background is **opaque** (not a translucent tint): in the reviewer view
 *  this panel shares a scroll container with the diff below it, whose library
 *  renders `position: sticky` header/gutter layers — a translucent panel would
 *  let those green diff layers bleed through when scrolled. The opaque fill
 *  plus a `position: relative; zIndex` stacking context (on the root) keeps the
 *  panel visually self-contained. `#faf5fd` is the opaque equivalent of the old
 *  6%-purple tint over white. */
const STAGE_TINT = '#faf5fd';
const STAGE_BORDER = 'rgba(175, 82, 222, 0.28)';

function msgOf(e: unknown): string {
  return typeof e === 'object' && e !== null && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);
}

/** Count every comment in the thread (roots + nested replies) — the `(N)` on
 *  the disclosure reflects what's currently visible (the backend already
 *  applied the include-resolved filter). */
function countAll(comments: IntroComment[]): number {
  return comments.reduce((n, c) => n + 1 + c.replies.length, 0);
}

/**
 * Stage-native threaded discussion on one storyline step's **intro** (ADR-0001 —
 * IntroComments have no GitHub counterpart and never write through). Shown in
 * both the author composer and the reviewer viewer, keyed by the StorylineFile
 * UUID (`fileId`). Self-contained: fetches its own thread and re-pulls after
 * every write, so the rendered thread is always the server's truth (no
 * optimistic divergence). Write failures surface verbatim (fail loud, CLAUDE.md)
 * and keep the composer open so nothing typed is lost.
 *
 * Affordance gating mirrors the backend rules (which it also enforces): replies
 * nest one level only (depth ≤ 2); a comment's author may edit/delete it
 * (`currentUserId`); the workspace creator may resolve/unresolve roots
 * (`isCreator`); a frozen workspace disables every write (`canWrite`).
 */
export function IntroDiscussion({
  workspaceId,
  fileId,
  currentUserId,
  isCreator,
  canWrite,
}: {
  workspaceId: string;
  fileId: string;
  currentUserId: number;
  isCreator: boolean;
  canWrite: boolean;
}) {
  const [comments, setComments] = useState<IntroComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  // Last write failure (post / reply / edit / delete / resolve), surfaced
  // verbatim. Cleared on the next successful write.
  const [writeError, setWriteError] = useState<string | null>(null);
  const [composingRoot, setComposingRoot] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const thread = await introCommentsList(workspaceId, fileId, showResolved);
      setComments(thread);
    } catch (e) {
      // Fail loud (CLAUDE.md): surface the cause; no empty-state fallback that
      // would read as "no discussion yet".
      console.warn('intro_comments_load_failed', e);
      setLoadError(msgOf(e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, fileId, showResolved]);

  useEffect(() => {
    load();
  }, [load]);

  const count = useMemo(() => countAll(comments), [comments]);

  // Each write re-pulls the thread on success (canonical server state) and
  // surfaces failures verbatim, rethrowing so the inline composer stays open
  // with the text intact. The backend is the authority on every rule — these
  // wrappers don't pre-judge, they just report.
  const postRoot = useCallback(
    async (body: string) => {
      try {
        await introCommentCreate(workspaceId, fileId, body, null);
        setWriteError(null);
        await load();
      } catch (e) {
        console.warn('intro_comment_create_failed', e);
        setWriteError(msgOf(e));
        throw e;
      }
    },
    [workspaceId, fileId, load],
  );

  const postReply = useCallback(
    async (rootId: string, body: string) => {
      try {
        await introCommentCreate(workspaceId, fileId, body, rootId);
        setWriteError(null);
        await load();
      } catch (e) {
        console.warn('intro_comment_reply_failed', e);
        setWriteError(msgOf(e));
        throw e;
      }
    },
    [workspaceId, fileId, load],
  );

  const editComment = useCallback(
    async (commentId: string, body: string) => {
      try {
        await introCommentUpdate(commentId, body);
        setWriteError(null);
        await load();
      } catch (e) {
        console.warn('intro_comment_update_failed', e);
        setWriteError(msgOf(e));
        throw e;
      }
    },
    [load],
  );

  const deleteComment = useCallback(
    async (commentId: string) => {
      try {
        await introCommentDelete(commentId);
        setWriteError(null);
        await load();
      } catch (e) {
        console.warn('intro_comment_delete_failed', e);
        setWriteError(msgOf(e));
      }
    },
    [load],
  );

  const setResolved = useCallback(
    async (commentId: string, resolved: boolean) => {
      try {
        await (resolved ? introCommentResolve(commentId) : introCommentUnresolve(commentId));
        setWriteError(null);
        await load();
      } catch (e) {
        console.warn('intro_comment_resolve_failed', e);
        setWriteError(msgOf(e));
      }
    },
    [load],
  );

  return (
    <div
      style={{
        border: `1px solid ${STAGE_BORDER}`,
        borderRadius: 'var(--r-md)',
        background: STAGE_TINT,
        marginBottom: 12,
        overflow: 'hidden',
        // Own stacking context above the diff's sticky layers (which share the
        // reviewer view's scroll container), so they never paint over the panel.
        position: 'relative',
        zIndex: 1,
      }}
    >
      {/* Disclosure header — a "Stage" badge marks this as the native layer. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '8px 12px',
          border: 'none',
          background: 'transparent',
          cursor: 'default',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} color="var(--purple)" />
        <Icon name="comment-fill" size={11} color="var(--purple)" />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gray-800)' }}>
          Discussion{count > 0 ? ` · ${count}` : ''}
        </span>
        <span className="badge badge-purple" style={{ flex: '0 0 auto' }}>
          Stage
        </span>
        <div style={{ flex: 1 }} />
        {!open && count === 0 && (
          <span style={{ fontSize: 11.5, color: 'var(--gray-500)' }}>
            Discuss this step's intro — stays in Stage, never on GitHub.
          </span>
        )}
      </button>

      {open && (
        <div style={{ padding: '4px 12px 12px' }}>
          {/* Toolbar: include-resolved toggle */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 6,
            }}
          >
            <label
              style={{
                fontSize: 11.5,
                color: 'var(--gray-600)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                cursor: 'default',
              }}
            >
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(e) => setShowResolved(e.target.checked)}
              />
              Show resolved
            </label>
          </div>

          {writeError && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--red-d)',
                background: 'rgba(255,59,48,0.08)',
                border: '1px solid rgba(255,59,48,0.20)',
                borderRadius: 'var(--r-sm)',
                padding: '6px 10px',
                marginBottom: 6,
              }}
            >
              {writeError}
            </div>
          )}

          {loadError ? (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--red-d)',
                background: 'rgba(255,59,48,0.08)',
                border: '1px solid rgba(255,59,48,0.20)',
                borderRadius: 'var(--r-sm)',
                padding: '6px 10px',
              }}
            >
              Couldn't load the discussion: {loadError}
            </div>
          ) : loading ? (
            <div style={{ fontSize: 11.5, color: 'var(--gray-500)', padding: '4px 2px' }}>
              Loading discussion…
            </div>
          ) : comments.length === 0 ? (
            <div style={{ fontSize: 11.5, color: 'var(--gray-500)', padding: '2px 2px 6px' }}>
              No comments yet.
            </div>
          ) : (
            comments.map((c) => (
              <RootThread
                key={c.id}
                root={c}
                currentUserId={currentUserId}
                isCreator={isCreator}
                canWrite={canWrite}
                onReply={postReply}
                onEdit={editComment}
                onDelete={deleteComment}
                onSetResolved={setResolved}
              />
            ))
          )}

          {/* Root composer */}
          {canWrite &&
            (composingRoot ? (
              <Composer
                placeholder="Start a discussion about this step…"
                autoFocus
                onSave={(body) => {
                  const trimmed = body.trim();
                  if (!trimmed) {
                    setComposingRoot(false);
                    return;
                  }
                  return postRoot(trimmed)
                    .then(() => setComposingRoot(false))
                    .catch(() => {
                      // Error surfaced above; keep the composer open so the
                      // typed text isn't lost (fail loud, CLAUDE.md).
                    });
                }}
                onCancel={() => setComposingRoot(false)}
              />
            ) : (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setComposingRoot(true)}
                style={{ color: 'var(--purple)', padding: '0 4px', height: 24, marginTop: 2 }}
              >
                <Icon name="comment-fill" size={11} color="var(--purple)" /> Add comment
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** One root comment + its replies as a card. Resolve/unresolve sits on the root
 *  (creator only); replies nest one level (no reply affordance on a reply). */
function RootThread({
  root,
  currentUserId,
  isCreator,
  canWrite,
  onReply,
  onEdit,
  onDelete,
  onSetResolved,
}: {
  root: IntroComment;
  currentUserId: number;
  isCreator: boolean;
  canWrite: boolean;
  onReply: (rootId: string, body: string) => Promise<void>;
  onEdit: (commentId: string, body: string) => Promise<void>;
  onDelete: (commentId: string) => void;
  onSetResolved: (commentId: string, resolved: boolean) => void;
}) {
  const [replying, setReplying] = useState(false);
  const resolved = root.resolved_at !== null;

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-md)',
        padding: '8px 10px',
        boxShadow: 'var(--sh-1)',
        margin: '6px 0',
        opacity: resolved ? 0.7 : 1,
      }}
    >
      {resolved && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            color: 'var(--green-d)',
            marginBottom: 4,
            paddingBottom: 4,
            borderBottom: '1px solid var(--hairline-2)',
          }}
        >
          <Icon name="check" size={10} color="var(--green-d)" />
          Resolved{root.resolved_by ? ` by ${root.resolved_by.github_login}` : ''}
        </div>
      )}

      <CommentRow
        comment={root}
        currentUserId={currentUserId}
        canWrite={canWrite}
        onEdit={onEdit}
        onDelete={onDelete}
      />

      {root.replies.map((r) => (
        <div
          key={r.id}
          style={{ borderTop: '1px solid var(--hairline-2)', paddingLeft: 12, marginTop: 2 }}
        >
          <CommentRow
            comment={r}
            currentUserId={currentUserId}
            canWrite={canWrite}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      ))}

      {/* Root actions: reply (depth ≤ 2) + resolve toggle (creator). */}
      {canWrite && (
        <div style={{ borderTop: '1px solid var(--hairline-2)', marginTop: 2, paddingTop: 4 }}>
          {replying ? (
            <Composer
              placeholder="Reply…"
              autoFocus
              onSave={(body) => {
                const trimmed = body.trim();
                if (!trimmed) {
                  setReplying(false);
                  return;
                }
                return onReply(root.id, trimmed)
                  .then(() => setReplying(false))
                  .catch(() => {
                    // Surfaced in the discussion banner; keep composer open.
                  });
              }}
              onCancel={() => setReplying(false)}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setReplying(true)}
                style={{ color: 'var(--purple)', padding: '0 4px', height: 22 }}
              >
                <Icon name="comment-fill" size={10} color="var(--purple)" /> Reply
              </button>
              {isCreator && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => onSetResolved(root.id, !resolved)}
                  style={{ color: 'var(--gray-600)', padding: '0 4px', height: 22 }}
                >
                  <Icon name="check" size={10} color="var(--gray-600)" />{' '}
                  {resolved ? 'Unresolve' : 'Resolve'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One comment (root or reply): avatar + login + relative time, the body as
 *  Markdown, and — for the author, when writes are allowed — inline Edit/Delete.
 *  Edit swaps the body for a `Composer` seeded with the current text; Delete is
 *  a two-click confirm so a soft-delete isn't a single misclick. */
function CommentRow({
  comment,
  currentUserId,
  canWrite,
  onEdit,
  onDelete,
}: {
  comment: IntroComment;
  currentUserId: number;
  canWrite: boolean;
  onEdit: (commentId: string, body: string) => Promise<void>;
  onDelete: (commentId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const mine = comment.user.id === currentUserId;
  const login = comment.user.github_login;

  if (editing) {
    return (
      <div style={{ padding: '6px 0' }}>
        <Composer
          placeholder="Edit comment…"
          initialBody={comment.body}
          autoFocus
          onSave={(body) => {
            const trimmed = body.trim();
            if (!trimmed) {
              setEditing(false);
              return;
            }
            return onEdit(comment.id, trimmed)
              .then(() => setEditing(false))
              .catch(() => {
                // Surfaced in the discussion banner; keep the editor open.
              });
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8, padding: '6px 0' }}>
      <Avatar name={login} size="sm" />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            marginBottom: 1,
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--gray-700)' }}>{login}</span>
          <span style={{ color: 'var(--gray-400)' }}>{relativeTime(comment.created_at)}</span>
          <div style={{ flex: 1 }} />
          {mine && canWrite && !confirmingDelete && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setEditing(true)}
                style={{ color: 'var(--gray-500)', padding: '0 3px', height: 18, fontSize: 11 }}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmingDelete(true)}
                style={{ color: 'var(--gray-500)', padding: '0 3px', height: 18, fontSize: 11 }}
              >
                Delete
              </button>
            </>
          )}
          {mine && canWrite && confirmingDelete && (
            <>
              <span style={{ color: 'var(--gray-500)' }}>Delete?</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  onDelete(comment.id);
                  setConfirmingDelete(false);
                }}
                style={{ color: 'var(--red-d)', padding: '0 3px', height: 18, fontSize: 11 }}
              >
                Yes
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmingDelete(false)}
                style={{ color: 'var(--gray-500)', padding: '0 3px', height: 18, fontSize: 11 }}
              >
                No
              </button>
            </>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.45 }}>
          <Markdown>{comment.body}</Markdown>
        </div>
      </div>
    </div>
  );
}
