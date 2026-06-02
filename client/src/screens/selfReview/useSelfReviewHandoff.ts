import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';
import {
  type Handoff,
  type NoteAnchor,
  type ReviewNoteView,
  selfReviewHandoffGet,
  selfReviewNoteCreate,
  selfReviewNoteReopen,
  selfReviewNoteResolve,
  selfReviewNotesList,
} from '../../tauri';

export type UseSelfReviewHandoff = {
  /** The agent-authored Handoff, or null if none has been written. */
  handoff: Handoff | null;
  /** All Review notes for the active repo+branch, with computed `outdated`. */
  notes: ReviewNoteView[];
  loading: boolean;
  error: string | null;
  /** Create an `open` Review note anchored to a diff location. */
  createNote: (anchor: NoteAnchor, body: string) => Promise<void>;
  /** Author action: close a note (`resolved`). */
  resolveNote: (id: string) => Promise<void>;
  /** Author action: reopen a note (`open`). */
  reopenNote: (id: string) => Promise<void>;
};

function errMessage(e: unknown): string {
  return typeof e === 'object' && e !== null && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);
}

/**
 * Owns the local Handoff + Review notes for the active repo+branch — the
 * author side of the cycle-1 loop (ADR-0011). Reads the SQLite store the
 * `stage` CLI authors into, and writes Review notes back into it.
 *
 * Live-refreshes on two events:
 *  - `handoff-changed` — the store file changed (the agent ran `set`/`address`,
 *    or this app created/resolved a note);
 *  - `repo-changed`    — a working-tree edit, which can flip a note's
 *    `outdated` flag (its anchored file leaving/rejoining the Base diff).
 *
 * Per CLAUDE.md "Error handling": no silent fallbacks — a backend failure
 * surfaces in `error` for the screen to render in a banner; mutations re-throw
 * so callers can react, after recording the message.
 */
export function useSelfReviewHandoff(repoPath: string | null): UseSelfReviewHandoff {
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [notes, setNotes] = useState<ReviewNoteView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!repoPath) {
      setHandoff(null);
      setNotes([]);
      setLoading(false);
      return;
    }
    try {
      const [h, n] = await Promise.all([selfReviewHandoffGet(), selfReviewNotesList()]);
      setHandoff(h);
      setNotes(n);
      setError(null);
    } catch (e) {
      console.warn('self_review_handoff_load_failed', e);
      setError(errMessage(e));
      // Keep the previous handoff/notes visible — a transient git/store lock
      // shouldn't blank the rail mid-review.
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  useEffect(() => {
    const unlistenHandoff = listen('handoff-changed', () => {
      reload();
    });
    const unlistenRepo = listen('repo-changed', () => {
      reload();
    });
    return () => {
      unlistenHandoff.then((u) => u());
      unlistenRepo.then((u) => u());
    };
  }, [reload]);

  // Mutations optimistically re-fetch on success so the rail reflects the new
  // state immediately (the watcher event would also fire, but only after the
  // debounce window — refetching here keeps the UI snappy).
  const mutate = useCallback(
    async (op: () => Promise<unknown>, label: string) => {
      try {
        await op();
        await reload();
      } catch (e) {
        console.warn(label, e);
        setError(errMessage(e));
        throw e;
      }
    },
    [reload],
  );

  const createNote = useCallback(
    async (anchor: NoteAnchor, body: string) => {
      await mutate(() => selfReviewNoteCreate(anchor, body), 'self_review_note_create_failed');
    },
    [mutate],
  );
  const resolveNote = useCallback(
    async (id: string) => {
      await mutate(() => selfReviewNoteResolve(id), 'self_review_note_resolve_failed');
    },
    [mutate],
  );
  const reopenNote = useCallback(
    async (id: string) => {
      await mutate(() => selfReviewNoteReopen(id), 'self_review_note_reopen_failed');
    },
    [mutate],
  );

  return { handoff, notes, loading, error, createNote, resolveNote, reopenNote };
}
