import { DiffModeEnum, DiffView } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { useMemo } from 'react';

import { Avatar } from '../../components/Avatar';
import { Markdown } from '../../components/Markdown';
import type { SelfReviewFileChange } from '../../tauri';
import { inferDiffLanguage } from '../selfReview/markdown';

/**
 * The reviewer-facing preview of one storyline step (design screen 3b, right
 * pane): the author's intro rendered as the blue "Your note" card, above the
 * file's actual diff — exactly what a reviewer walking the storyline will see.
 *
 * `file` is the matching {@link SelfReviewFileChange} (patch text + counts) or
 * null when the diff hasn't loaded / the path isn't in the computed diff. We
 * never fabricate a diff: a missing patch shows an explicit notice (fail-loud,
 * per CLAUDE.md) rather than a blank or stale render.
 */
export function DiffPreview({
  introText,
  file,
  loading,
  error,
  discussion,
}: {
  introText: string;
  file: SelfReviewFileChange | null;
  loading: boolean;
  error: string | null;
  /** Stage-native intro discussion for this step, rendered between the intro
   *  card and the diff (mirrors the reviewer view's placement). Optional so the
   *  preview stays usable without it. */
  discussion?: React.ReactNode;
}) {
  const data = useMemo(() => {
    if (!file || !file.patch) return null;
    const lang = inferDiffLanguage(file.path);
    return {
      oldFile: { fileName: file.oldPath ?? file.path, fileLang: lang },
      newFile: { fileName: file.path, fileLang: lang },
      hunks: [file.patch],
    };
  }, [file]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
      {/* Preview header */}
      <div
        style={{
          padding: '8px 16px',
          borderBottom: '1px solid var(--hairline)',
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flex: '0 0 auto',
        }}
      >
        <span style={{ fontSize: 11.5, color: 'var(--gray-600)', fontWeight: 500 }}>
          Preview · what reviewers will see for this step
        </span>
        <div style={{ flex: 1 }} />
        {file && (
          <span className="badge badge-green">
            +{file.additions} −{file.deletions}
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto', background: '#fff', minHeight: 0 }}>
        {/* Intro card — how the note shows up above the diff */}
        <div style={{ padding: 14 }}>
          <div
            style={{
              display: 'flex',
              gap: 10,
              padding: '10px 12px',
              background: 'rgba(0,122,255,0.06)',
              border: '1px solid rgba(0,122,255,0.18)',
              borderRadius: 'var(--r-md)',
            }}
          >
            <Avatar name="You" size="sm" />
            <div
              style={{ fontSize: 12.5, color: 'var(--gray-800)', lineHeight: 1.45, minWidth: 0 }}
            >
              {introText.trim() ? (
                <>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>Your note</div>
                  <Markdown>{introText}</Markdown>
                </>
              ) : (
                <span>
                  <span style={{ fontWeight: 600 }}>Your note:</span>{' '}
                  <span style={{ color: 'var(--gray-400)', fontStyle: 'italic' }}>
                    No intro yet — reviewers will see this step without a note.
                  </span>
                </span>
              )}
            </div>
          </div>
          {discussion && <div style={{ marginTop: 12 }}>{discussion}</div>}
        </div>

        {/* Diff body */}
        <div style={{ borderTop: '1px solid var(--hairline)' }}>
          {loading && (
            <div style={{ padding: '24px 16px', fontSize: 12, color: 'var(--gray-500)' }}>
              Loading diff…
            </div>
          )}
          {!loading && error && (
            <div style={{ padding: '24px 16px', fontSize: 12, color: 'var(--red-d)' }}>
              Couldn't load the diff preview: {error}
            </div>
          )}
          {!loading && !error && !data && (
            <div style={{ padding: '24px 16px', fontSize: 12, color: 'var(--gray-500)' }}>
              {file?.isBinary
                ? 'Binary file — no textual diff to preview.'
                : 'No diff available to preview for this file.'}
            </div>
          )}
          {!loading && !error && data && (
            <DiffView
              data={data}
              diffViewMode={DiffModeEnum.Unified}
              diffViewHighlight
              diffViewWrap
              diffViewFontSize={12}
              diffViewTheme="light"
            />
          )}
        </div>
      </div>
    </div>
  );
}
