import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Render an author's storyline intro (markdown). GFM enabled (lists, tables,
 * strikethrough). Raw HTML is NOT rendered — react-markdown is safe by default.
 * SECURITY: do not add `rehype-raw` (or any raw-HTML pass) without a sanitizer
 * (e.g. `rehype-sanitize`). Once the reviewer view renders author-written intros,
 * raw HTML would be a stored-XSS vector. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
