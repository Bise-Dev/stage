import { useEffect, useRef, useState } from 'react';

/**
 * Fixed-width comment composer (Q10-I). ⌘-Enter saves; Esc cancels.
 * Rendered inline below the diff line, as a file-level band, or below a
 * comment thread (reply mode) — same component in all three cases.
 */
export function Composer({
  placeholder,
  initialBody,
  label,
  onSave,
  onCancel,
  autoFocus,
}: {
  placeholder?: string;
  initialBody?: string;
  /** Small header above the textarea — e.g. `L8` or `L8–L19`. Optional. */
  label?: string;
  onSave: (body: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState(initialBody ?? '');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSave(body);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r-md)',
        padding: 8,
        boxShadow: 'var(--sh-1)',
        margin: '6px 0',
      }}
    >
      {label && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            fontWeight: 600,
            color: 'var(--blue-press)',
            letterSpacing: 0.04,
            marginBottom: 4,
            paddingBottom: 4,
            borderBottom: '1px solid var(--hairline-2)',
          }}
        >
          {label}
        </div>
      )}
      <textarea
        ref={taRef}
        value={body}
        placeholder={placeholder ?? 'Leave a comment…'}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        style={{
          width: '100%',
          minHeight: 56,
          border: 'none',
          outline: 'none',
          resize: 'vertical',
          fontFamily: 'var(--font-ui)',
          fontSize: 12.5,
          color: 'var(--gray-800)',
          background: 'transparent',
        }}
      />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 4 }}>
        <button type="button" className="btn" onClick={onCancel} title="Esc">
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onSave(body)}
          disabled={body.trim().length === 0}
          style={{ opacity: body.trim().length === 0 ? 0.5 : 1 }}
          title="⌘-Enter"
        >
          Save
        </button>
      </div>
    </div>
  );
}
