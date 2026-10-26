import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/** Model-authored Markdown is content, never executable HTML or navigation. */
export const Markdown = memo(function Markdown({ text, className = '' }: { text?: string; className?: string }) {
  return <div className={`prose ${className}`}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
      skipHtml
      components={{
        a: ({ children }) => <span className="content-link">{children}</span>,
        img: ({ alt }) => alt ? <span className="quiet">[{alt}]</span> : null,
        pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
        h1: ({ children }) => <h3>{children}</h3>,
        h2: ({ children }) => <h3>{children}</h3>,
        input: ({ checked }) => <input type="checkbox" checked={checked} disabled aria-label={checked ? 'Complete' : 'Incomplete'} />,
      }}
    >{text || ''}</ReactMarkdown>
  </div>;
});
